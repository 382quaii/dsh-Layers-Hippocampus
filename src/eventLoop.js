/**
 * Cooperative Event-Loop lag monitor (v1.5.6).
 *
 * Charter v2.0 #3 ("offline heavy, online light") assumes maintenance can be long,
 * but a synchronous maintenance phase that runs for hundreds of milliseconds makes
 * the UI (and the tool surface) visibly stutter. This module gives the maintenance
 * gate two things:
 *
 *   1. measurement — `perf_hooks.monitorEventLoopDelay()` turned into ms;
 *   2. a cooperative yield — when the measured max delay crosses the threshold, the
 *      caller awaits a short timer, letting pending I/O, ticks and UI work run.
 *
 * Honest scope: it can only yield BETWEEN awaits. A single synchronous builder
 * (`buildIndex`) cannot be preempted from JavaScript; the monitor reports the lag it
 * observed, so an operator can see when a phase is too big. Every yield point in
 * this codebase sits between maintenance phases or between async loops.
 *
 * Zero dependencies: `perf_hooks` and `setTimeout` are Node built-ins.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';

export const LAG_THRESHOLD_MS = 100;
export const LAG_SLEEP_MS = 50;
const NS_PER_MS = 1e6;

function toMs(nanoseconds) {
  const value = Number(nanoseconds) || 0;
  return Math.round((value / NS_PER_MS) * 1000) / 1000;
}

/**
 * @param {{thresholdMs?: number, sleepMs?: number, resolutionMs?: number}} [options]
 */
export function createLagMonitor({ thresholdMs = LAG_THRESHOLD_MS, sleepMs = LAG_SLEEP_MS, resolutionMs = 10 } = {}) {
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
  let yields = 0;
  let stopped = false;

  const monitor = {
    get yields() {
      return yields;
    },
    get thresholdMs() {
      return thresholdMs;
    },
    /** Current measurement. Cheap enough to call after every phase. */
    snapshot() {
      return {
        maxMs: toMs(histogram.max),
        p99Ms: toMs(histogram.percentile(99)),
        meanMs: toMs(histogram.mean),
        yields,
        thresholdMs,
      };
    },
    /**
     * Await a short pause iff the loop has been delayed past the threshold.
     * Resetting the histogram after a yield makes the next decision measure the
     * NEXT window instead of the same spike forever.
     * @returns {Promise<boolean>} true when a yield happened
     */
    async yieldIfLagging() {
      if (stopped) return false;
      if (toMs(histogram.max) < thresholdMs) return false;
      yields += 1;
      histogram.reset();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, sleepMs);
        timer.unref?.();
      });
      return true;
    },
    /** Stop sampling and return the final measurement. Idempotent. */
    stop() {
      if (!stopped) {
        histogram.disable();
        stopped = true;
      }
      return monitor.snapshot();
    },
  };
  return monitor;
}
