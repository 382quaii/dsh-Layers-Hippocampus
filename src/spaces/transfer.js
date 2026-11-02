/**
 * Atomic cross-space transfer — the semantic layer of v1.5.0 multi-space.
 *
 * A space is its own memory root (log, index, state, semantic). Moving a memory
 * between spaces is therefore not an update: it is a NEW occurrence in the target
 * space. This module owns the three rules that make that safe:
 *
 *   1. PRIVACY SCREEN — a transfer may cross a trust boundary (personal space ->
 *      work space, shared space, another owner). Content that matches a
 *      privacy-sensitive pattern is refused BEFORE anything is written, and the
 *      matched bytes never leave this module (details carry ids/categories only).
 *   2. RAW-TURN STRIP — forensic raw turns (`raw_turn`, `raw_turn_id`, any `raw_*`
 *      meta key) are a local forensic layer and must not travel with the memory.
 *      The sanitised payload is a deep clone, so the source event is never mutated.
 *   3. ALL-OR-NOTHING DELETE — a `move` writes every event to the target first and
 *      only then parks the source ids in the two-phase delete queue. A partial
 *      target failure throws and leaves the source untouched: the queue is never
 *      asked to purge bytes the target does not have. The source is never
 *      physically purged here; that remains maintenance's job after the grace
 *      period (and is always cancellable with `restore`).
 *
 * This module deliberately imports nothing from `memory.js`: the facade imports
 * IT, so the dependency direction stays one-way (no cycle). It talks to the two
 * handles through the documented surface only:
 *   source.indexManager.snapshot() -> { events }
 *   source.logStore.snapshot()     -> { records }   (optional, for meta)
 *   source.pendingDeletes.request()
 *   target.remember()
 */

import { ErrorCodes, MemoryError } from '../errors.js';

/** The only legal transfer modes. `copy` retains the source; `move` queues it. */
export const TRANSFER_MODES = Object.freeze(['copy', 'move']);

/**
 * Privacy patterns, ordered from most specific to most generic. Categories are
 * stable English identifiers (they are rendered by the UI / tool result).
 *
 * Every pattern is global because the scanner masks matched spans as it goes:
 * that keeps overlapping detectors (an 18-digit CN id is also 18 digits) from
 * double-reporting, and makes the listed category order meaningful.
 *
 * @type {ReadonlyArray<{category: string, pattern: RegExp}>}
 */
