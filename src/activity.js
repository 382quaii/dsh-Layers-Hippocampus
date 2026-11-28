/**
 * Activity stream: a tiny bounded ring of recent recall/capture events.
 *
 * The Web panel flashes tags that were *just* used. That is presentation state,
 * not durable memory: it must never grow, never fail a recall, and never carry a
 * secret. So this store:
 *   - keeps at most `limit` items in memory (default 64);
 *   - sanitises every write (<= 12 tags, <= 8 event ids, 64 chars each) and drops
 *     `sensitive:` / `privacy:` tags outright — the v1.7.3 sensitive read gate must
 *     not be undone by an activity hint;
 *   - persists opt-in only (`file` set), at most once per `persistIntervalMs`;
 *   - treats a missing/corrupt file as empty.
 */

import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic } from './util.js';

/** Bump when the persisted shape changes; older files are ignored, not migrated. */
export const ACTIVITY_SCHEMA = 1;
/** Hard sanitisation caps shared by every write path. */
export const ACTIVITY_MAX_TAGS = 12;
export const ACTIVITY_MAX_EVENT_IDS = 8;
export const ACTIVITY_MAX_STRING = 64;

const KINDS = new Set(['recall', 'capture']);
const SECRET_TAG_PREFIXES = ['sensitive:', 'privacy:'];

function positiveInt(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(Math.trunc(number), max));
}

/** Trim, cap and drop secret tags; returns a fresh array. */
function sanitiseTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of tags) {
    if (typeof entry !== 'string') continue;
    const tag = entry.trim().slice(0, ACTIVITY_MAX_STRING);
    if (!tag) continue;
    const lowered = tag.toLowerCase();
    if (SECRET_TAG_PREFIXES.some((prefix) => lowered.startsWith(prefix))) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= ACTIVITY_MAX_TAGS) break;
  }
  return out;
}

/** Same contract as tags, but event ids get their own (smaller) cap. */
function sanitiseEventIds(eventIds) {
  if (!Array.isArray(eventIds)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of eventIds) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim().slice(0, ACTIVITY_MAX_STRING);
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= ACTIVITY_MAX_EVENT_IDS) break;
  }
  return out;
}

function copyItem(item) {
  return { ...item, tags: [...item.tags], eventIds: [...item.eventIds] };
}

export class ActivityStore {
  /**
   * @param {object} [options]
   * @param {number} [options.limit]             ring size (default 64)
   * @param {string|null} [options.file]         opt-in persistence file
   * @param {{now?: Function}|null} [options.clock]
   * @param {number} [options.persistIntervalMs] minimum automatic write interval
   */
  constructor({ limit = 64, file = null, clock = null, persistIntervalMs = 5000 } = {}) {
    this.limit = positiveInt(limit, 64, 1024);
    this.file = typeof file === 'string' && file.trim() ? file : null;
    this.clock = clock && typeof clock.now === 'function' ? clock : { now: () => Date.now() };
    this.persistIntervalMs = positiveInt(persistIntervalMs, 5000, 60 * 60 * 1000);
    this._items = [];
    this._cursor = 0;
    this._loaded = false;
    this._dirty = false;
    this._timer = null;
  }

  /** Load the persisted ring once; corrupt/missing files are simply empty. */
  _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    if (!this.file) return;
    const record = readJson(this.file, null);
    if (!record || record.schema !== ACTIVITY_SCHEMA || !Array.isArray(record.items)) return;
    const items = record.items
      .filter((item) => item && Number.isInteger(item.seq) && item.seq > 0 && KINDS.has(item.kind))
      .map((item) => ({
        seq: item.seq,
        kind: item.kind,
        tags: sanitiseTags(item.tags),
        eventIds: sanitiseEventIds(item.eventIds),
        at: Number.isFinite(item.at) ? item.at : this.clock.now(),
        source: typeof item.source === 'string' && item.source ? item.source.slice(0, ACTIVITY_MAX_STRING) : 'memory',
      }))
      .sort((a, b) => a.seq - b.seq);
    this._items = items.slice(-this.limit);
    const storedCursor = Number.isInteger(record.cursor) && record.cursor > 0 ? record.cursor : 0;
    const lastSeq = items.length > 0 ? items[items.length - 1].seq : 0;
    this._cursor = Math.max(storedCursor, lastSeq);
  }

  /**
   * Append one activity item.
   *
   * @param {{kind: string, tags?: string[], eventIds?: string[], at?: number|null, source?: string}} input
   * @returns {{seq: number, item: object}|null} null for an unknown kind (never throws)
   */
  record({ kind, tags = [], eventIds = [], at = null, source = 'memory' } = {}) {
    try {
      if (!KINDS.has(kind)) return null;
      this._ensureLoaded();
      const seq = this._cursor + 1;
      this._cursor = seq;
      const item = {
        seq,
        kind,
        tags: sanitiseTags(tags),
        eventIds: sanitiseEventIds(eventIds),
        at: Number.isFinite(at) ? at : this.clock.now(),
        source: typeof source === 'string' && source ? source.slice(0, ACTIVITY_MAX_STRING) : 'memory',
      };
      this._items.push(item);
      if (this._items.length > this.limit) this._items.splice(0, this._items.length - this.limit);
      this._markDirty();
      return { seq, item: copyItem(item) };
    } catch {
      // An activity hint must never break a recall or a capture.
      return null;
    }
  }

  /**
   * Read items newer than `since`, oldest first.
   *
   * @param {{since?: number, limit?: number}} [options]
   * @returns {{items: object[], cursor: number, now: number}}
   */
  recent({ since = 0, limit = 64 } = {}) {
    try {
      this._ensureLoaded();
      const sinceSeq = Number.isFinite(Number(since)) ? Math.max(0, Math.trunc(Number(since))) : 0;
      const max = positiveInt(limit, 64, this.limit);
      const matching = this._items.filter((item) => item.seq > sinceSeq);
      return { items: matching.slice(-max).map(copyItem), cursor: this._cursor, now: this.clock.now() };
    } catch {
      return { items: [], cursor: this._cursor, now: this.clock.now() };
    }
  }

  size() {
    this._ensureLoaded();
    return this._items.length;
  }

  /** Reset the ring (and its cursor) in memory; the persisted file is truncated on flush. */
  clear() {
    this._ensureLoaded();
    this._items = [];
    this._cursor = 0;
    this._dirty = true;
    this._scheduleFlush();
  }

  /** Write now. No-op for an in-memory store. */
  flush() {
    this._ensureLoaded();
    this._cancelFlush();
    if (!this.file) return;
    try {
      ensureDir(path.dirname(this.file));
      writeJsonAtomic(this.file, {
        schema: ACTIVITY_SCHEMA,
        items: this._items.map(copyItem),
        cursor: this._cursor,
        updatedAt: this.clock.now(),
      });
      this._dirty = false;
    } catch {
      // Persistence is best-effort; the in-memory ring stays authoritative.
    }
  }

  _markDirty() {
    this._dirty = true;
    this._scheduleFlush();
  }

  _scheduleFlush() {
    if (!this.file || this._timer) return;
    const timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, this.persistIntervalMs);
    // A pending hint flush must never keep the host process alive.
    if (typeof timer.unref === 'function') timer.unref();
    this._timer = timer;
  }

  _cancelFlush() {
    if (!this._timer) return;
    clearTimeout(this._timer);
    this._timer = null;
  }
}
