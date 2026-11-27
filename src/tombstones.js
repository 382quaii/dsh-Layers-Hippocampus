/**
 * v1.7.3 (module 2): the raw-layer tombstone OVERLAY.
 *
 * The raw log is the one append-only source of truth, and it used to carry
 * bookkeeping lines inside it:
 *
 *     {"type":"raw_tombstone","hash":"…","timestamp":…}
 *
 * That polluted the log: every reader had to special-case a line that is not a
 * turn, `deep_raw` cursors had to skip it, and the file no longer meant "turns in
 * the order they happened". Worse, the marker lived in the SAME file as the data
 * it was hiding, so "purge" could never be verified by looking at the log alone.
 *
 * This module moves that overlay OUT of the log:
 *
 *   - `state/raw-tombstones.json` holds the keys, the log holds nothing but turns;
 *   - matching is two-layered, because two different things get deleted:
 *       * `turnIds`       — a whole captured turn (`turn_<seq>_<role>`), and
 *       * `contentHashes` — a FRAGMENT, i.e. an episode distilled out of a turn.
 *     Deleting an episode must not have to delete the whole turn, and deleting a
 *     turn must not silently keep its fragments readable.
 *
 * Everything here is a pure load/mutate/write object: no raw shard is touched.
 */

import path from 'node:path';
import { ensureDir, readJson, sha256, writeJsonAtomic } from './util.js';

export const RAW_TOMBSTONE_SCHEMA = 1;
export const RAW_TOMBSTONE_FILE = 'raw-tombstones.json';
/** How many keys we keep before the oldest are dropped (a tombstone must outlive the log anyway). */
export const MAX_TOMBSTONE_KEYS = 200_000;

/**
 * A tombstone store is deliberately dumb: two string→timestamp maps and a file.
 * `has()` must stay O(1) because `deep_raw` calls it once per scanned row.
 */
export class RawTombstoneStore {
  constructor({ file, clock } = {}) {
    this.file = file ?? path.join('state', RAW_TOMBSTONE_FILE);
    this.clock = clock ?? { now: () => Date.now() };
    this._loaded = null;
  }

  /** Load (and normalise) the overlay. Never throws: a broken file means "no tombstones". */
  load() {
    if (this._loaded) return this._loaded;
    const raw = readJson(this.file, null);
    const turnIds = raw && typeof raw.turnIds === 'object' && raw.turnIds !== null ? { ...raw.turnIds } : {};
    const contentHashes =
      raw && typeof raw.contentHashes === 'object' && raw.contentHashes !== null ? { ...raw.contentHashes } : {};
    this._loaded = { schema: RAW_TOMBSTONE_SCHEMA, turnIds, contentHashes, updatedAt: raw?.updatedAt ?? null };
    return this._loaded;
  }

  /** True when EITHER key matches. Both arguments are optional. */
  has({ turnId = null, contentHash = null } = {}) {
    const state = this.load();
    if (typeof turnId === 'string' && turnId.length > 0 && state.turnIds[turnId] !== undefined) return true;
    if (typeof contentHash === 'string' && contentHash.length > 0 && state.contentHashes[contentHash] !== undefined) return true;
    return false;
  }

  /** True when the literal text is tombstoned by content hash (used by readers that only have the text). */
  hasContent(content) {
    if (typeof content !== 'string') return false;
    return this.has({ contentHash: sha256(content) });
  }

  /**
   * Record keys. Returns `{added, total}`; `added` counts keys that were NOT already present,
   * so a repeat purge is a no-op instead of growing the file.
   */
  add({ turnIds = [], contentHashes = [], at = null } = {}) {
    const state = this.load();
    const stamp = Number.isFinite(at) ? at : this.clock.now();
    let added = 0;
    for (const turnId of turnIds) {
      if (typeof turnId !== 'string' || turnId.length === 0) continue;
      if (state.turnIds[turnId] !== undefined) continue;
      state.turnIds[turnId] = stamp;
      added += 1;
    }
    for (const hash of contentHashes) {
      if (typeof hash !== 'string' || hash.length === 0) continue;
      if (state.contentHashes[hash] !== undefined) continue;
      state.contentHashes[hash] = stamp;
      added += 1;
    }
    if (added > 0) {
      state.updatedAt = stamp;
      this._trim(state);
      this.write();
    }
    return { added, total: this.size() };
  }

  /** Remove one key (used by `restore`). Returns the number of keys actually removed. */
  remove({ turnIds = [], contentHashes = [] } = {}) {
    const state = this.load();
    let removed = 0;
    for (const turnId of turnIds) {
      if (state.turnIds[turnId] !== undefined) {
        delete state.turnIds[turnId];
        removed += 1;
      }
    }
    for (const hash of contentHashes) {
      if (state.contentHashes[hash] !== undefined) {
        delete state.contentHashes[hash];
        removed += 1;
      }
    }
    if (removed > 0) {
      state.updatedAt = this.clock.now();
      this.write();
    }
    return removed;
  }

  size() {
    const state = this.load();
    return Object.keys(state.turnIds).length + Object.keys(state.contentHashes).length;
  }

  list() {
    const state = this.load();
    return { turnIds: Object.keys(state.turnIds), contentHashes: Object.keys(state.contentHashes) };
  }

  status() {
    const state = this.load();
    return {
      schema: RAW_TOMBSTONE_SCHEMA,
      file: this.file,
      turnIds: Object.keys(state.turnIds).length,
      contentHashes: Object.keys(state.contentHashes).length,
      updatedAt: state.updatedAt,
    };
  }

  write() {
    ensureDir(path.dirname(this.file));
    writeJsonAtomic(this.file, this._loaded);
    return this._loaded;
  }

  /** Oldest-first eviction; keys are inserted in time order, so `Object.keys` order is the age order. */
  _trim(state) {
    const limit = Math.floor(MAX_TOMBSTONE_KEYS / 2);
    for (const bucket of ['turnIds', 'contentHashes']) {
      const keys = Object.keys(state[bucket]);
      if (keys.length <= limit) continue;
      for (const key of keys.slice(0, keys.length - limit)) delete state[bucket][key];
    }
  }
}
