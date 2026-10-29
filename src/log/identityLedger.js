/**
 * Identity ledger: occurrence counters + the IDEMPOTENCY INDEX.
 *
 * Two separate concerns live here, deliberately:
 *
 *   occurrences   how many identical (content_hash, event_time) records already
 *                 exist in the log. The next one gets the next integer, so a second
 *                 genuine occurrence can never overwrite the first.
 *   idempotency   whether an inbound payload is a REPLAY of something already
 *                 stored. Answered by (content_hash + event_time) or by a client
 *                 supplied idempotency key — never by event_id (an id is identity,
 *                 not a dedupe token).
 *
 * The ledger is a derived cache: `rebuild(records)` reconstructs both maps from the
 * log alone, so deleting the file is safe and a crash cannot desynchronise it from
 * the truth source. It is persisted after each append for fast startup only.
 */

import { MemoryError, ErrorCodes } from '../errors.js';
import { appendLineDurable, readJson, readJsonLines, writeJsonAtomic } from '../util.js';
import { normaliseEventTime, occurrenceKeyOf } from '../identity.js';

const LEDGER_VERSION = 1;

export class IdentityLedger {
  /** @param {{file: string}} opts */
  constructor({ file }) {
    this.file = file;
    this._occurrences = new Map(); // "<contentHash>|<eventTime>" -> next index
    this._idempotency = new Map(); // dedupe key -> eventId
    this._dirty = false;
  }

  /** Rebuild both maps from log records; persisted state is never trusted blindly. */
  rebuild(records) {
    this._occurrences = new Map();
    this._idempotency = new Map();
    for (const record of records) {
      if (record.type !== 'episode') continue;
      this._observe(record);
    }
    this._dirty = true;
    return this.status();
  }

  /** Fold one appended episode into the in-memory ledger (append path). */
  _observe(record) {
    const key = occurrenceKeyOf({ contentHash: record.content_hash, eventTime: record.event_time });
    const next = Math.max(this._occurrences.get(key) ?? 0, (record.occurrence_index ?? 0) + 1);
    this._occurrences.set(key, next);
    if (record.idempotency_key) this._idempotency.set(record.idempotency_key, record.event_id);
    this._idempotency.set(`c:${record.content_hash}|${normaliseEventTime(record.event_time)}`, record.event_id);
  }

  observe(record) {
    this._observe(record);
    this._dirty = true;
  }

  /** Peek the occurrence index the NEXT identical payload would receive. */
  nextOccurrence({ contentHash, eventTime }) {
    return this._occurrences.get(occurrenceKeyOf({ contentHash, eventTime })) ?? 0;
  }

  allocate({ contentHash, eventTime }) {
    const key = occurrenceKeyOf({ contentHash, eventTime });
    const index = this._occurrences.get(key) ?? 0;
    this._occurrences.set(key, index + 1);
    this._dirty = true;
    return index;
  }

  /** Independent dedupe lookup. Returns an event id or null — never throws on a miss. */
  lookup(key) {
    if (!key) return null;
    return this._idempotency.get(key) ?? null;
  }

  register(key, eventId) {
    if (!key) return;
    this._idempotency.set(key, eventId);
    this._dirty = true;
  }

  /** Persist for fast startup. The log stays the truth source. */
  persist() {
    if (!this._dirty) return;
    writeJsonAtomic(this.file, {
      v: LEDGER_VERSION,
      occurrences: Object.fromEntries(this._occurrences),
      idempotency: Object.fromEntries(this._idempotency),
    });
    this._dirty = false;
  }

  /** Load the persisted hint; the caller then calls rebuild(records) to verify it. */
  loadHint() {
    const stored = readJson(this.file, null);
    if (!stored || stored.v !== LEDGER_VERSION) return false;
    this._occurrences = new Map(Object.entries(stored.occurrences ?? {}));
    this._idempotency = new Map(Object.entries(stored.idempotency ?? {}));
    return true;
  }

  status() {
    return { occurrences: this._occurrences.size, idempotency: this._idempotency.size };
  }
}