export const PRIVACY_CATEGORIES = Object.freeze([
  // CN resident id: 6-digit region + YYYYMMDD + 3-digit sequence + digit/X check.
  // Structural (not length-only) so a random 18-digit bank card is not called an id.
  Object.freeze({
    category: 'cn-id-card',
    pattern: /(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g,
  }),
  // Mainland mobile number: 11 digits, 1 + 3-9 prefix.
  Object.freeze({ category: 'cn-mobile', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g }),
  // Bank card: 16-19 digits, allowing single spaces as visual grouping.
  Object.freeze({ category: 'bank-card', pattern: /(?<!\d)(?:\d[ ]?){15,18}\d(?!\d)/g }),
  Object.freeze({ category: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g }),
  // Assignment-shaped credentials only: the word "token budget" must not block,
  // "token: abcd1234" must. This is why the separator group is mandatory.
  Object.freeze({
    category: 'credential-assignment',
    pattern: /(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)\s*[:：=]\s*\S+/gi,
  }),
  Object.freeze({ category: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g }),
  // A 120+ character base64-alphabet run is pasted key material, not prose. The
  // 120 threshold mirrors the raw store's existing secret heuristic.
  Object.freeze({
    category: 'inline-base64-secret',
    pattern: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{120,}={0,2}(?![A-Za-z0-9+/=])/g,
  }),
]);

/** Meta keys that are ALWAYS stripped, on top of the `raw_` prefix rule. */
const STRIPPED_META_KEYS = new Set(['raw_turn', 'rawTurn', 'raw_turn_id', 'rawTurnId']);

function isStrippedKey(key) {
  return STRIPPED_META_KEYS.has(key) || key.startsWith('raw_');
}

/**
 * Scan one text for privacy-sensitive content.
 *
 * Returns only the verdict: `{ blocked, categories }`. The matched text is never
 * returned (not even a snippet), so a caller cannot accidentally log the secret
 * it just refused to move.
 *
 * Matched spans are masked before the next pattern runs, so a value is reported
 * under its most specific category and never twice.
 *
 * @param {unknown} text
 * @returns {{blocked: boolean, categories: string[]}}
 */
export function scanPrivacy(text) {
  const source = String(text ?? '');
  if (!source) return { blocked: false, categories: [] };
  const categories = [];
  let working = source;
  for (const { category, pattern } of PRIVACY_CATEGORIES) {
    // Fresh instance: a shared global RegExp would carry lastIndex between calls.
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const regex = new RegExp(pattern.source, flags);
    let hit = false;
    working = working.replace(regex, (match) => {
      hit = true;
      return ' '.repeat(match.length);
    });
    if (hit) categories.push(category);
  }
  return { blocked: categories.length > 0, categories };
}

/**
 * Deep-clone meta while dropping the forensic raw-turn layer.
 *
 * Dropped: the exact keys `raw_turn` / `rawTurn` / `raw_turn_id` / `rawTurnId`
 * and ANY key starting with `raw_`, at the top level and at every nesting level.
 * Each removed location is recorded as a dotted path (`nested.raw_turn_id`,
 * `items[0].raw_turn`) so the caller can report HOW MUCH was stripped without
 * echoing the stripped values.
 *
 * `null` / `undefined` -> `{ meta: null, stripped: [] }`. Plain objects and
 * arrays are cloned; the input is never mutated.
 *
 * @param {unknown} meta
 * @returns {{meta: object|array|null, stripped: string[]}}
 */
export function sanitiseTransferMeta(meta) {
  if (meta === null || meta === undefined) return { meta: null, stripped: [] };
  const stripped = [];
  const seen = new WeakSet();
  const clone = (value, path) => {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return null; // cyclic meta cannot be represented as JSON
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item, index) => clone(item, `${path}[${index}]`));
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value; // Date/Map/... left as-is
    const out = {};
    for (const key of Object.keys(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (isStrippedKey(key)) {
        stripped.push(childPath);
        continue;
      }
      out[key] = clone(value[key], childPath);
    }
    return out;
  };
  return { meta: clone(meta, ''), stripped };
}

/**
 * Project a source index event onto a `target.remember()` payload.
 *
 * The two transfer tags are what make a copied memory traceable across spaces:
 *   transferred:from:<sourceSpaceId>
 *   transferred:to:<targetSpaceId>
 * They also guarantee a different content hash from the source event, hence a
 * freshly generated target event id (identity is content-addressed).
 *
 * @param {object} input
 * @param {object} input.event index event projection ({content, tags, salience, ...})
 * @param {string} [input.targetSpaceId]
 * @param {string} [input.sourceSpaceId]
 */
export function buildTransferRecord({ event, targetSpaceId = 'default', sourceSpaceId = 'default' } = {}) {
  if (!event || typeof event.content !== 'string') {
    throw new MemoryError(ErrorCodes.INVALID_INPUT, 'transfer requires an event with string content', {
      eventId: event?.eventId ?? null,
      got: event === null || event === undefined ? event : typeof event.content,
    });
  }
  const original = Array.isArray(event.tags) ? event.tags : [];
  const tags = [
    ...new Set([
      ...original
        .map((tag) => (tag && typeof tag === 'object' ? tag.tag : tag))
        .filter((tag) => typeof tag === 'string' && tag.trim())
        .map((tag) => tag.trim()),
      `transferred:from:${sourceSpaceId}`,
      `transferred:to:${targetSpaceId}`,
    ]),
  ];
  const { meta } = sanitiseTransferMeta(event.meta);
  // The index projection exposes the DERIVED entity id (an `en_*` handle), not the
  // caller's entity key. Forwarding it as the entity key keeps every transferred
  // occurrence of one subject grouped in the target space; an explicit `entity`
  // on the event (unit-level callers) wins unchanged.
  const entity =
    typeof event.entity === 'string' && event.entity.trim()
      ? event.entity
      : typeof event.entityId === 'string' && event.entityId.trim()
        ? event.entityId
        : null;
  const eventTime = Number.isFinite(event.eventTime)
    ? event.eventTime
    : Number.isFinite(event.anchorTime)
      ? event.anchorTime
      : undefined;
  return {
    content: event.content,
    tags,
    salience: Number.isFinite(event.salience) ? event.salience : 0.5,
    eventTime,
    entity,
    meta,
  };
}

