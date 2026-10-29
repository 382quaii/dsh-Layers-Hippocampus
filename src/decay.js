/**
 * Decay and reinforcement.
 *
 * The forgetting curve is a *retrieval weight*, never a delete trigger. Deleting is
 * an explicit pipeline (see deletePipeline.js); this module only answers "how much
 * should this memory weigh right now?".
 *
 * Anchor rule (single rule for the whole system):
 *
 *   effective_time = max(event_time, last_reinforcement_time)
 *
 * `last_reinforcement_time` is NOT a stored field. It is derived from the log by
 * taking the latest `reinforce` record's `log_time` for that event_id. Storing it
 * would create a second truth source that can drift from the log.
 */

import { DAY_MS } from './clock.js';
import { clamp01, round } from './util.js';

/**
 * @param {object} input
 * @param {number} input.eventTime epoch ms
 * @param {number|null|undefined} input.lastReinforcedAt epoch ms or null
 * @returns {number} effective anchor, epoch ms
 */
export function effectiveTime({ eventTime, lastReinforcedAt }) {
  const anchor = Number.isFinite(lastReinforcedAt) ? Math.max(eventTime, lastReinforcedAt) : eventTime;
  return anchor;
}

/**
 * Exponential half-life decay.
 *
 *   decay = max(floor, 0.5 ^ (ageDays / halfLifeDays))
 *
 * @param {object} input
 * @param {number} input.eventTime
 * @param {number|null|undefined} input.lastReinforcedAt
 * @param {number} input.now query time (injected clock)
 * @param {number} input.halfLifeDays
 * @param {number} [input.floor] lower bound, keeps very old memories non-zero
 * @returns {number} 0..1
 */
export function decayFactor({ eventTime, lastReinforcedAt, now, halfLifeDays, floor = 0 }) {
  if (!Number.isFinite(eventTime)) return floor;
  const anchor = effectiveTime({ eventTime, lastReinforcedAt });
  const ageMs = Math.max(0, now - anchor);
  const ageDays = ageMs / DAY_MS;
  const halfLife = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : 30;
  const raw = 0.5 ** (ageDays / halfLife);
  return round(clamp01(Math.max(floor, raw)), 6);
}

/** Age in days since the effective anchor; used by reports and tests. */
export function ageDays({ eventTime, lastReinforcedAt, now }) {
  return round(Math.max(0, now - effectiveTime({ eventTime, lastReinforcedAt })) / DAY_MS, 3);
}
