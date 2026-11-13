/**
 * Spaced repetition schedule (1, 2, 4, 7, 15, 30 days by default).
 *
 * Engine-owned: the model cannot "mark reviewed" out of band — a review advances
 * only when `reinforce` succeeds, and due items are computed offline in
 * `maintain()` from the persisted table. Recall stays read-only.
 */

import { readJson, writeJsonAtomic } from './util.js';

export const REVIEW_SCHEMA = 1;
export const DAY_MS = 86_400_000;
/** Events below this salience are not worth a review slot. */
export const REVIEW_MIN_SALIENCE = 0.5;

export class ReviewSchedule {
  constructor({ file, clock, getPolicy }) {
    this.file = file;
    this.clock = clock;
    this.getPolicy = getPolicy;
  }

  intervals() {
    const policy = this.getPolicy?.() ?? {};
    const list = policy.review?.intervals;
    return Array.isArray(list) && list.length > 0 ? list : [1, 2, 4, 7, 15, 30];
  }

  enabled() {
    const policy = this.getPolicy?.() ?? {};
    return policy.review?.enabled !== false;
  }

  load() {
    const state = readJson(this.file, null);
    if (!state || state.schema !== REVIEW_SCHEMA || typeof state.items !== 'object' || state.items === null) {
      return { schema: REVIEW_SCHEMA, items: {} };
    }
    return state;
  }

  save(state) {
    writeJsonAtomic(this.file, { schema: REVIEW_SCHEMA, updatedAt: this.clock.now(), items: state.items });
  }

  entryId(eventId) {
    return eventId;
  }

  /** Entry for one event, freshly created at step 0 if absent. */
  ensure(state, event, now) {
    if (state.items[event.eventId]) return state.items[event.eventId];
    const intervals = this.intervals();
    const entry = {
      step: 0,
      dueAt: now + intervals[0] * DAY_MS,
      lastAt: null,
      createdAt: now,
      salience: event.salience ?? 0,
    };
    state.items[event.eventId] = entry;
    return entry;
  }

  /**
   * Reconcile the table with the live index: add eligible events, drop entries
   * whose event is gone (deleted), and return what is due right now.
   */
  tick({ events = [], now = this.clock.now() } = {}) {
    if (!this.enabled()) return { due: [], total: 0, upcoming: 0, disabled: true };
    const state = this.load();
    const live = new Set();
    let changed = false;
    for (const event of events) {
      if ((event.salience ?? 0) < REVIEW_MIN_SALIENCE) continue;
      const tags = (event.tags ?? []).map((tag) => tag.tag ?? tag);
      if (tags.includes('status:monthly')) continue; // memos are stable summaries
      live.add(event.eventId);
      const existed = Boolean(state.items[event.eventId]);
      this.ensure(state, event, now);
      if (!existed) changed = true;
    }
    for (const eventId of Object.keys(state.items)) {
      if (!live.has(eventId)) {
        delete state.items[eventId];
        changed = true;
      }
    }
    const due = Object.entries(state.items)
      .filter(([, entry]) => entry.dueAt <= now)
      .map(([eventId, entry]) => ({
        eventId,
        step: entry.step,
        intervalDays: this.intervals()[Math.min(entry.step, this.intervals().length - 1)],
        dueAt: entry.dueAt,
        overdueMs: now - entry.dueAt,
        lastAt: entry.lastAt,
      }))
      .sort((a, b) => a.dueAt - b.dueAt || a.eventId.localeCompare(b.eventId));
    const upcoming = Object.values(state.items).filter((entry) => entry.dueAt > now).length;
    if (changed) this.save(state);
    return { due, total: Object.keys(state.items).length, upcoming };
  }

  /** A successful review moves the event to the next interval. */
  advance(eventId, { now = this.clock.now() } = {}) {
    const state = this.load();
    const entry = state.items[eventId];
    if (!entry) return null;
    const intervals = this.intervals();
    entry.step = Math.min(entry.step + 1, intervals.length - 1);
    entry.lastAt = now;
    entry.dueAt = now + intervals[entry.step] * DAY_MS;
    this.save(state);
    return { eventId, step: entry.step, dueAt: entry.dueAt };
  }

  /**
   * Advance MANY events in one load + one atomic write (v1.6.3).
   *
   * `advance()` re-reads and rewrites `state/reviews.json` per event, which is fine
   * for a single manual reinforce but pathological for the backfill consumer: a
   * 337-item backlog would mean 337 file reads and 337 fsync-style rewrites inside
   * ONE maintenance pass. This is the batched form — same semantics, one write.
   */
  advanceMany(eventIds, { now = this.clock.now() } = {}) {
    const ids = Array.isArray(eventIds) ? eventIds.filter((id) => typeof id === 'string' && id.length > 0) : [];
    if (ids.length === 0) return [];
    const state = this.load();
    const intervals = this.intervals();
    const advanced = [];
    let changed = false;
    for (const eventId of ids) {
      const entry = state.items[eventId];
      if (!entry) continue;
      entry.step = Math.min((entry.step ?? 0) + 1, intervals.length - 1);
      entry.lastAt = now;
      entry.dueAt = now + intervals[entry.step] * DAY_MS;
      advanced.push({ eventId, step: entry.step, dueAt: entry.dueAt });
      changed = true;
    }
    if (changed) this.save(state);
    return advanced;
  }

  /** Read-only view for admin / panel. */
  status({ now = this.clock.now() } = {}) {
    const state = this.load();
    const items = Object.entries(state.items).map(([eventId, entry]) => ({ eventId, ...entry }));
    return {
      enabled: this.enabled(),
      total: items.length,
      due: items.filter((item) => item.dueAt <= now).length,
      intervals: this.intervals(),
      items: items.sort((a, b) => a.dueAt - b.dueAt).slice(0, 50),
    };
  }
}
