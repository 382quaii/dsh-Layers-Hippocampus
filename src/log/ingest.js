/**
 * Ingest path: identity resolution + idempotency + dead-letter routing.
 *
 * Order is load-bearing and must not be rearranged:
 *
 *   1. canonicalise the payload            -> content_hash
 *   2. resolve event_time (payload/content/ingest policy)
 *   3. DEDUPE LOOKUP on (content_hash, event_time) / client key
 *         hit  -> return the existing event_id, write nothing
 *   4. validate; invalid -> dead-letter queue (counted, never overwrites)
 *   5. allocate occurrence_index (identical payload at the same instant)
 *   6. event_id = hash(content_hash + event_time + occurrence_index)
 *
 * Step 3 precedes step 5 on purpose: a replay must not consume an occurrence
 * number, or the log would drift away from a replay of the deduplicated stream.
 */

import { contentHashOf, idempotencyKeyOf, resolveEventTime } from '../identity.js';
import { buildEpisode } from './records.js';

function isBlank(value) {
  return typeof value !== 'string' || value.trim().length === 0;
}

/**
 * @param {object} input
 * @param {object} input.payload caller payload ({content, tags, salience, meta, entity,
 *                 event_time|happened_at})
 * @param {object} input.clock injected clock (never used for event_time by default)
 * @param {object} input.policy resolved policy
 * @param {import('./identityLedger.js').IdentityLedger} input.ledger
 * @param {import('./identityLedger.js').DeadLetterQueue|null} [input.dlq]
 * @param {boolean} [input.dedupe] dedupe on (content_hash, event_time) — default true
 * @param {string|null} [input.clientKey] client supplied idempotency key
 * @returns {{status:'duplicate'|'dead-letter'|'ready', eventId?:string, contentHash:string,
 *            eventTime:number, dedupeKey:string, record?:object, dlqId?:string, reason?:string}}
 */
export function ingestEpisode({ payload, clock, policy, ledger, dlq = null, dedupe = true, clientKey = null }) {
  const contentHash = contentHashOf(payload ?? {});
  const { eventTime, timeSource, timeUncertain = false } = resolveEventTime({
    payload: payload ?? {},
    contentHash,
    clock,
    policy,
  });
  const dedupeKey = idempotencyKeyOf({ contentHash, eventTime, clientKey });

  if (dedupe) {
    const existing = ledger.lookup(dedupeKey);
    if (existing) {
      return { status: 'duplicate', eventId: existing, contentHash, eventTime, dedupeKey, timeUncertain };
    }
  }

  // Invalid payloads are routed, not swallowed: an empty memory is still a signal
  // and it gets its own occurrence number so two empty inputs stay distinguishable.
  if (isBlank(payload?.content)) {
    if (!dlq) {
      return {
        status: 'dead-letter',
        contentHash,
        eventTime,
        dedupeKey,
        reason: 'content-empty',
        dlqId: null,
      };
    }
    const occurrenceIndex = ledger.allocate({ contentHash, eventTime });
    const row = dlq.append({ payload, reason: 'content-empty', contentHash, occurrenceIndex });
    return {
      status: 'dead-letter',
      contentHash,
      eventTime,
      dedupeKey,
      reason: 'content-empty',
      dlqId: `${row.content_hash}:${row.occurrence_index}`,
      occurrenceIndex,
    };
  }

  const occurrenceIndex = ledger.allocate({ contentHash, eventTime });
  const record = buildEpisode({
    payload,
    eventTime,
    timeSource,
    timeUncertain,
    contentHash,
    occurrenceIndex,
    entityKey: typeof payload?.entity === 'string' ? payload.entity : null,
    idempotencyKey: clientKey ? dedupeKey : null,
    logTime: Math.trunc(clock.now()),
  });

  ledger.register(dedupeKey, record.event_id);
  return {
    status: 'ready',
    record,
    eventId: record.event_id,
    entityId: record.entity_id,
    contentHash,
    eventTime,
    dedupeKey,
    occurrenceIndex,
    timeSource,
    timeUncertain,
  };
}
