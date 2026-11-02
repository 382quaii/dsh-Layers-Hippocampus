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
   * @param {() => number} [opts.getMaxPostingsPerTag] live cap on postings per tag
   */
  constructor({ store, logStore, getPolicy, clock, getTombstones, getMaxPostingsPerTag = () => 500 }) {
    this.store = store;
    this.logStore = logStore;
    this.getPolicy = getPolicy;
    this.clock = clock;
    this.getTombstones = getTombstones;
    // Read on EVERY build (never captured once): config/profiles can change at
    // runtime, and a rebuild must honour the cap in force at build time.
    this.getMaxPostingsPerTag = getMaxPostingsPerTag;
    /** @type {object|null} */ this._active = null;
    /** @type {object|null} */ this._standby = null;
    /** @type {object[]} */ this._records = [];
    /**
     * Appends land in `_records` and mark the view dirty instead of rebuilding the
     * whole index on every write. The next read rebuilds ONCE (lazily), so a burst
     * of N writes costs one index build, not N — and read-your-writes still holds:
     * `snapshot()` never returns a view older than the last awaited append.
     */
    this._dirty = false;
    /** Generation the store will publish into next (survives live-only updates). */
    this._pendingGen = store.currentGeneration?.() ?? null;
    this._chain = Promise.resolve();
    this.hooks = { beforeSwap: null, afterSwap: null };
    this._swaps = 0;
  }

  /** The current immutable view. Synchronous by design: the read path never awaits. */
  snapshot() {
    if (this._dirty) this._ensureFresh();
    return this._active;
  }

  /**
   * Fold pending appends into the view, once. Synchronous: `buildIndex` is a pure
   * fold over records already in memory. The build is in-process only (the on-disk
   * generation is still published by `rebuild()` during maintenance), so A/B
   * semantics and the `generation` value are identical to the eager path it
   * replaces — only the timing moves from write to first read.
   */
  _ensureFresh() {
    this._dirty = false;
    if (!this._active) return null;
    const built = buildIndex({
      records: this._records,
      policy: this.getPolicy(),
      now: this.clock.now(),
      tombstones: this.getTombstones(),
      sourceLogGen: this._active.sourceLogGen ?? null,
      previous: this._active,
      maxPostingsPerTag: this._maxPostingsPerTag(),
    });
    built.generation = this._active.generation ?? this._pendingGen ?? null;
    built.revision = this._swaps + 1;
    this._swap(built);
    return built;
  }

  get generation() {
    return this._active?.generation ?? null;
  }

  /**
   * Posting cap in force for the next build. The callback is optional (a bare
   * IndexManager in a test gets the documented default), and a callback that throws
   * or returns garbage must not take the index down: an uncapped build is a far
   * smaller failure than a read path that cannot build at all.
   */
  _maxPostingsPerTag() {
    try {
      const value = this.getMaxPostingsPerTag?.();
      return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 500;
    } catch {
      return 500;
    }
  }

  /** Load the persisted generation into buffer A, or build once if none exists. */
  async open() {
    const disk = this.store.current();
    if (disk) {
      this._active = disk;
      this._records = await this._readLogRecords();
      this._dirty = false;
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
        maxPostingsPerTag: this._maxPostingsPerTag(),
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
          maxPostingsPerTag: this._maxPostingsPerTag(),
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
      this._dirty = false;
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
   * Online append: record the delta and mark the view dirty. Nothing is rebuilt
   * here — the next `snapshot()` folds all pending records into a fresh view. This
   * keeps a sequential write burst linear instead of quadratic, while a reader that
   * arrives right after an awaited append still sees it (the fold happens on read).
   */
  async applyRecords(records) {
    if (!Array.isArray(records) || records.length === 0) return this._active;
    return this._enqueue(async () => {
      this._records = this._records.concat(records);
      this._dirty = true;
      return this._active;
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
    this._dirty = false;
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
    const view = this.snapshot();
    const logCount = this._records.length;
    if (!view) return { status: 'missing', logRecordCount: logCount, indexRecordCount: 0 };
    const indexCount = view.stats?.recordCount ?? 0;
    if (indexCount !== logCount) {
      return { status: 'stale', logRecordCount: logCount, indexRecordCount: indexCount };
    }
    return { status: 'ok', logRecordCount: logCount, indexRecordCount: indexCount };
  }

  status() {
    const view = this.snapshot();
    return {
      generation: view?.generation ?? null,
      swaps: this._swaps,
      builtAt: view?.builtAt ?? null,
      policyHash: view?.policyHash ?? null,
      sourceLogGen: view?.sourceLogGen ?? null,
      // The cap in force, so the panel can explain why postingsTruncated > 0.
      maxPostingsPerTag: this._maxPostingsPerTag(),
      stats: view?.stats ?? {},
      pendingRecords: this._dirty ? Math.max(0, this._records.length - (view?.stats?.recordCount ?? 0)) : 0,
    };
  }
}
