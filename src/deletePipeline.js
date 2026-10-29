/**
 * Delete pipeline — four ordered phases, journaled and resumable.
 *
 *   1. index   : append `forget` tombstones; the rebuildable index stops serving it
 *   2. archive : copy the record to cold storage (rollback window)
 *   3. consolidation: high-salience episodes are distilled into the semantic layer
 *                first — scenarios may die, patterns do not
 *   4. purge   : rewrite the log generation without the record, drop the cold copy
 *
 * Each phase is a separate journal write, so a crash between phases leaves a job
 * that `advanceAll()` resumes instead of a half-deleted memory. Phase work is
 * idempotent: re-running it re-appends tombstones (harmless) and never loses data.
 *
 * Boundaries are explicit:
 *   - delete  = this pipeline, ends with bytes gone
 *   - archive = phase 2 only (`mode: 'archive'`), bytes retained in cold storage
 *   - consolidate = phase 3, produces semantic summaries, deletes nothing
 *   - retrieval = read-only, never mutates
 */

import fs from 'node:fs';
import path from 'node:path';
import { MemoryError, ErrorCodes } from './errors.js';
import { controlIdFor } from './identity.js';
import { makeForget } from './log/records.js';
import { ensureDir, readJson, sha256, writeJsonAtomic } from './util.js';

export const PHASES = Object.freeze(['index', 'archive', 'consolidation', 'purge', 'done']);
export const JOB_STATUS = Object.freeze({
  RUNNING: 'running',
  PENDING_CONSOLIDATION: 'pending-consolidation',
  ARCHIVED: 'archived',
  DONE: 'done',
});

export class DeletePipeline {
  constructor({ logStore, semanticStore, journalDir, clock, tombstones, getPolicy }) {
    this.logStore = logStore;
    this.semanticStore = semanticStore;
    this.journalDir = journalDir;
    this.clock = clock;
    this.tombstones = tombstones;
    this.getPolicy = getPolicy;
    ensureDir(journalDir);
  }

  journalPath(id) {
    return path.join(this.journalDir, `delete-${id}.json`);
  }

