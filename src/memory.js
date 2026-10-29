/**
 * Memory facade — the seam between the DSH plugin adapter and the storage layers.
 *
 *   const memory = await Memory.open({ dataDir, clock: new FakeClock(t0), policy });
 *   await memory.remember({ content: '...', tags: ['topic'], eventTime: t0 });
 *   await memory.recall({ text: '...' });
 *
 * Identity discipline enforced here, in one place:
 *   - `remember` resolves content_hash -> event_time -> DEDUPE -> occurrence_index
 *     -> event_id (see log/ingest.js). A replay returns the existing event id and
 *     writes nothing; a genuine repeat at the same instant gets the next index.
 *   - control records (reinforce/forget/restore) derive their ids from
 *     (type, target, time, log position), so replaying the log reproduces them.
 *
 * Layering budget (what each layer may touch):
 *   log      truth source, append-only; rewritten only by compaction/purge
 *   index    derived, rebuildable, A/B double-buffered; never authoritative
 *   semantic separate truth stream; unaffected by episode deletion
 */

import fs from 'node:fs';
import path from 'node:path';
import { assertClock, SystemClock } from './clock.js';
import { DeletePipeline } from './deletePipeline.js';
import { MemoryError, ErrorCodes } from './errors.js';
import { buildAliasMap, hashPolicy, resolvePolicy } from './policy.js';
import { controlIdFor } from './identity.js';
import { makeForget, makeReinforce, makeRestore } from './log/records.js';
import { ingestEpisode } from './log/ingest.js';
import { LogStore } from './log/logStore.js';
import { DeadLetterQueue, IdentityLedger, TombstoneStore } from './log/identityLedger.js';
import { IndexStore } from './index/indexStore.js';
import { IndexManager } from './index/indexManager.js';
import { GraphCache, GRAPH_HARD_CAP, GRAPH_TOP_NEIGHBORS } from './graph.js';
import { foldRecords } from './index/buildIndex.js';
import { Maintenance } from './maintenance.js';
import { recall as runRecall } from './retrieval.js';
import { SemanticStore } from './semantic/semanticStore.js';
import { TempSemanticStore } from './semantic/tempSemantic.js';
import { ContextEngine } from './context/contextEngine.js';
import { nextRun, parseCron } from './cron.js';
import { ensureDir, dayKey, genNumber, sha256 } from './util.js';

/** Recursive byte size of a directory tree (symlinks count as their target size). */
function diskUsage(dir) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
      } catch {
        /* a file removed mid-walk simply does not count */
      }
    }
  };
  walk(dir);
  return total;
}

const SUBDIRS = Object.freeze({
  log: 'log',
  archive: 'archive',
  index: 'index',
  semantic: 'semantic',
  journal: 'journal',
  state: 'state',
  identity: 'identity',
});