/**
 * Tombstone registry: durable, append-only record of events that must never come
 * back. It lives BESIDE the log, not inside it, on purpose — a purge rewrites the
 * log and drops the forget record with the episode, so a rebuild that only scanned
 * the log could resurrect the deleted event. The registry is the wall.
 */
export class TombstoneStore {
  constructor({ file }) {
    this.file = file;
    this._tombstones = new Map(); // eventId -> {reason, mode, at, job}
  }

  /** Fold an append-only journal (`tombstone` / `untombstone` lines). */
  load() {
    const rows = readJsonLines(this.file);
    this._tombstones = new Map();
    for (const { value } of rows) {
      if (!value || typeof value !== 'object') continue;
      if (value.op === 'tombstone' && typeof value.event_id === 'string') {
        this._tombstones.set(value.event_id, {
          reason: value.reason ?? 'unspecified',
          mode: value.mode ?? 'purge',
          at: value.at ?? null,
          job: value.job ?? null,
        });
      } else if (value.op === 'untombstone') {
        this._tombstones.delete(value.event_id);
      }
    }
    return this;
  }

  /**
   * Merge tombstones folded out of the log itself (forget records). This keeps a
   * delete visible even if the registry file was lost, and keeps `restore` honest.
   */
  mergeFolded(folded) {
    for (const [eventId, meta] of folded ?? []) {
      if (!this._tombstones.has(eventId)) this._tombstones.set(eventId, meta);
    }
    return this;
  }

  has(eventId) {
    return this._tombstones.has(eventId);
  }

  get(eventId) {
    return this._tombstones.get(eventId) ?? null;
  }

  ids() {
    return new Set(this._tombstones.keys());
  }

  entries() {
    return [...this._tombstones.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  size() {
    return this._tombstones.size;
  }

  /** Record the intent BEFORE the destructive phase, so a crash cannot resurrect. */
  mark({ eventId, reason = 'unspecified', mode = 'purge', at, job = null }) {
    if (this._tombstones.has(eventId)) return false;
    appendLineDurable(
      this.file,
      `${JSON.stringify({ op: 'tombstone', event_id: eventId, reason, mode, at, job })}\n`,
    );
    this._tombstones.set(eventId, { reason, mode, at, job });
    return true;
  }

  /** Explicit restore: removes the tombstone (an undo is a new fact, not an edit). */
  unmark({ eventId, at, reason = 'restore' }) {
    if (!this._tombstones.has(eventId)) return false;
    appendLineDurable(this.file, `${JSON.stringify({ op: 'untombstone', event_id: eventId, at, reason })}\n`);
    this._tombstones.delete(eventId);
    return true;
  }

  snapshot() {
    return Object.fromEntries(this.entries());
  }
}

/**
 * Dead-letter queue for records that cannot become events (empty content, missing
 * identity). They are counted with their own occurrence index so two broken inputs
 * never collapse into one — the same no-overwrite rule as the main log.
 */
export class DeadLetterQueue {
  constructor({ file, clock }) {
    this.file = file;
    this.clock = clock;
    this._rows = [];
  }

  load() {
    this._rows = readJsonLines(this.file).map((row) => row.value);
    return this;
  }

  append({ payload, reason, contentHash, occurrenceIndex }) {
    const row = {
      v: 1,
      type: 'dead_letter',
      content_hash: contentHash,
      occurrence_index: occurrenceIndex,
      reason,
      payload: { content: String(payload?.content ?? '').slice(0, 2000), tags: payload?.tags ?? [] },
      log_time: this.clock.now(),
    };
    appendLineDurable(this.file, `${JSON.stringify(row)}\n`);
    this._rows.push(row);
    return row;
  }

  list() {
    return this._rows.slice();
  }

  size() {
    return this._rows.length;
  }
}

export function assertLedgerFile(file) {
  if (typeof file !== 'string' || !file) {
    throw new MemoryError(ErrorCodes.INVALID_CONFIG, 'identity ledger needs a file path');
  }
}
