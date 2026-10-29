/**
 * Index manager: A/B double buffer with a lock-free read path.
 *
 * Three rules, all load-bearing:
 *
 *   1. READERS NEVER WAIT. `snapshot()` returns the current immutable view by
 *      reading one reference. No lock, no await, no partial state: a reader either
 *      sees the whole old buffer or the whole new one.
 *   2. WRITERS BUILD IN B. A rebuild fills a second buffer, and only after it is
 *      complete does the active pointer move (one assignment, atomic in the JS
 *      event loop). A barrier hook exists so tests can hold the write at exactly
 *      that point and prove readers still get a complete old snapshot.
 *   3. REBUILD = BUILD -> CATCH-UP -> SWAP. The Build phase scans a snapshot of the
 *      log, the Catch-up phase replays everything appended while Build ran, and the
 *      Swap phase publishes and flips the pointer. No naked drop-and-rebuild, no
 *      table-wide lock.
 *
 * Resurrection guard: every build (full or catch-up) receives the tombstone set and
 * buildIndex drops those event ids, so a deleted event cannot come back through a
 * rebuild. Delete `index/` freely — that is the point of a rebuildable read model.
 */

import { buildIndex } from './buildIndex.js';
import { MemoryError, ErrorCodes } from '../errors.js';

const MAX_CATCHUP_PASSES = 3;

export class IndexManager {
  /**
   * @param {object} opts
   * @param {import('./indexStore.js').IndexStore} opts.store disk persistence
   * @param {import('../log/logStore.js').LogStore} opts.logStore truth source
   * @param {() => Readonly<object>} opts.getPolicy resolved policy getter
   * @param {{now: () => number}} opts.clock
   * @param {() => Set<string>} opts.getTombstones tombstone ids (registry ∪ log)
   */
  constructor({ store, logStore, getPolicy, clock, getTombstones }) {
    this.store = store;
    this.logStore = logStore;
    this.getPolicy = getPolicy;
    this.clock = clock;
    this.getTombstones = getTombstones;
    /** @type {object|null} */ this._active = null;
    /** @type {object|null} */ this._standby = null;
    /** @type {object[]} */ this._records = [];
    /** Generation the store will publish into next (survives live-only updates). */
    this._pendingGen = store.currentGeneration?.() ?? null;
    this._chain = Promise.resolve();
    this.hooks = { beforeSwap: null, afterSwap: null };
    this._swaps = 0;
  }

  /** The current immutable view. Synchronous by design: the read path never awaits. */
  snapshot() {
    return this._active;
  }

  get generation() {
    return this._active?.generation ?? null;
  }

  /** Load the persisted generation into buffer A, or build once if none exists. */
  async open() {
    const disk = this.store.current();
    if (disk) {
      this._active = disk;
      this._records = await this._readLogRecords();
      return this._active;
    }
    const records = await this._readLogRecords();
    if (records.length === 0) return null;
    return this.rebuild({ reason: 'bootstrap' });
  }

  async _readLogRecords() {
    const snapshot = await this.logStore.snapshot();
    return snapshot.records;
  }

