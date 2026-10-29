/**
 * Identity layer: canonicalisation, content hashing, event ids, entity ids.
 *
 * Three DIFFERENT identities, never interchangeable:
 *
 *   entity_id     what the fact is ABOUT. Survives revisions: two records that
 *                 restate the same subject share an entity_id and the newer one
 *                 supersedes the older without either changing identity.
 *   event_id      one OCCURRENCE of the fact at one instant:
 *                 hash(content_hash + event_time + occurrence_index).
 *   content_hash  payload equivalence: two records with the same content_hash are
 *                 the same claim, whatever their spelling, key order, whitespace,
 *                 numeric form (1.0 vs 1) or full/half-width characters.
 *
 * Why this split exists:
 *   - event_id must be STABLE. It is a pure function of (payload, event_time,
 *     occurrence_index); no random value and no wall clock may enter it, or the
 *     same input produces a different id on every run and the log stops being
 *     replayable.
 *   - event_id must be UNIQUE per occurrence. Two identical payloads at the same
 *     instant get occurrence_index 0 and 1 — they must never overwrite each other.
 *   - event_id must NOT be the dedupe key. Deduplication is a separate concern with
 *     its own index (see log/identityLedger.js): "this payload at this time already
 *     exists" is answered by (content_hash, event_time), not by re-hashing an id.
 *
 * event_time discipline: it comes from the caller's payload, or is derived from the
 * content. It is NEVER assigned the ingest wall clock by default, because then two
 * replays of the same input would disagree. `policy.identity.eventTimePolicy` can
 * be set to 'ingest' to opt into clock-derived times, and every record then says so
 * in `time_source` so the provenance is visible instead of silent.
 */

import { MemoryError, ErrorCodes, invalidInput } from './errors.js';
import { sha256 } from './util.js';

export const IDENTITY_VERSION = 2;
export const CANON_VERSION = 1;

/** Content-hash span for content-derived event times: 400 days from MEMORY_EPOCH. */
export const MEMORY_EPOCH_MS = Date.UTC(2024, 0, 1);
export const DERIVED_TIME_SPAN_MS = 400 * 86_400_000;

/** Everything that counts as "the payload" for equivalence purposes. */
const KNOWN_PAYLOAD_KEYS = ['content', 'tags', 'salience', 'meta', 'entity'];

/**
 * Canonicalise a JSON-ish value.
 *
 *   strings   NFKC (ＡＢＣ -> ABC, ﬁ -> fi), collapse whitespace runs, trim
 *   numbers   1.0 -> 1, 1.50 -> 1.5, -0 -> 0; non-finite is rejected
 *   objects   keys sorted, undefined dropped
 *   arrays    order preserved (it is part of the meaning)
 */
export function canonicaliseValue(value) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string') return canonicaliseString(value);
  if (type === 'number') return canonicaliseNumber(value);
  if (type === 'boolean') return value;
  if (type === 'undefined') return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const canonical = canonicaliseValue(item);
      return canonical === undefined ? null : canonical;
    });
  }
  if (type === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const canonical = canonicaliseValue(value[key]);
      if (canonical !== undefined) out[key] = canonical;
    }
    return out;
  }
  throw invalidInput('value is not canonicalisable', { type });
}

export function canonicaliseString(text) {
  const normalized = String(text).normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return normalized;
}

export function canonicaliseNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw invalidInput('number must be finite', { value });
  if (Object.is(n, -0)) return 0;
  if (Number.isInteger(n)) return n === 0 ? 0 : n;
  // 1.50 and 1.5 must hash alike; 0.1+0.2 noise must not leak into identity.
  return Number(n.toFixed(12));
}

/** Stable stringification: sorted keys, canonical scalars, no whitespace. */
export function canonicalJson(value) {
  const canonical = canonicaliseValue(value);
  return JSON.stringify(canonical === undefined ? null : canonical);
}

/**
 * Build the canonical payload that content_hash covers.
 *
 * @param {{content?: string, tags?: Array<{tag: string, strength?: number}|string>,
 *          salience?: number, meta?: object, entity?: string}} payload
 */
