/**
 * v1.6.3 — real context-window guard (pure functions).
 *
 * The 2026-11-14 incident: a request carried 854,668 message tokens and reserved
 * 256,000 completion tokens (`DEFAULT_MAX_TOKENS` of the llm-deepseek provider).
 * 854,668 + 256,000 = 1,110,668 > 1,048,576, so the provider answered
 * `CONTEXT_WINDOW_EXCEEDED` — after the prompt was already paid for. The memory
 * plugin had been measuring the session against `context.nativeTokenLimit: 8000`
 * (a hand-written config value), i.e. against the wrong denominator entirely, and
 * it never reserved room for the completion.
 *
 * This module is deliberately dependency-free and synchronous: it takes numbers in
 * and returns a decision. The HOST half (service probes) lives in index.js; the
 * engine asks for those numbers through injected callbacks.
 */

/** Where the effective window came from. Surfaced so a panel can explain itself. */
export const WINDOW_SOURCE = Object.freeze({ HOST: 'host', CONFIG: 'config', DEFAULT: 'default' });

/**
 * Pick the denominator for every pressure calculation.
 *
 * Precedence: the model's REAL window (host adapter) always wins; the config value
 * is demoted to a user override that only applies when the host cannot answer (an
 * older host, a test double, a headless CLI). This is the whole point of the fix:
 * `context.nativeTokenLimit` must never be able to masquerade as the real window.
 *
 * @param {{ hostWindow?: number|null, configuredWindow?: number|null, fallback?: number }} input
 * @returns {{ window: number, source: string, hostWindow: number|null, configuredWindow: number|null }}
 */
export function resolveWindow({ hostWindow = null, configuredWindow = null, fallback = 8000 } = {}) {
  const host = positive(hostWindow);
  const configured = positive(configuredWindow);
  const base = positive(fallback) ?? 8000;
  const window = host ?? configured ?? base;
  const source = host !== null ? WINDOW_SOURCE.HOST : configured !== null ? WINDOW_SOURCE.CONFIG : WINDOW_SOURCE.DEFAULT;
  return { window, source, hostWindow: host, configuredWindow: configured };
}

/**
 * The ONE request-pressure calculation.
 *
 * `projected` is what the provider will actually be billed for: the prompt plus the
 * output budget the request reserves. Measuring only the prompt is what let a
 * "comfortable" 60% prompt turn into an over-window request.
 *
 * @param {object} input
 * @param {number} input.usedTokens         prompt-side occupancy (host-reported when available)
 * @param {number} [input.reservedTokens]   completion budget the request reserves
 * @param {number} input.window             real model window
 * @param {number} [input.threshold]        handoff trigger fraction (default 0.85)
 * @returns {object} an immutable decision record
 */
export function requestPressure({ usedTokens, reservedTokens = 0, window, threshold = 0.85 }) {
  const used = clampCount(usedTokens);
  const reserved = clampCount(reservedTokens);
  const limit = positive(window) ?? 8000;
  const ratio = round4(used / limit);
  const projected = used + reserved;
  const projectedRatio = round4(projected / limit);
  const trigger = Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : 0.85;
  const handoffAt = Math.round(trigger * limit);
  return {
    usedTokens: used,
    reservedTokens: reserved,
    projectedTokens: projected,
    window: limit,
    threshold: trigger,
    ratio,
    projectedRatio,
    handoffAtTokens: handoffAt,
    /** The handoff point is reached by prompt + reserved output. */
    handoffDue: projected >= handoffAt,
    /** The request provably cannot fit: block it locally instead of paying for a rejection. */
    hardExceeded: projected >= limit,
    /** Room left before the handoff point (never negative). */
    remainingTokens: Math.max(0, handoffAt - projected),
    /** Room left before the hard limit (never negative). */
    remainingToLimit: Math.max(0, limit - projected),
  };
}

function positive(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function clampCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * How much a handoff marker may be "topped up" before it must be re-distilled.
 *
 * v1.6.3 removed the `autoNewSession` controller, so a conversation keeps its
 * session id across a handoff. The old `if (marker.active) return` therefore froze
 * the state machine forever after the FIRST handoff. Re-handing-off inside the same
 * conversation is allowed once pressure grew this much past the marker's own ratio
 * (5 percentage points) — enough to mean "real growth", small enough to stay useful.
 */
export const REHANDOFF_DELTA = 0.05;

/**
 * Decide whether an ACTIVE marker must be re-distilled in the same conversation.
 *
 * @param {{ markerRatio?: number|null, projectedRatio: number, sameSession: boolean }} input
 * @returns {{ rehandoff: boolean, reason: string }}
 */
export function rehandoffDecision({ markerRatio = null, projectedRatio = 0, sameSession = true }) {
  if (!sameSession) return { rehandoff: false, reason: 'different-session' };
  const base = Number.isFinite(markerRatio) && markerRatio > 0 ? markerRatio : 0;
  if (projectedRatio >= 0.95) return { rehandoff: true, reason: 'near-hard-limit' };
  if (projectedRatio - base >= REHANDOFF_DELTA) return { rehandoff: true, reason: 'pressure-growth' };
  return { rehandoff: false, reason: 'below-delta' };
}
