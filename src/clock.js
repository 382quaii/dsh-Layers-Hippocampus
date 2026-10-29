/**
 * Clock seam.
 *
 * Every time-dependent decision in this plugin (decay, reinforcement anchors,
 * maintenance watermarks, delete journals) reads time from an injected Clock.
 * Nothing calls `Date.now()` except `SystemClock`, so tests can move time
 * deterministically with `FakeClock` instead of sleeping or monkey-patching.
 *
 * Contract: `now(): number` returning **epoch milliseconds** (UTC). Implementations
 * must be monotonic per-process; a backwards jump is tolerated by clamping age at
 * zero in the decay function, but should not happen.
 */

import { MemoryError, ErrorCodes } from './errors.js';

/** Production clock. The only place in the plugin allowed to read the wall clock. */
export class SystemClock {
  now() {
    return Date.now();
  }
}

/**
 * Test clock. `advance(ms)` moves time forward, `set(ms)` jumps anywhere.
 * Deliberately has no auto-tick: a test that forgets to advance time sees frozen
 * time rather than a flaky one.
 */
export class FakeClock {
  /** @param {number} [start] epoch ms */
  constructor(start = 0) {
    this._now = start;
  }

  now() {
    return this._now;
  }

  /** @param {number} ms */
  advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('FakeClock.advance expects a non-negative number');
    this._now += ms;
    return this._now;
  }

  /** @param {number} ms */
  set(ms) {
    this._now = ms;
    return this._now;
  }
}

/** Validate a Clock-shaped object at construction time, not at first use. */
export function assertClock(clock) {
  if (!clock || typeof clock.now !== 'function') {
    throw new MemoryError(ErrorCodes.CLOCK_INVALID, 'clock must implement now(): number');
  }
  const probe = clock.now();
  if (!Number.isFinite(probe)) {
    throw new MemoryError(ErrorCodes.CLOCK_INVALID, 'clock.now() must return a finite epoch-ms number');
  }
  return clock;
}

export const DAY_MS = 86_400_000;