export function canonicalPayload(payload = {}) {
  const content = canonicaliseString(payload.content ?? '');
  const tags = normaliseCanonicalTags(payload.tags ?? []);
  const salience = canonicaliseNumber(payload.salience === undefined ? 0.5 : payload.salience);
  const out = { content, tags, salience };
  if (payload.entity !== undefined && payload.entity !== null) {
    const entity = canonicaliseString(payload.entity);
    if (entity) out.entity = entity;
  }
  if (payload.meta && typeof payload.meta === 'object' && Object.keys(payload.meta).length > 0) {
    out.meta = canonicaliseValue(payload.meta);
  }
  return out;
}

function normaliseCanonicalTags(input) {
  const raw = Array.isArray(input) ? input : [input];
  const byTag = new Map();
  for (const item of raw) {
    let tag;
    let strength = 0.7;
    if (typeof item === 'string') tag = canonicaliseString(item).toLowerCase();
    else if (item && typeof item === 'object') {
      tag = canonicaliseString(item.tag ?? '').toLowerCase();
      if (item.strength !== undefined) strength = canonicaliseNumber(item.strength);
    }
    if (!tag) continue;
    byTag.set(tag, Math.max(strength, byTag.get(tag) ?? 0));
  }
  return [...byTag.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([tag, strength]) => [tag, strength]);
}

/** sha256 over the canonical payload. Equal claims -> equal hash, always. */
export function contentHashOf(payload) {
  return sha256(canonicalJson(canonicalPayload(payload)));
}

/** Dedupe key: payload equivalence at one instant. Independent of event_id. */
export function idempotencyKeyOf({ contentHash, eventTime, clientKey = null }) {
  if (clientKey) return `k:${canonicaliseString(clientKey)}`;
  return `c:${contentHash}|${normaliseEventTime(eventTime)}`;
}

export function normaliseEventTime(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^-?\d+$/.test(trimmed)) return Math.trunc(Number(trimmed));
    // A timestamp WITHOUT an offset is UTC by contract. `Date.parse` would read it
    // as local time, so "2026-10-28T10:00" would mean a different instant on every
    // machine — the exact non-determinism this layer exists to prevent.
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/.test(trimmed)) {
      const parsedUtc = Date.parse(`${trimmed.replace(' ', 'T')}Z`);
      return Number.isFinite(parsedUtc) ? parsedUtc : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

/** A literal ISO-8601 / slash date found in the content, else null. */
const CONTENT_DATE_PATTERNS = [
  /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?\b/u,
  /\b(\d{4})\/(\d{2})\/(\d{2})\b/u,
];

function validDateParts(year, month, day, hour = 0, minute = 0, second = 0) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * Pull a timestamp out of the content itself.
 *
 * Deliberately literal: only an explicit calendar date (with optional time) counts.
 * "yesterday" and "last week" are NOT resolved — guessing there would put a
 * non-deterministic value into identity. Returns null when nothing matches, and the
 * caller marks the record as time-uncertain instead of pretending.
 */
export function extractEventTimeFromContent(content) {
  if (typeof content !== 'string' || !content) return null;
  const text = canonicaliseString(content);
  for (const pattern of CONTENT_DATE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const [, year, month, day, hour = '0', minute = '0', second = '0', offset] = match;
    if (!validDateParts(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second))) {
      continue;
    }
    if (offset) {
      const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
      if (Number.isFinite(parsed)) return parsed;
      continue;
    }
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  }
  return null;
}

/**
 * Deterministic event time derived from the content hash.
 * No clock is consulted, so replaying identical input yields identical ids even
 * when the machine's wall clock differs.
 */
export function deriveEventTimeFromContent(contentHash) {
  const slice = String(contentHash).replace(/[^0-9a-f]/gi, '').slice(0, 13);
  const value = Number.parseInt(slice || '0', 16);
  return MEMORY_EPOCH_MS + (value % DERIVED_TIME_SPAN_MS);
}

/**
 * Resolve event_time under a declared policy.
 *
 *   'explicit' caller MUST supply it; missing is `MEM_E_EVENT_TIME_REQUIRED`
 *   'content'  extract a literal date from the content, else derive deterministically
 *              from the content hash AND mark the record `time_uncertain`
 *   'ingest'   use the injected clock (opt-in; record says time_source: 'ingest')
 */