  /**
   * Full rebuild. Publishes to disk, then flips the pointer.
   * @param {{reason?: string}} [opts]
   */
  async rebuild({ reason = 'rebuild' } = {}) {
    return this._enqueue(async () => {
      const policy = this.getPolicy();
      const tombstones = this.getTombstones();

      // ---- phase 1: BUILD (scan the log, exclude tombstones) ----------------
      const opened = await this.logStore.snapshot();
      let records = opened.records;
      let watermark = records.length;
      let built = buildIndex({
        records,
        policy,
        now: this.clock.now(),
        tombstones,
        sourceLogGen: opened.gen,
        previous: this._active,
      });

      // ---- phase 2: CATCH-UP (replay what landed while we were building) ---
      for (let pass = 0; pass < MAX_CATCHUP_PASSES; pass += 1) {
        const tail = await this.logStore.recordsSince(watermark);
        if (tail.records.length === 0) break;
        records = records.concat(tail.records);
        watermark = records.length;
        built = buildIndex({
          records,
          policy,
          now: this.clock.now(),
          tombstones: this.getTombstones(),
          sourceLogGen: tail.gen ?? opened.gen,
          previous: this._active,
        });
      }

      // ---- phase 3: SWAP (standby fully built; pointer flips here) ----------
      this._standby = built;
      const published = this.store.publish(built, { sourceLogGen: opened.gen });
      built.generation = published.gen;
      built.previousGeneration = this._active?.generation ?? null;
      await this._beforeSwap(built);
      this._swap(built);
      this._records = records;
      this.store.prune({ keep: 2 });
      await this._afterSwap(built);
      built.reason = reason;
      return {
        generation: built.generation,
        previousGeneration: built.previousGeneration,
        sourceLogGen: opened.gen,
        recordCount: records.length,
        stats: built.stats,
        reason,
      };
    });
  }

  /**
   * Online append: the delta is folded into the standby buffer and published by a
   * pointer flip. Readers keep the old view for the duration of the build.
   */
  async applyRecords(records) {
    if (!Array.isArray(records) || records.length === 0) return this._active;
    return this._enqueue(async () => {
      const nextRecords = this._records.concat(records);
      // Yield first: a reader that arrives now still gets buffer A.
      await Promise.resolve();
      const built = buildIndex({
        records: nextRecords,
        policy: this.getPolicy(),
        now: this.clock.now(),
        tombstones: this.getTombstones(),
        sourceLogGen: this._active?.sourceLogGen ?? null,
        previous: this._active,
      });
      built.generation = this._active?.generation ?? this._pendingGen ?? null;
      built.revision = this._swaps + 1;
      this._standby = built;
      await this._beforeSwap(built);
      this._swap(built);
      this._records = nextRecords;
      await this._afterSwap(built);
      return built;
    });
  }

  /** Adopt a view that was built elsewhere (used by maintenance with its own clock). */
  adopt(view, { records = null } = {}) {
    if (!view || typeof view !== 'object') {
      throw new MemoryError(ErrorCodes.INDEX_CORRUPT, 'adopt() needs an index view');
    }
    this._standby = view;
    this._swap(view);
    if (records) this._records = records;
    return view;
  }

  _swap(view) {
    // ONE assignment: the read path resolves `_active` once per query.
    this._active = view;
    this._standby = null;
    this._swaps += 1;
  }

  async _beforeSwap(view) {
    if (typeof this.hooks.beforeSwap === 'function') await this.hooks.beforeSwap(view);
  }

  async _afterSwap(view) {
    if (typeof this.hooks.afterSwap === 'function') await this.hooks.afterSwap(view);
  }

  /** Serialise rebuilds/appends so two writers cannot interleave their buffers. */
  _enqueue(task) {
    const run = this._chain.then(task, task);
    this._chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Boot-time consistency check: does the persisted index still match the log? */
  bootCheck() {
    const view = this._active;
    const logCount = this._records.length;
    if (!view) return { status: 'missing', logRecordCount: logCount, indexRecordCount: 0 };
    const indexCount = view.stats?.recordCount ?? 0;
    if (indexCount !== logCount) {
      return { status: 'stale', logRecordCount: logCount, indexRecordCount: indexCount };
    }
    return { status: 'ok', logRecordCount: logCount, indexRecordCount: indexCount };
  }

  status() {
    return {
      generation: this._active?.generation ?? null,
      swaps: this._swaps,
      builtAt: this._active?.builtAt ?? null,
      policyHash: this._active?.policyHash ?? null,
      sourceLogGen: this._active?.sourceLogGen ?? null,
      stats: this._active?.stats ?? {},
      pendingRecords: 0,
    };
  }
}