/**
 * Read the source log once and attach `meta` to snapshot events.
 *
 * The index projection is a scoring projection: it deliberately carries no
 * `meta`. The privacy screen and the raw-turn strip are DEFINED on meta, so a
 * transfer must look at the truth source to see it. Events already carrying meta
 * (unit-level callers, future projections) are left untouched.
 *
 * @param {object} source memory-like handle
 * @param {object[]} events resolved index events
 * @returns {Promise<object[]>}
 */
async function withSourceMeta(source, events) {
  if (typeof source?.logStore?.snapshot !== 'function') return events;
  if (events.every((event) => event.meta !== undefined)) return events;
  const snapshot = await source.logStore.snapshot();
  const byId = new Map();
  for (const record of snapshot?.records ?? []) {
    if (record?.type === 'episode' && record.meta !== undefined && record.meta !== null) {
      byId.set(record.event_id, record.meta);
    }
  }
  return events.map((event) => {
    if (event.meta !== undefined) return event;
    const meta = byId.get(event.eventId);
    return meta === undefined ? event : { ...event, meta };
  });
}

function transferError(error, { written, failedId, targetSpaceId }) {
  const code =
    error instanceof MemoryError
      ? error.code
      : typeof error?.code === 'string' && error.code.startsWith('MEM_E_')
        ? error.code
        : ErrorCodes.IO;
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new MemoryError(code, `cross-space transfer failed: ${message}`, {
    written: [...written],
    failedId,
    targetSpaceId,
  });
  wrapped.cause = error;
  return wrapped;
}

/**
 * Transfer events between two already-open spaces.
 *
 * Order is load-bearing:
 *   validate mode/ids -> resolve events -> PRIVACY SCREEN -> write target ->
 *   (move only) park source deletes -> return.
 * Nothing is written and no delete is parked until every check passed, so a
 * refused transfer leaves both spaces byte-identical.
 *
 * @param {object} input
 * @param {object} input.source Memory-like source handle
 * @param {object} input.target Memory-like target handle
 * @param {string[]} input.eventIds ids in the source space
 * @param {string} [input.targetSpaceId]
 * @param {string} [input.sourceSpaceId]
 * @param {'copy'|'move'} [input.transferMode]
 * @param {object} [input.clock] accepted for deterministic callers; the queue owns the clock
 * @param {number} [input.graceHours] delay before a moved source may be purged
 * @param {number} [input.now] accepted for deterministic callers; see clock
 */