export class Memory {
  /**
   * @param {object} options
   * @param {string} options.dataDir absolute directory owned by this plugin
   * @param {object} [options.clock] Clock with now(); never defaulted in tests
   * @param {object} [options.policy] partial policy overrides
   * @param {object} [options.config] { maxSegmentRecords, context }
   */
  constructor({ dataDir, clock = new SystemClock(), policy = {}, config = {} }) {
    if (!dataDir) throw new MemoryError(ErrorCodes.INVALID_CONFIG, 'dataDir is required');
    assertClock(clock);
    this.dataDir = path.resolve(dataDir);
    this.clock = clock;
    this.config = config;
    this.policy = resolvePolicy(policy);
    this.policyHash = hashPolicy(this.policy);

    this.paths = Object.fromEntries(
      Object.entries(SUBDIRS).map(([key, name]) => [key, path.join(this.dataDir, name)]),
    );

    this.logStore = new LogStore({
      root: this.paths.log,
      archiveRoot: this.paths.archive,
      maxSegmentRecords: config.maxSegmentRecords ?? this.policy.maintenance.maxSegmentRecords,
    });

    // ---- identity & tombstone ledgers (derived from the log at open) --------
    this.ledger = new IdentityLedger({ file: path.join(this.paths.identity, 'ledger.json') });
    this.tombstones = new TombstoneStore({ file: path.join(this.paths.log, 'tombstones.jsonl') });
    this.dlq = new DeadLetterQueue({ file: path.join(this.paths.log, 'dlq.jsonl'), clock: this.clock });

    // ---- derived read model ------------------------------------------------
    this.indexStore = new IndexStore({ root: this.paths.index });
    this.indexManager = new IndexManager({
      store: this.indexStore,
      logStore: this.logStore,
      getPolicy: () => this.policy,
      clock: this.clock,
      getTombstones: () => this.tombstones.ids(),
    });

    this.semanticStore = new SemanticStore({ root: this.paths.semantic });
    // Offline graph projection: rebuilt by maintain(), read as a slice by the API.
    this.graph = new GraphCache({ dataDir: this.dataDir, clock: this.clock });
    this.tempStore = new TempSemanticStore({
      root: this.paths.semantic,
      clock: this.clock,
      ids: null,
      semanticStore: this.semanticStore,
      getPolicy: () => this.policy,
    });
    this.context = new ContextEngine({
      clock: this.clock,
      getPolicy: () => this.policy,
      maxTokens: config.context?.maxTokens,
      threshold: config.context?.threshold,
      target: config.context?.target,
      statsFile: path.join(this.paths.state, 'context.json'),
    });
    this.deletePipeline = new DeletePipeline({
      logStore: this.logStore,
      semanticStore: this.semanticStore,
      journalDir: this.paths.journal,
      clock: this.clock,
      tombstones: this.tombstones,
      getPolicy: () => this.policy,
    });
    this.maintenance = new Maintenance({
      logStore: this.logStore,
      indexStore: this.indexStore,
      indexManager: this.indexManager,
      semanticStore: this.semanticStore,
      tempLayer: this.tempStore,
      deletePipeline: this.deletePipeline,
      clock: this.clock,
      getPolicy: () => this.policy,
      stateFile: path.join(this.paths.state, 'maintenance.json'),
    });

    this._semanticCache = null;
    this._briefing = null;
    this._boot = null;
    this._closed = false;
    this._writeChain = Promise.resolve();
    this.maintenance.onPublished = () => {
      this._semanticCache = null;
    };
  }

  static async open(options) {
    const memory = new Memory(options);
    await memory.init();
    return memory;
  }

  async init() {
    for (const dir of Object.values(this.paths)) ensureDir(dir);
    await this.logStore.ensure();

    const snapshot = await this.logStore.snapshot();
    // Identity and tombstones are DERIVED: rebuild from the log, never trust the
    // persisted hint alone (a crash between append and persist must not matter).
    this.ledger.loadHint();
    this.ledger.rebuild(snapshot.records);
    this.ledger.persist();
    this.tombstones.load();
    this.tombstones.mergeFolded(foldRecords(snapshot.records).tombstones);
    this.dlq.load();
    await this.tempStore.init();

    this._boot = await this.maintenance.bootCheck();
    this._bootBefore = this._boot;
    if (this._boot.status !== 'ok') {
      await this.indexManager.rebuild({ reason: `boot:${this._boot.status}` });
      this._boot = { ...this._boot, status: 'ok', reason: `rebuilt (${this._boot.reason ?? this._boot.status})` };
    }
    this.refreshBriefing();
    return this;
  }

  // ---- write path --------------------------------------------------------

