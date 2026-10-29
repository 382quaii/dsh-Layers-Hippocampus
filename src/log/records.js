/**
 * Raw log layer: record shapes and (de)serialisation.
 *
 * Records are append-only JSONL. A record is never mutated after it is written;
 * corrections are new records (`restore` cancels a `forget`). This is the ONLY
 * truth source in the system — every index, diary cover, active set and retrieval
 * result is derived and can be rebuilt.
 *
 * Required fields on every episode record:
 *   event_id        content-addressed identity of ONE occurrence
 *                   = hash(content_hash + event_time + occurrence_index)
 *   entity_id       the subject the record is about (stable across revisions)
 *   content_hash    canonical payload hash (equivalence, NOT identity)
 *   occurrence_index disambiguates identical payloads at the same instant
 *   event_time      when it happened — from the payload or derived from content
 *   log_time        when it was recorded (injected clock; never hashed)
 *   content         the memory itself
 *   salience        0..1 importance
 */

import { MemoryError, ErrorCodes, invalidInput } from '../errors.js';
import { clamp01, sha256 } from '../util.js';
import { normaliseTagToken } from '../policy.js';
import {
  assertEventId,
  canonicaliseString,
  contentHashOf,
  eventIdFor,
  entityIdFor,
  idempotencyKeyOf,
  isControlId,
  isEventId,
  resolveEventTime,
} from '../identity.js';

export const RECORD_VERSION = 2;

export const RECORD_TYPES = Object.freeze({
  EPISODE: 'episode',
  REINFORCE: 'reinforce',
  FORGET: 'forget',
  RESTORE: 'restore',
});

export const MAX_CONTENT_CHARS = 20_000;

export { isEventId, assertEventId };

/**
 * Accepts `["a","b"]` or `[{tag:"a",strength:0.7}]` (or a mix) and returns
 * `[{tag, strength}]` with normalised tokens, deduplicated by max strength.
 * Tag ORDER is canonical (sorted) so it can never perturb the content hash.
 */
export function normaliseTags(input) {
  if (input === undefined || input === null) return [];
  const raw = Array.isArray(input) ? input : [input];
  const byTag = new Map();
  for (const item of raw) {
    let tag;
    let strength = 0.7;
    if (typeof item === 'string') {
      tag = normaliseTagToken(item);
    } else if (item && typeof item === 'object') {
      tag = normaliseTagToken(item.tag);
      if (item.strength !== undefined) {
        const s = Number(item.strength);
        if (!Number.isFinite(s) || s < 0 || s > 1) {
          throw invalidInput('tag strength must be within [0,1]', { tag, strength: item.strength });
        }
        strength = s;
      }
    }
    if (!tag) continue;
    const prev = byTag.get(tag);
    byTag.set(tag, { tag, strength: prev ? Math.max(prev.strength, strength) : strength });
  }
  return [...byTag.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw invalidInput('payload must be an object');
  const content = payload.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw invalidInput('content must be a non-empty string');
  }
  const canonical = canonicaliseString(content);
  if (canonical.length > MAX_CONTENT_CHARS) {
    throw invalidInput(`content must be at most ${MAX_CONTENT_CHARS} characters`, { length: canonical.length });
  }
  const salience = payload.salience === undefined ? 0.5 : Number(payload.salience);
  if (!Number.isFinite(salience) || salience < 0 || salience > 1) {
    throw invalidInput('salience must be within [0,1]', { salience: payload.salience });
  }
  return { content: canonical, salience: clamp01(salience), tags: normaliseTags(payload.tags) };
}

/**
 * Build an episode record. Identity inputs are resolved by the caller (ingest.js)
 * so this function stays a pure shape builder and is trivially replayable.
 *
 * @param {object} input
 * @param {object} input.payload raw caller payload
 * @param {number} input.eventTime resolved epoch ms
 * @param {string} input.timeSource 'caller' | 'content' | 'ingest'
 * @param {string} input.contentHash canonical payload hash
 * @param {number} input.occurrenceIndex same payload+time occurrence counter
 * @param {string} [input.entityKey] explicit subject key
 * @param {string|null} [input.idempotencyKey]
 * @param {boolean} [input.timeUncertain] true when event_time was NOT a claim about
 *                 when it happened (content policy, no literal date in the text)
 * @param {number} input.logTime injected clock reading
 */
export function buildEpisode({
  payload,
  eventTime,
  timeSource,
  contentHash,
  occurrenceIndex,
  entityKey = null,
  idempotencyKey = null,
  timeUncertain = false,
  logTime,
  entityId = null,
}) {
  const { content, salience, tags } = validatePayload(payload);
  const eventId = eventIdFor({ contentHash, eventTime, occurrenceIndex });
  if (entityId === null) entityId = entityIdFor({ entityKey, contentHash });
  const record = {
    v: RECORD_VERSION,
    type: RECORD_TYPES.EPISODE,
    event_id: eventId,
    entity_id: entityId,
    content_hash: contentHash,
    occurrence_index: occurrenceIndex,
    event_time: eventTime,
    time_source: timeSource,
    time_uncertain: timeUncertain === true,
    log_time: logTime,
    content,
    salience,
    tags: tags.map((t) => ({ tag: t.tag, strength: t.strength })),
  };
  if (idempotencyKey) record.idempotency_key = idempotencyKey;
  if (payload.meta && typeof payload.meta === 'object') record.meta = payload.meta;
  return record;
}