export async function transferBetweenSpaces({
  source,
  target,
  eventIds,
  targetSpaceId = 'default',
  sourceSpaceId = 'default',
  transferMode = 'copy',
  clock,
  graceHours = 24,
  now,
} = {}) {
  if (!TRANSFER_MODES.includes(transferMode)) {
    throw new MemoryError(
      ErrorCodes.INVALID_INPUT,
      `transferMode must be one of ${TRANSFER_MODES.join(' | ')}`,
      { allowed: [...TRANSFER_MODES], got: transferMode },
    );
  }
  const ids = [
    ...new Set(
      (Array.isArray(eventIds) ? eventIds : [])
        .filter((id) => typeof id === 'string' && id.trim())
        .map((id) => id.trim()),
    ),
  ];
  if (ids.length === 0) {
    throw new MemoryError(ErrorCodes.INVALID_INPUT, 'eventIds must be a non-empty array of event ids');
  }
  if (!source || typeof source.indexManager?.snapshot !== 'function') {
    throw new MemoryError(ErrorCodes.INVALID_INPUT, 'transfer requires an open source space');
  }
  if (!target || typeof target.remember !== 'function') {
    throw new MemoryError(ErrorCodes.INVALID_INPUT, 'transfer requires an open target space');
  }

  // ---- resolve (read-only) ------------------------------------------------
  const snapshot = source.indexManager.snapshot();
  const byId = new Map((snapshot?.events ?? []).map((event) => [event.eventId, event]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    // Tombstoned events are absent from the index projection by design, so a
    // forgotten id surfaces here as "unknown" instead of traveling as a ghost.
    throw new MemoryError(ErrorCodes.NOT_FOUND, 'cannot transfer unknown event ids', { missing });
  }
  const events = await withSourceMeta(
    source,
    ids.map((id) => byId.get(id)),
  );

  // ---- privacy screen (before ANY write / park) ---------------------------
  const blockedIds = [];
  const categories = new Set();
  for (const event of events) {
    const verdict = scanPrivacy(`${event.content}\n${JSON.stringify(event.meta ?? null)}`);
    if (!verdict.blocked) continue;
    blockedIds.push(event.eventId);
    for (const category of verdict.categories) categories.add(category);
  }
  if (blockedIds.length > 0) {
    throw new MemoryError(ErrorCodes.PRIVACY_BLOCKED, 'transfer blocked: privacy-sensitive content detected', {
      ids: blockedIds,
      categories: [...categories].sort(),
    });
  }

  // ---- write target (all events, or the transfer fails) -------------------
  const targetEventIds = [];
  const tagSet = new Set();
  let strippedRawTurn = 0;
  let failingId = null;
  try {
    for (const event of events) {
      failingId = event.eventId;
      strippedRawTurn += sanitiseTransferMeta(event.meta).stripped.length;
      const payload = buildTransferRecord({ event, targetSpaceId, sourceSpaceId });
      for (const tag of payload.tags) tagSet.add(tag);
      // dedupe:false = a genuine second occurrence: the target mints its own
      // occurrence_index and event id, so the target id can never equal the
      // source id (identity is content-addressed). idempotencyKey:null keeps a
      // stale client key from collapsing two copies into one.
      const result = await target.remember({ ...payload, dedupe: false, idempotencyKey: null });
      if (result?.status !== 'appended') {
        throw new MemoryError(ErrorCodes.INVALID_INPUT, 'target space refused the transferred event', {
          reason: result?.reason ?? result?.status ?? null,
        });
      }
      targetEventIds.push(result.eventId);
    }
  } catch (error) {
    // All-or-nothing for DELETION: nothing has been parked, and a physical purge
    // is never issued from here. The already-written target records stay (they
    // are ordinary episodes); the caller can retry or clean them up.
    throw transferError(error, { written: targetEventIds, failedId: failingId, targetSpaceId });
  }

  const targetView = {
    spaceId: targetSpaceId,
    eventIds: targetEventIds,
    count: targetEventIds.length,
    tags: [...tagSet].sort(),
    strippedRawTurn,
  };

  if (transferMode === 'copy') {
    return {
      mode: 'copy',
      source: { spaceId: sourceSpaceId, eventIds: ids, state: 'retained' },
      target: targetView,
      blocked: [],
    };
  }

  // ---- move: park the source ids ONLY after every target write succeeded ---
  // `now` is the caller's deterministic instant; the queue stamps the request with
  // the source space's own clock, so both views agree without extra plumbing.
  const effectiveGraceHours = Math.max(1, Number.isFinite(graceHours) ? Number(graceHours) : 24);
  void clock;
  void now;
  const pending = source.pendingDeletes.request({
    eventIds: ids,
    mode: 'purge',
    reason: `space-transfer:${targetSpaceId}`,
    graceHours: effectiveGraceHours,
  });
  return {
    mode: 'move',
    source: {
      spaceId: sourceSpaceId,
      eventIds: ids,
      state: 'pending_delete',
      pending,
      dueAt: pending.dueAt,
      graceHours: effectiveGraceHours,
    },
    target: targetView,
    blocked: [],
  };
}