  /**
   * Append an episode. Returns the immutable handle the caller keeps forever.
   *
   * Idempotent by default: a replayed payload at the same event_time returns the
   * existing event id and appends nothing. Pass `dedupe:false` to record a genuine
   * second occurrence — it then gets the next occurrence_index and a distinct id.
   */
  async remember({
    content,
    eventTime,
    happenedAt,
    tags = [],
    salience = 0.5,
    meta = null,
    entity = null,
    idempotencyKey = null,
    dedupe = true,
    isTransientTrend = false,
  }) {
    this.assertOpen();
    const payload = { content, tags, salience, meta, entity, event_time: eventTime ?? happenedAt };
    const plan = ingestEpisode({
      payload,
      clock: this.clock,
      policy: this.policy,
      ledger: this.ledger,
      dlq: this.dlq,
      dedupe,
      clientKey: idempotencyKey,
    });

    if (plan.status === 'duplicate') {
      return {
        status: 'duplicate',
        duplicate: true,
        eventId: plan.eventId,
        contentHash: plan.contentHash,
        eventTime: plan.eventTime,
        dedupeKey: plan.dedupeKey,
        note: 'payload already stored for this event_time; nothing was written',
      };
    }

    if (plan.status === 'dead-letter') {
      this.ledger.persist();
      return {
        status: 'dead-letter',
        deadLetter: true,
        dlqId: plan.dlqId,
        contentHash: plan.contentHash,
        eventTime: plan.eventTime,
        occurrenceIndex: plan.occurrenceIndex ?? 0,
        reason: plan.reason,
        note: 'invalid payload routed to the DLQ; it never overwrites a stored event',
      };
    }

    const record = plan.record;
    await this.logStore.append([record]);
    this.ledger.persist();
    await this.indexManager.applyRecords([record]);

    let trend = null;
    if (isTransientTrend) {
      trend = await this.tempStore.observe({
        content: record.content,
        sourceEvents: [record.event_id],
        tags: record.tags.map((tag) => tag.tag),
        occurredAt: record.event_time,
      });
    }
    this.refreshBriefing();
    return {
      status: 'appended',
      eventId: record.event_id,
      entityId: record.entity_id,
      contentHash: record.content_hash,
      occurrenceIndex: record.occurrence_index,
      eventTime: record.event_time,
      timeSource: record.time_source,
      timeUncertain: record.time_uncertain === true,
      logTime: record.log_time,
      salience: record.salience,
      tags: record.tags.map((tag) => tag.tag),
      day: dayKey(record.time_source === 'content' ? record.log_time : record.event_time),
      indexGeneration: this.indexManager.generation,
      indexed: true,
      trend: trend ? { tempId: trend.tempId, action: trend.action, hitCount: trend.entry?.hitCount ?? 0 } : null,
    };
  }

  /**
   * Build a deterministic control record. Control ids derive from the log position,
   * so replaying the same prefix reproduces the same ids.
   */
  async _controlRecord(kind, { target, eventTime, weight, mode, reason }) {
    const snapshot = await this.logStore.snapshot();
    const eventId = controlIdFor({
      type: kind,
      contentHash: sha256(`${kind}|${target}|${mode ?? ''}|${reason ?? ''}|${weight ?? ''}`),
      eventTime: eventTime ?? this.clock.now(),
      occurrenceIndex: snapshot.records.length,
    });
    const logTime = Math.trunc(this.clock.now());
    if (kind === 'reinforce') {
      return makeReinforce({ eventId, target, weight, eventTime, logTime });
    }
    if (kind === 'forget') {
      return makeForget({ eventId, target, mode, reason, logTime });
    }
    return makeRestore({ eventId, target, reason, logTime });
  }

