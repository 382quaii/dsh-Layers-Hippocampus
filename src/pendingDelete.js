/**
 * Two-phase delete: `pending_delete` countdown before the destructive pipeline.
 *
 * `forget` parks the event ids for `delete.graceHours` (default 24h). Until the
 * deadline the memory is still served (no tombstone yet), and `restore` simply
 * cancels the request. `maintain()` promotes due requests into the delete
 * pipeline; the model can never purge directly.
 */

import { readJson, sha256, writeJsonAtomic } from './util.js';

export const PENDING_SCHEMA = 1;
export const HOUR_MS = 3_600_000;

export class PendingDeletes {
  constructor({ file, clock }) {
    this.file = file;
    this.clock = clock;
  }

  load() {
    const state = readJson(this.file, null);
    if (!state || state.schema !== PENDING_SCHEMA || !Array.isArray(state.items)) {
      return { schema: PENDING_SCHEMA, items: [] };
    }
    return state;
  }

  save(state) {
    writeJsonAtomic(this.file, { schema: PENDING_SCHEMA, updatedAt: this.clock.now(), items: state.items });
  }

  list() {
    return this.load().items;
  }

  /** Park ids. Re-requesting the same set at the same time is idempotent. */
  request({ eventIds = [], mode = 'purge', reason = 'unspecified', graceHours = 24 } = {}) {
    if (!Array.isArray(eventIds) || eventIds.length === 0) {
      throw new Error('pending delete requires at least one event id');
    }
    const now = this.clock.now();
    const ids = [...new Set(eventIds)].sort();
    const state = this.load();
    const id = sha256(`pending|${ids.join(',')}|${now}`).slice(0, 24);
    const record = {
      id,
      eventIds: ids,
      mode,
      reason,
      requestedAt: now,
      dueAt: now + graceHours * HOUR_MS,
      graceHours,
    };
    state.items.push(record);
    this.save(state);
    return record;
  }

  /** Cancel pending requests touching any of these ids; returns removed event ids. */
  cancel(eventIds = []) {
    const wanted = new Set(eventIds);
    const state = this.load();
    const cancelled = [];
    state.items = state.items.filter((item) => {
      const hit = item.eventIds.filter((id) => wanted.has(id));
      if (hit.length === 0) return true;
      cancelled.push(...hit);
      return false;
    });
    if (cancelled.length > 0) this.save(state);
    return [...new Set(cancelled)];
  }

  /** Requests whose deadline has passed. */
  due(now = this.clock.now()) {
    return this.load().items.filter((item) => item.dueAt <= now);
  }

  remove(id) {
    const state = this.load();
    const before = state.items.length;
    state.items = state.items.filter((item) => item.id !== id);
    if (state.items.length !== before) this.save(state);
  }

  status(now = this.clock.now()) {
    const items = this.load().items;
    return {
      total: items.length,
      due: items.filter((item) => item.dueAt <= now).length,
      items: items
        .slice()
        .sort((a, b) => a.dueAt - b.dueAt)
        .map((item) => ({ id: item.id, events: item.eventIds.length, dueAt: item.dueAt, reason: item.reason })),
    };
  }
}
