/**
 * Hint feedback loop (v1.7.1, task mode).
 *
 * `[Memory Hints]` shows "相关经验标签: X、Y, 若需借鉴请调用 memory_recall". The loop
 * closes here:每展示一次就记一次 `shown`，只有当该标签**真的**带来一次 recall 时
 * 才记 `recalled`。连续展示 8 次（可配）且一次都没换来 recall 的标签，会被**单向
 * 静默**——不再出现在 hints 里，也不会因为之后偶然被 recall 而自动复活。
 *
 * "单向" is the important part: the previous behaviour (show forever, hope) made a
 * stale tag cost a line of prompt every single turn. A silencing that auto-revives
 * would just re-learn the same mistake, so revival requires deleting the state file
 * (or raising the threshold), not a lucky recall.
 *
 * Persistence: `state/hint-feedback.json` (schema 1). Bounded: at most
 * `MAX_TRACKED_TAGS` tags are kept, oldest-by-last-shown evicted. Never throws: a
 * broken/missing file degrades to "nothing silenced", because a hint loop must never
 * be able to break prompt assembly.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ensureDir, readJson, writeJsonAtomic } from './util.js';

export const HINT_FEEDBACK_SCHEMA = 1;
/** Default: 8 fruitless showings and the tag goes quiet for good. */
export const HINT_IDLE_SILENCE_AFTER = 8;
/** Hard bound on tracked tags — the file is state, not an archive. */
export const MAX_TRACKED_TAGS = 2000;

/**
 * @param {object} record one tag's counters
 * @param {number} threshold
 */
export function shouldSilence(record, threshold = HINT_IDLE_SILENCE_AFTER) {
  if (!record || record.silenced === true) return record?.silenced === true;
  const shown = Number(record.shown) || 0;
  const recalled = Number(record.recalled) || 0;
  const limit = Math.max(1, Number(threshold) || HINT_IDLE_SILENCE_AFTER);
  return recalled === 0 && shown >= limit;
}

export class HintFeedbackStore {
  /**
   * @param {{file: string, clock?: {now: () => number}}} options
   */
  constructor({ file, clock = { now: () => Date.now() } } = {}) {
    if (typeof file !== 'string' || file.length === 0) throw new Error('HintFeedbackStore needs a file path');
    this.file = file;
    this.clock = clock;
    this.state = { schema: HINT_FEEDBACK_SCHEMA, tags: {}, updatedAt: null };
    this.loaded = false;
  }

  load() {
    this.loaded = true;
    try {
      const raw = readJson(this.file, null);
      if (!raw || typeof raw !== 'object') return this.state;
      const tags = raw.tags && typeof raw.tags === 'object' ? raw.tags : {};
      const clean = {};
      for (const [tag, record] of Object.entries(tags)) {
        if (typeof tag !== 'string' || !tag) continue;
        if (!record || typeof record !== 'object') continue;
        clean[tag] = {
          shown: Math.max(0, Number(record.shown) || 0),
          recalled: Math.max(0, Number(record.recalled) || 0),
          silenced: record.silenced === true,
          silencedAt: Number(record.silencedAt) || null,
          lastShownAt: Number(record.lastShownAt) || null,
        };
      }
      this.state = { schema: HINT_FEEDBACK_SCHEMA, tags: clean, updatedAt: Number(raw.updatedAt) || null };
    } catch {
      /* a broken file means "nothing silenced", never a crash */
    }
    return this.state;
  }

  _ensure() {
    if (!this.loaded) this.load();
    return this.state;
  }

  /** Tags currently silenced (one-way). */
  silencedTags() {
    const state = this._ensure();
    return Object.entries(state.tags)
      .filter(([, record]) => record.silenced === true)
      .map(([tag]) => tag);
  }

  /** Filter a hint list: drop silenced tags, keep order. */
  filter(tags = []) {
    const silenced = new Set(this.silencedTags());
    return (Array.isArray(tags) ? tags : []).filter((tag) => typeof tag === 'string' && !silenced.has(tag));
  }

  /**
   * Record that these tags were SHOWN this turn. Returns the tags that just became
   * silenced, so the caller can log/observe the transition instead of only noticing
   * that a hint vanished.
   */
  noteShown(tags = [], { threshold = HINT_IDLE_SILENCE_AFTER } = {}) {
    const state = this._ensure();
    const now = this.clock.now();
    const newlySilenced = [];
    let changed = false;
    for (const tag of Array.isArray(tags) ? tags : []) {
      if (typeof tag !== 'string' || tag.length === 0) continue;
      const record = state.tags[tag] ?? { shown: 0, recalled: 0, silenced: false, silencedAt: null, lastShownAt: null };
      if (record.silenced === true) continue;
      record.shown += 1;
      record.lastShownAt = now;
      if (shouldSilence(record, threshold)) {
        record.silenced = true;
        record.silencedAt = now;
        newlySilenced.push(tag);
      }
      state.tags[tag] = record;
      changed = true;
    }
    if (changed) {
      this._trim();
      state.updatedAt = now;
      this._write();
    }
    return { silenced: newlySilenced, changed };
  }

  /** Record that a recall actually happened for these tags. Does NOT revive. */
  noteRecalled(tags = []) {
    const state = this._ensure();
    let changed = false;
    for (const tag of Array.isArray(tags) ? tags : []) {
      if (typeof tag !== 'string' || tag.length === 0) continue;
      const record = state.tags[tag];
      if (!record) continue;
      record.recalled += 1;
      changed = true;
    }
    if (changed) {
      state.updatedAt = this.clock.now();
      this._write();
    }
    return { changed };
  }

  /** Forget one tag's silence (explicit operator action; not called automatically). */
  revive(tag) {
    const state = this._ensure();
    const record = state.tags[tag];
    if (!record?.silenced) return false;
    record.silenced = false;
    record.silencedAt = null;
    record.shown = 0;
    record.recalled = 0;
    state.updatedAt = this.clock.now();
    this._write();
    return true;
  }

  _trim() {
    const state = this._ensure();
    const entries = Object.entries(state.tags);
    if (entries.length <= MAX_TRACKED_TAGS) return;
    entries.sort((left, right) => (Number(left[1].lastShownAt) || 0) - (Number(right[1].lastShownAt) || 0));
    for (const [tag] of entries.slice(0, entries.length - MAX_TRACKED_TAGS)) delete state.tags[tag];
  }

  _write() {
    try {
      ensureDir(path.dirname(this.file));
      writeJsonAtomic(this.file, this.state);
    } catch {
      /* state is advisory: a read-only disk must not break prompt assembly */
    }
  }

  status() {
    const state = this._ensure();
    const tags = Object.entries(state.tags);
    const silenced = tags.filter(([, record]) => record.silenced === true);
    return {
      tracked: tags.length,
      silenced: silenced.length,
      silencedTags: silenced.slice(0, 20).map(([tag]) => tag),
      updatedAt: state.updatedAt,
    };
  }

  /** Test/ops helper: drop the file and the in-memory cache. */
  static removeFile(file) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
}