  /** Reinforce existing episodes. The reinforcement log IS the anchor (no field). */
  async reinforce({ eventIds, weight = 1, eventTime }) {
    this.assertOpen();
    const ids = this.normaliseIds(eventIds);
    const snapshot = await this.logStore.snapshot();
    const known = new Set(
      snapshot.records.filter((record) => record.type === 'episode').map((record) => record.event_id),
    );
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new MemoryError(ErrorCodes.NOT_FOUND, 'cannot reinforce unknown event ids', { missing });
    }
    const records = [];
    for (const target of ids) {
      records.push(await this._controlRecord('reinforce', { target, eventTime, weight }));
    }
    await this.logStore.append(records);
    await this.indexManager.applyRecords(records);
    this.refreshBriefing();
    return {
      reinforced: ids,
      reinforcementEventIds: records.map((record) => record.event_id),
      anchor: records.reduce((max, record) => Math.max(max, record.log_time), 0),
    };
  }

  /** Delete: phase 1-4 pipeline, then a rebuild so the published index agrees. */
  async forget({ eventIds, mode = 'purge', reason = 'unspecified' }) {
    this.assertOpen();
    const ids = this.normaliseIds(eventIds);
    const job = await this.deletePipeline.request({ eventIds: ids, mode, reason });
    const maintenance = await this.maintenance.run({ reason: `forget:${job.id}` });
    return { job: this.publicJob(job), maintenance: this.publicMaintenance(maintenance) };
  }

  /** Undo a tombstone while the bytes still exist (archive mode or pre-purge). */
  async restore({ eventIds, reason = 'rollback' }) {
    this.assertOpen();
    const ids = this.normaliseIds(eventIds);
    const snapshot = await this.logStore.snapshot();
    const present = new Set(
      snapshot.records.filter((record) => record.type === 'episode').map((record) => record.event_id),
    );
    const purged = ids.filter((id) => !present.has(id));
    if (purged.length > 0) {
      throw new MemoryError(ErrorCodes.ALREADY_PURGED, 'event bytes are gone; restore the semantic summary instead', {
        purged,
      });
    }
    const records = [];
    for (const target of ids) records.push(await this._controlRecord('restore', { target, reason }));
    await this.logStore.append(records);
    for (const target of ids) this.tombstones.unmark({ eventId: target, at: this.clock.now(), reason });
    await this.maintenance.run({ reason: 'restore' });
    return { restored: ids, restoreEventIds: records.map((record) => record.event_id) };
  }

  // ---- read path ---------------------------------------------------------

  /**
   * Retrieve. Pure read: no adjudication, no writes, no log scan.
   * `indexManager.snapshot()` is a pointer read — a maintenance rebuild in flight
   * cannot block or tear this query.
   */
  async recall({ text = '', tags = [], topK } = {}) {
    this.assertOpen();
    const now = this.clock.now();
    const view = this.indexManager.snapshot();
    if (!view) {
      return {
        query: { text, tags, topK: topK ?? this.policy.candidates.topK },
        mode: 'degraded',
        degradedReason: 'no-index-yet',
        generation: null,
        hits: [],
        semantic: [],
        tempSemantic: this.tempStore.list({ status: 'temp', now }),
        scanned: { blocks: 0, candidates: 0, scored: 0, tagHits: 0 },
        candidateTags: [],
        activeTags: 0,
        notes: ['no index generation yet; run memory_admin action=maintain'],
      };
    }
    const semantic = this.semanticSummaries();
    const tempSemantic = this.tempStore.list({ status: 'temp', now });
    const result = runRecall({
      index: view,
      query: { text, tags, topK },
      policy: this.policy,
      now,
      semantic,
      tempSemantic,
    });
    return {
      ...result,
      stale: this._boot ? this._boot.status !== 'ok' : false,
      // A count, not the resident list: the online queue may read the active set
      // but never enumerate it into the response (that is offline adjudication's job).
      activeTagCount: view.activeSet?.entries?.length ?? 0,
      notes: [
        ...(result.notes ?? []),
        ...(this._boot && this._boot.status !== 'ok' ? [`boot-check:${this._boot.status}`] : []),
      ],
    };
  }

  async maintain({ reason = 'manual' } = {}) {
    this.assertOpen();
    const report = await this.maintenance.run({ reason });
    this._boot = { status: 'ok', logGen: report.logGen, indexGen: report.indexGen };
    // The graph is part of maintenance, never of the read path: the index is
    // already "log minus tombstones", so this is a projection of a projection.
    try {
      const view = this.indexManager.snapshot();
      this.graph.rebuild(view?.events ?? [], {
        indexGeneration: report.indexGen ?? view?.generation ?? null,
        maxEdges: GRAPH_HARD_CAP,
        topNeighbors: GRAPH_TOP_NEIGHBORS,
      });
      report.graph = this.graph.status({ limit: this.config?.graphMaxEdges ?? null, indexGeneration: report.indexGen ?? null });
    } catch (error) {
      // A graph failure must not fail maintenance (and must never block recall).
      report.graphError = error instanceof Error ? error.message : String(error);
    }
    this.refreshBriefing();
    return report;
  }

  /** Panel summary of the cached graph (no nodes, no edges). */
  graphStatus() {
    this.assertOpen();
    return this.graph.status({
      limit: this.config?.graphMaxEdges ?? null,
      indexGeneration: this.indexManager.generation,
    });
  }

  /** Route payload: cached edges sliced to the configured ceiling, nothing else. */
  graphView(limit) {
    this.assertOpen();
    return this.graph.view({ limit: limit ?? this.config?.graphMaxEdges ?? 500 });
  }

  // ---- L2.5 trend quarantine ---------------------------------------------

  async extractTrend({ content, sourceEvents = [], tags = [], occurredAt, ttlDays } = {}) {
    this.assertOpen();
    const result = await this.tempStore.observe({
      content,
      sourceEvents,
      tags,
      occurredAt: occurredAt ?? this.clock.now(),
      ttlDays,
    });
    this.refreshBriefing();
    return result;
  }

  trends({ status } = {}) {
    this.assertOpen();
    return this.tempStore.list({ status, now: this.clock.now() });
  }

  async status() {
    this.assertOpen();
    const now = this.clock.now();
    const log = await this.logStore.status();
    const index = this.indexManager.status();
    const semantic = this.semanticStore.status();
    const temp = this.tempStore.status({ now });
    const context = this.context.snapshot({ now });
    const jobs = this.deletePipeline.jobs();
    const report = this.maintenance.lastReport();
    const generation = {
      logGen: log.gen ?? null,
      indexGen: index.generation ?? null,
      logGeneration: log.gen ? genNumber(log.gen) : 0,
      indexGeneration: index.generation ? genNumber(index.generation) : 0,
    };
    return {
      dataDir: this.dataDir,
      policyHash: this.policyHash,
      log: { ...log, path: this.paths.log },
      index,
      identity: {
        ...this.ledger.status(),
        tombstones: this.tombstones.size(),
        deadLetters: this.dlq.size(),
      },
      semantic: { ...semantic, path: this.paths.semantic },
      temp,
      context,
      deletes: {
        total: jobs.length,
        pendingConsolidation: jobs.filter((job) => job.status === 'pending-consolidation').length,
        archived: jobs.filter((job) => job.status === 'archived').length,
        queued: jobs.filter((job) => job.status === 'running' || job.status === 'pending-consolidation').length,
      },
      boot: this._boot,
      budget: {
        activeSetCap: this.policy.activeSet.cap,
        activeTags: index.stats?.activeTags ?? 0,
        topKDefault: this.policy.candidates.topK,
        topKMax: this.policy.candidates.maxTopK,
        candidateBudget: (index.stats?.activeTags ?? 0) * this.policy.activeSet.tagBudget,
      },
      maintenance: { ...(report ?? {}), lastSuccessAt: report?.finishedAt ?? null },
      // ---- panel: the UI contract. Field names are part of the API. ----------
      panel: {
        generatedAt: now,
        global: {
          events: log.recordCount ?? 0,
          activeTags: index.stats?.activeTags ?? 0,
          semanticSummaries: semantic.summaries ?? 0,
          tempQuarantined: temp.temp ?? 0,
        },
        tokens: {
          contextTokens: context.tokens ?? 0,
          contextMaxTokens: context.maxTokens ?? 0,
          evictedBlocks: context.evictedBlocks ?? 0,
          // Exact definition: sum of tokens of blocks evicted by the context engine,
          // accumulated at eviction time and persisted in state/context.json.
          cumulativeSavedTokens: context.savedTokens ?? 0,
        },
        storage: {
          dataDir: this.dataDir,
          diskBytes: diskUsage(this.dataDir),
        },
        maintenance: {
          lastSuccessAt: report?.finishedAt ?? null,
          nextRunAt: this._nextRunAt(now),
          maintenanceCron: this.config?.maintenanceCron ?? null,
          running: this._scheduler?.running ?? false,
          queuedDeletes: jobs.filter((job) => job.status === 'running' || job.status === 'pending-consolidation').length,
        },
        generations: generation,
        // Cached graph summary: counts only, so the panel stays cheap.
        graph: this.graph.status({ limit: this.config?.graphMaxEdges ?? null, indexGeneration: index.generation ?? null }),
      },
    };
  }

  /** Scheduler handle for the panel (`running` is a live fact, not a stored one). */
  attachScheduler(scheduler) {
    this._scheduler = scheduler ?? null;
    return this;
  }

  _nextRunAt(now) {
    if (!this.config?.maintenanceCron) return null;
    try {
      return nextRun(parseCron(this.config.maintenanceCron), now);
    } catch {
      return null;
    }
  }

  /**
   * Boot-check evidence. `before` is what the store looked like on open (stale or
   * missing it was rebuilt, and `after` says so); never re-derives anything.
   */
  bootReport() {
    return { before: this._bootBefore ?? null, after: this._boot ?? null };
  }

  /**
   * Compact, model-facing state line used by the prompt context section.
   * Synchronous and IO-free on purpose: prompt assembly must never await disk.
   */
  briefing() {
    if (!this._briefing) this.refreshBriefing();
    return this._briefing.text;
  }

  refreshBriefing() {
    const index = this.indexManager.snapshot();
    const entries = index?.activeSet?.entries ?? [];
    const stats = index?.stats ?? {};
    const jobs = this.deletePipeline.jobs();
    const pendingDeletes = jobs.filter((job) => job.status !== 'done' && job.status !== 'archived').length;
    const top = entries
      .slice()
      .sort((a, b) => b.priority - a.priority || a.tag.localeCompare(b.tag))
      .slice(0, 8)
      .map((entry) => entry.tag);
    const parts = [
      `gen=${index?.generation ?? 'none'}`,
      `events=${stats.events ?? 0}`,
      `activeTags=${entries.length}/${this.policy.activeSet.cap}`,
      `semantic=${this.semanticStore.status().summaries}`,
      `temp=${this.tempStore.countTemp()}`,
    ];
    if (pendingDeletes > 0) parts.push(`pendingDeletes=${pendingDeletes}`);
    if (this.tombstones.size() > 0) parts.push(`tombstones=${this.tombstones.size()}`);
    const text = `Memory ${parts.join(' ')}${top.length ? ` | top: ${top.join(', ')}` : ''}`;
    this._briefing = { text, topTags: top, activeTags: entries.length, generation: index?.generation ?? null };
    return this._briefing;
  }

  semanticSummaries() {
    if (this._semanticCache) return this._semanticCache;
    this._semanticCache = this.semanticStore.list();
    return this._semanticCache;
  }

  // ---- policy & lifecycle ------------------------------------------------

  setPolicy(overrides) {
    this.policy = resolvePolicy(overrides);
    this.policyHash = hashPolicy(this.policy);
    return this.policyHash;
  }

  aliases() {
    return buildAliasMap(this.policy);
  }

  assertOpen() {
    if (this._closed) throw new MemoryError(ErrorCodes.IO, 'memory is closed');
  }

  normaliseIds(eventIds) {
    const list = Array.isArray(eventIds) ? eventIds : [eventIds];
    const ids = [...new Set(list.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))];
    if (ids.length === 0) throw new MemoryError(ErrorCodes.INVALID_INPUT, 'eventIds must be a non-empty array');
    return ids;
  }

  publicJob(job) {
    return {
      id: job.id,
      mode: job.mode,
      status: job.status,
      phase: job.phase,
      eventIds: job.eventIds,
      summaryIds: job.summaryIds,
      steps: job.steps,
    };
  }

  publicMaintenance(report) {
    return {
      indexGen: report.indexGen,
      logGen: report.logGen,
      stats: report.stats,
      activeSet: report.activeSet,
      temp: report.temp,
      notes: report.notes,
    };
  }

  close() {
    this._closed = true;
  }
}