export function resolveEventTime({ payload = {}, contentHash, clock, policy }) {
  const declared = policy?.identity?.eventTimePolicy ?? 'content';
  const supplied = normaliseEventTime(payload.event_time ?? payload.happened_at ?? payload.eventTime);
  if (supplied !== null) return { eventTime: supplied, timeSource: 'caller', timeUncertain: false };
  if (declared === 'explicit') {
    throw new MemoryError(
      ErrorCodes.EVENT_TIME_REQUIRED,
      "event_time is required by policy.identity.eventTimePolicy='explicit'",
      { hint: 'pass event_time / happened_at, or set the policy to "content"' },
    );
  }
  if (declared === 'ingest') {
    if (!clock || typeof clock.now !== 'function') {
      throw new MemoryError(ErrorCodes.CLOCK_INVALID, 'ingest time policy requires an injected clock');
    }
    return { eventTime: Math.trunc(clock.now()), timeSource: 'ingest', timeUncertain: false };
  }
  const extracted = extractEventTimeFromContent(payload.content);
  if (extracted !== null) {
    return { eventTime: extracted, timeSource: 'content', timeUncertain: false };
  }
  // No date in the text: the time is a deterministic function of the content hash,
  // which is replayable but NOT a claim about when it happened. The record carries
  // `time_uncertain: true` so recall and the status panel can say so.
  return { eventTime: deriveEventTimeFromContent(contentHash), timeSource: 'content', timeUncertain: true };
}

const EVENT_ID_RE = /^ev_[0-9a-f]{26}$/;
const ENTITY_ID_RE = /^en_[0-9a-f]{26}$/;
const CONTROL_ID_RE = /^(rf|fg|rs|dl|sm)_[0-9a-f]{26}$/;

export function isEventId(value) {
  return typeof value === 'string' && EVENT_ID_RE.test(value);
}

export function isEntityId(value) {
  return typeof value === 'string' && ENTITY_ID_RE.test(value);
}

export function assertEventId(value, label = 'event_id') {
  if (!isEventId(value)) {
    throw invalidInput(`${label} must be a content-addressed event id`, { value });
  }
  return value;
}

/** Occurrence index is part of identity: identical payloads at one instant differ. */
export function occurrenceKeyOf({ contentHash, eventTime }) {
  return `${contentHash}|${normaliseEventTime(eventTime)}`;
}

export function eventIdFor({ contentHash, eventTime, occurrenceIndex }) {
  if (!Number.isInteger(occurrenceIndex) || occurrenceIndex < 0) {
    throw invalidInput('occurrence_index must be a non-negative integer', { occurrenceIndex });
  }
  const eventTimeMs = normaliseEventTime(eventTime);
  if (eventTimeMs === null) throw invalidInput('event_time must be resolvable to epoch ms', { eventTime });
  const digest = sha256(`${contentHash}|${eventTimeMs}|${occurrenceIndex}`);
  return `ev_${digest.slice(0, 26)}`;
}

/**
 * Control records (reinforce / forget / restore / dead-letter) need ids too, and
 * they need the same determinism: no random, no wall clock.
 */
export function controlIdFor({ type, contentHash, eventTime, occurrenceIndex = 0 }) {
  const prefix = { reinforce: 'rf', forget: 'fg', restore: 'rs', dead_letter: 'dl', summary: 'sm' }[type];
  if (!prefix) throw invalidInput(`unknown control record type: ${type}`, { type });
  const time = normaliseEventTime(eventTime) ?? 0;
  const digest = sha256(`${type}|${contentHash}|${time}|${occurrenceIndex}`);
  return `${prefix}_${digest.slice(0, 26)}`;
}

/**
 * entity_id: what the record is about. Stable across revisions of the same subject.
 * Derived from an explicit entity key, else from the primary tag, else the content.
 */
export function entityIdFor({ entityKey = null, contentHash }) {
  const basis = entityKey ? `key:${canonicaliseString(entityKey).toLowerCase()}` : `content:${contentHash}`;
  return `en_${sha256(basis).slice(0, 26)}`;
}

export function isControlId(value) {
  return typeof value === 'string' && CONTROL_ID_RE.test(value);
}

/**
 * Idempotency decision for an inbound payload.
 * Returns { duplicate: true, eventId } only when the independent dedupe index hit.
 */
export function parseTimeOrNull(value) {
  return normaliseEventTime(value);
}
