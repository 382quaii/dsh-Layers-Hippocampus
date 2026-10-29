/**
 * Maintenance — the only place that mutates the read model or gains exclusive write.
 *
 * One `run()` performs, in order:
 *   1. drive pending delete jobs (archive can restore; purge is final)
 *   2. compact the log when it has too many segments
 *   3. rebuild the index: Build -> Catch-up -> Swap (double buffered, never blocks)
 *   4. L2.5 temp sweep (promote / expire / quarantine)
 *   5. prune old generations, persist the report
 *
 * Retrieval reads `indexManager.snapshot()` — a plain pointer read of the ACTIVE
 * buffer. Step 3 builds into the standby buffer and flips one pointer; a reader
 * that entered before the swap keeps the complete old view for its whole call.
 * No lock is taken on the read path, so maintenance cannot block a recall.
 */

import path from 'node:path';
import { clamp, readJson, writeJsonAtomic } from './util.js';
import { Mutex } from './util.js';

const STATE_VERSION = 1;

export class Maintenance {
  constructor({
    logStore,
    indexStore,
    indexManager,
    semanticStore,
    tempLayer,
    deletePipeline,
    clock,
    getPolicy,
    stateFile,
  }) {
    this.logStore = logStore;
    this.indexStore = indexStore;
    this.indexManager = indexManager;
    this.semanticStore = semanticStore;
    this.tempLayer = tempLayer;
    this.deletePipeline = deletePipeline;
    this.clock = clock;
    this.getPolicy = getPolicy;
    this.stateFile = stateFile;
    this.mutex = new Mutex();
    this._last = readJson(stateFile, null);
    this.onPublished = () => {};
  }

  /** Boot check: cheap generation + record-count comparison, never a rebuild. */
  async bootCheck() {
    // Read the PERSISTED generation, not the live buffer: a boot check answers
    // "is what is on disk stale?", and online appends must not mask that.
    const index = this.indexStore.status();
    const log = await this.logStore.status();
    const logGen = log.gen;
    if (!index.gen) {
      return { status: 'missing', logGen, indexGen: null, reason: 'no-index' };
    }
    if (!index.sourceLogGen || index.sourceLogGen !== logGen) {
      return {
        status: 'stale',
        logGen,
        indexGen: index.gen,
        reason: `sourceLogGen=${index.sourceLogGen} logGen=${logGen}`,
      };
    }
    if ((index.stats?.recordCount ?? 0) !== log.recordCount) {
      return {
        status: 'stale',
        logGen,
        indexGen: index.gen,
        reason: `records index=${index.stats?.recordCount ?? 0} log=${log.recordCount}`,
      };
    }
    return { status: 'ok', logGen, indexGen: index.gen };
  }

  lastReport() {
    return this._last;
  }

  async run({ reason = 'manual', now } = {}) {
    return this.mutex.run(async () => {
      const policy = this.getPolicy();
      const startedAt = Math.trunc(now ?? this.clock.now());
      const notes = [];
      const logBefore = await this.logStore.status();

      // 1. delete jobs -------------------------------------------------------
      const deletes = await this.deletePipeline.advanceAll();
      if (deletes.length > 0) notes.push(`deletes advanced: ${deletes.length}`);

      // 2. compaction --------------------------------------------------------
      let compaction = null;
      const segments = logBefore.segments ?? 0;
      if (segments > policy.maintenance.compactAfterSegments) {
        const result = await this.logStore.compact();
        const logAfter = await this.logStore.status();
        compaction = { from: segments, to: logAfter.segments, logGen: result.gen, kept: result.kept };
        notes.push(`compacted:${compaction.from}->${compaction.to} segments`);
      }

      // 3. rebuild: Build -> Catch-up -> Swap (readers keep the old snapshot) --
      const beforeView = this.indexManager.snapshot();
      const beforeTags = beforeView?.activeSet?.entries?.length ?? 0;
      await this.indexManager.rebuild({ reason, now });
      const built = this.indexManager.snapshot();
      const logAfter = await this.logStore.status();
      const indexGen = this.indexManager.generation;

      // 4. temp layer sweep --------------------------------------------------
      const temp = await this.tempSweep({ index: built, policy, now: startedAt });
      if (temp.promoted.length > 0) notes.push(`temp-promoted:${temp.promoted.length}`);
      if (temp.expired.length > 0) notes.push(`temp-expired:${temp.expired.length}`);

      // 5. prune + persist ---------------------------------------------------
      const pruned = this.indexStore.prune({ keep: policy.maintenance.keepGenerations });
      const report = {
        v: STATE_VERSION,
        reason,
        startedAt,
        finishedAt: Math.trunc(now ?? this.clock.now()),
        logGen: logAfter.currentGeneration,
        indexGen,
        previousIndexGen: built?.previousGeneration ?? null,
        policyHash: built?.policyHash ?? null,
        stats: built?.stats ?? null,
        activeSet: {
          before: beforeTags,
          after: built?.activeSet?.entries?.length ?? 0,
          cap: policy.activeSet.cap,
          admitted: built?.activeSet?.churn?.admitted ?? [],
          evicted: built?.activeSet?.evicted?.length ?? 0,
          churn: built?.activeSet?.churn ?? { admitted: [], dropped: [] },
          budgetUsed: built?.activeSet?.budgetUsed ?? 0,
        },
        temp,
        deletes: deletes.map((job) => ({ id: job.id, status: job.status, phase: job.phase })),
        compaction,
        pruned: pruned.removed,
        notes,
      };
      this._last = report;
      writeJsonAtomic(this.stateFile, report);
      this.onPublished(report);
      return report;
    });
  }

  /**
   * L2.5 sweep: aggregate bursts, then adjudicate every due entry.
   * Promotion writes an L3 summary; expiry physically removes the quarantine line.
   * Both outcomes are final — there is no "keep forever" third state.
   */
  async tempSweep({ index, policy, now }) {
    const temp = this.tempLayer;
    const built = index ?? this.indexManager.snapshot();
    const episodes = built?.events ? [...built.events.values()] : [];
    const result = await temp.sweep({ episodes, now, policy });
    return {
      promoted: result.promoted ?? [],
      picked: (result.promoted ?? []).length,
      purged: result.purged ?? [],
      expired: result.purged ?? [],
      retained: result.retained ?? 0,
      bursts: result.bursts ?? [],
      temp: temp.status({ now }),
      ttlDays: policy.temp.ttlDays,
      maxEntries: policy.temp.maxEntries,
      used: temp.countTemp(),
      utilisation: clamp(temp.countTemp() / policy.temp.maxEntries, 0, 1),
    };
  }
}