  jobs() {
    return fs
      .readdirSync(this.journalDir)
      .filter((name) => /^delete-.+\.json$/.test(name))
      .map((name) => readJson(path.join(this.journalDir, name)))
      .filter(Boolean)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  readJob(id) {
    const job = readJson(this.journalPath(id));
    if (!job) throw new MemoryError(ErrorCodes.NOT_FOUND, `unknown delete job ${id}`, { id });
    return job;
  }

  /** Start a deletion. Validates every id before mutating anything. */
  async request({ eventIds, mode = 'purge', reason = 'unspecified' }) {
    if (!Array.isArray(eventIds) || eventIds.length === 0) {
      throw new MemoryError(ErrorCodes.INVALID_INPUT, 'eventIds must be a non-empty array');
    }
    if (mode !== 'purge' && mode !== 'archive') {
      throw new MemoryError(ErrorCodes.INVALID_INPUT, `mode must be "purge" or "archive", got ${mode}`);
    }
    const snapshot = await this.logStore.snapshot();
    const episodes = new Map(
      snapshot.records.filter((record) => record.type === 'episode').map((record) => [record.event_id, record]),
    );
    const missing = eventIds.filter((id) => !episodes.has(id));
    if (missing.length > 0) {
      throw new MemoryError(ErrorCodes.NOT_FOUND, 'cannot delete unknown event ids', { missing });
    }
    const now = this.clock.now();
    const targets = [...new Set(eventIds)].sort();
    // Deterministic job id: re-requesting the same targets in the same instant
    // resumes the same journal entry instead of minting a second one.
    const job = {
      v: 2,
      id: controlIdFor({
        type: 'dead_letter',
        contentHash: sha256(`${mode}|${reason}|${targets.join(',')}`),
        eventTime: now,
        occurrenceIndex: 0,
      }),
      mode,
      reason,
      eventIds: targets,
      phase: 'index',
      status: JOB_STATUS.RUNNING,
      createdAt: now,
      updatedAt: now,
      archiveFile: null,
      summaryIds: [],
      steps: [],
    };
    this.writeJob(job);
    return this.advance(job);
  }

  /** Resume every non-terminal job. Called by maintenance. */
  async advanceAll() {
    const resumed = [];
    for (const job of this.jobs()) {
      if (job.status !== JOB_STATUS.RUNNING && job.status !== JOB_STATUS.PENDING_CONSOLIDATION) continue;
      resumed.push(await this.advance(job));
    }
    return resumed;
  }

  /** Continue a journaled job from its recorded phase. */
  async advance(job) {
    const policy = this.getPolicy();
    while (job.phase !== 'done') {
      switch (job.phase) {
        case 'index':
          await this.phaseIndex(job);
          job.phase = 'archive';
          break;
        case 'archive':
          await this.phaseArchive(job, policy);
          if (job.mode === 'archive') {
            job.status = JOB_STATUS.ARCHIVED;
            job.phase = 'done';
          } else {
            job.phase = 'consolidation';
          }
          break;
        case 'consolidation': {
          const outcome = await this.phaseConsolidation(job, policy);
          if (outcome === 'pending') {
            job.status = JOB_STATUS.PENDING_CONSOLIDATION;
            job.updatedAt = this.clock.now();
            this.writeJob(job);
            return job;
          }
          job.phase = 'purge';
          break;
        }
        case 'purge':
          await this.phasePurge(job);
          job.status = JOB_STATUS.DONE;
          job.phase = 'done';
          break;
        default:
          throw new MemoryError(ErrorCodes.IO, `delete job ${job.id} has unknown phase ${job.phase}`);
      }
      job.updatedAt = this.clock.now();
      this.writeJob(job);
    }
    return job;
  }

  // ---- phases ------------------------------------------------------------

  /** Phase 1: index removal via tombstones. Never touches bytes. */
  async phaseIndex(job) {
    const snapshot = await this.logStore.snapshot();
    const records = job.eventIds.map((target, offset) =>
      makeForget({
        eventId: controlIdFor({
          type: 'forget',
          contentHash: sha256(`${target}|${job.mode}`),
          eventTime: this.clock.now(),
          occurrenceIndex: snapshot.records.length + offset,
        }),
        target,
        mode: job.mode,
        reason: job.reason,
        logTime: this.clock.now(),
      }),
    );
    await this.logStore.append(records);
    // The tombstone store is the hot-path deny list: written before the rebuild so
    // no window exists where a rebuild could resurrect the target.
    for (const target of job.eventIds) {
      this.tombstones.mark({ eventId: target, at: this.clock.now(), phase: 'index', jobId: job.id });
    }
    this.step(job, 'index', { forgotten: records.map((record) => record.event_id), tombstones: this.tombstones.size() });
  }

  /** Phase 2: cold copy, so a wrong delete is recoverable until purge. */
  async phaseArchive(job, policy) {
    if (!policy.delete.archiveBeforeDelete) {
      this.step(job, 'archive', { skipped: 'policy.delete.archiveBeforeDelete=false' });
      return;
    }
    const snapshot = await this.logStore.snapshot();
    const wanted = new Set(job.eventIds);
    const records = snapshot.records.filter(
      (record) => (record.type === 'episode' && wanted.has(record.event_id)) || (record.type === 'reinforce' && wanted.has(record.target)),
    );
    const file = await this.logStore.appendArchive(job.id, records);
    job.archiveFile = file;
    this.step(job, 'archive', { file, records: records.length });
  }

  /** Phase 3: consolidation gate. Distils patterns out of high-salience episodes. */
  async phaseConsolidation(job, policy) {
    const snapshot = await this.logStore.snapshot();
    const episodes = new Map(
      snapshot.records.filter((record) => record.type === 'episode').map((record) => [record.event_id, record]),
    );
    const pending = [];
    for (const eventId of job.eventIds) {
      const episode = episodes.get(eventId);
      if (!episode) continue;
      if ((episode.salience ?? 0) < policy.delete.consolidateSalience) continue;
      if (this.semanticStore.covers(eventId).length > 0) continue;
      pending.push(episode);
    }
    if (pending.length === 0) {
      this.step(job, 'consolidation', { distilled: 0 });
      return 'done';
    }
    const mode = policy.delete.consolidationMode;
    if (mode === 'off') {
      this.step(job, 'consolidation', { skipped: 'consolidationMode=off', pending: pending.map((e) => e.event_id) });
      return 'done';
    }
    if (mode === 'strict') {
      job.pendingConsolidation = pending.map((episode) => ({
        eventId: episode.event_id,
        salience: episode.salience,
        content: episode.content.slice(0, 200),
      }));
      this.step(job, 'consolidation', { waiting: job.pendingConsolidation.length });
      return 'pending';
    }
    const summarised = [];
    for (const episode of pending) {
      const summary = this.semanticStore.ensureForEvent({
        nextId: this.ids,
        clock: this.clock,
        event: episode,
        reason: `delete:${job.id}`,
      });
      job.summaryIds.push(summary.summaryId);
      summarised.push(summary.summaryId);
    }
    // Sanity: the gate is only passed when every high-salience episode is covered.
    const uncovered = pending.map((e) => e.event_id).filter((id) => this.semanticStore.covers(id).length === 0);
    if (uncovered.length > 0) {
      throw new MemoryError(ErrorCodes.CONSOLIDATION_REQUIRED, 'consolidation did not cover every target', { uncovered });
    }
    this.step(job, 'consolidation', { distilled: summarised.length, summaryIds: summarised });
    return 'done';
  }

  /** Phase 4: physical removal — new log generation without the records. */
  async phasePurge(job) {
    const drop = new Set(job.eventIds);
    const result = await this.logStore.rewrite({
      reason: `delete:${job.id}`,
      keep: (record) => {
        if (record.type === 'episode' && drop.has(record.event_id)) return false;
        if (record.type === 'reinforce' && drop.has(record.target)) return false;
        return true;
      },
    });
    if (job.archiveFile) fs.rmSync(job.archiveFile, { force: true });
    job.archiveFile = null;
    this.step(job, 'purge', { logGen: result.gen, dropped: result.dropped, coldCopyRemoved: true });
  }

  // ---- journal -----------------------------------------------------------

  step(job, phase, detail) {
    job.steps.push({ phase, at: this.clock.now(), ...detail });
  }

  writeJob(job) {
    writeJsonAtomic(this.journalPath(job.id), { ...job, updatedAt: this.clock.now() });
  }
}