/** Compute the identity inputs for a payload WITHOUT writing anything. */
export function planEpisode({ payload, clock, policy }) {
  const contentHash = contentHashOf(payload);
  const { eventTime, timeSource } = resolveEventTime({ payload, contentHash, clock, policy });
  return { contentHash, eventTime, timeSource };
}

export function makeReinforce({ eventId, target, weight = 1, eventTime, logTime }) {
  assertEventId(target, 'target');
  const w = Number(weight);
  if (!Number.isFinite(w) || w <= 0) throw invalidInput('reinforcement weight must be positive', { weight });
  return {
    v: RECORD_VERSION,
    type: RECORD_TYPES.REINFORCE,
    event_id: eventId,
    target,
    weight: w,
    event_time: Number.isFinite(eventTime) ? Math.trunc(eventTime) : Math.trunc(logTime),
    log_time: Math.trunc(logTime),
  };
}

export function makeForget({ eventId, target, reason = 'unspecified', mode = 'purge', logTime }) {
  assertEventId(target, 'target');
  if (mode !== 'purge' && mode !== 'archive') throw invalidInput('mode must be "purge" or "archive"', { mode });
  return {
    v: RECORD_VERSION,
    type: RECORD_TYPES.FORGET,
    event_id: eventId,
    target,
    reason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : 'unspecified',
    mode,
    event_time: Math.trunc(logTime),
    log_time: Math.trunc(logTime),
  };
}

export function makeRestore({ eventId, target, reason = 'manual restore', logTime }) {
  assertEventId(target, 'target');
  return {
    v: RECORD_VERSION,
    type: RECORD_TYPES.RESTORE,
    event_id: eventId,
    target,
    reason: String(reason).slice(0, 200),
    event_time: Math.trunc(logTime),
    log_time: Math.trunc(logTime),
  };
}

/** Serialise with a fixed key order so identical records produce identical bytes. */
export function serialiseRecord(record) {
  return JSON.stringify(record);
}

export function recordDigest(record) {
  return sha256(serialiseRecord(record));
}

/**
 * Parse one log line. Unknown record types are tolerated (forward compatibility:
 * a newer writer must not make an older reader refuse the whole log), but a
 * malformed episode is a hard error — silently skipping it would corrupt recall.
 *
 * @param {string} raw
 * @param {{segment?: string, line?: number}} [where]
 */
export function parseRecord(raw, where = {}) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MemoryError(ErrorCodes.LOG_CORRUPT, 'log line is not valid JSON', where);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new MemoryError(ErrorCodes.LOG_CORRUPT, 'log line must be a JSON object', where);
  }
  if (!isEventId(parsed.event_id) && !isControlId(parsed.event_id)) {
    throw new MemoryError(ErrorCodes.LOG_CORRUPT, 'log record has no valid event_id', {
      ...where,
      record: parsed.type,
    });
  }
  if (!Number.isFinite(parsed.log_time)) {
    throw new MemoryError(ErrorCodes.LOG_CORRUPT, 'log record has no valid log_time', {
      ...where,
      record: parsed.type,
    });
  }
  if (parsed.type === RECORD_TYPES.EPISODE) {
    if (!Number.isFinite(parsed.event_time)) {
      throw new MemoryError(ErrorCodes.LOG_CORRUPT, 'episode has no valid event_time', where);
    }
    if (typeof parsed.content !== 'string' || !parsed.content.length) {
      throw new MemoryError(ErrorCodes.LOG_CORRUPT, 'episode has no content', where);
    }
    if (parsed.v >= 2) {
      if (typeof parsed.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.content_hash)) {
        throw new MemoryError(ErrorCodes.LOG_CORRUPT, 'episode has no valid content_hash', where);
      }
      if (!Number.isInteger(parsed.occurrence_index) || parsed.occurrence_index < 0) {
        throw new MemoryError(ErrorCodes.LOG_CORRUPT, 'episode has no valid occurrence_index', where);
      }
      if (parsed.time_uncertain !== undefined && typeof parsed.time_uncertain !== 'boolean') {
        throw new MemoryError(ErrorCodes.LOG_CORRUPT, 'episode time_uncertain must be a boolean', where);
      }
      // Identity must be a pure function of its declared inputs; verify instead of
      // trusting. A hand-edited line cannot smuggle in an id it did not earn.
      const expected = eventIdFor({
        contentHash: parsed.content_hash,
        eventTime: parsed.event_time,
        occurrenceIndex: parsed.occurrence_index,
      });
      if (expected !== parsed.event_id) {
        throw new MemoryError(ErrorCodes.LOG_CORRUPT, 'episode event_id does not match its identity inputs', {
          ...where,
          expected,
        });
      }
    }
  }
  if (
    parsed.type === RECORD_TYPES.REINFORCE ||
    parsed.type === RECORD_TYPES.FORGET ||
    parsed.type === RECORD_TYPES.RESTORE
  ) {
    if (!isEventId(parsed.target)) {
      throw new MemoryError(ErrorCodes.LOG_CORRUPT, `${parsed.type} record has no valid target`, where);
    }
  }
  return parsed;
}

/** Convenience: the dedupe key an episode advertises. */
export function dedupeKeyFor(record) {
  return idempotencyKeyOf({ contentHash: record.content_hash, eventTime: record.event_time });
}
