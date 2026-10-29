/**
 * Cron scheduler for maintenance.
 *
 * Three rules, each of which has a test:
 *   1. NEVER CONCURRENT. If the previous `maintain()` is still running, the tick is
 *      skipped and counted. Two rebuilds racing would publish out of order.
 *   2. NEVER BACKFILL. A tick fires only when its minute matches the expression; a
 *      window missed while the process was down is simply missed. Only the last
 *      SUCCESSFUL run time is recorded.
 *   3. FAILURE IS VISIBLE. An exception is recorded in `lastError` and surfaced in
 *      the status panel; it does not kill the interval timer.
 *
 * The clock is injected, so tests drive ticks with a FakeClock and never sleep.
 */

import { matchesCron, nextRun, parseCron } from './cron.js';

export class CronScheduler {
  /**
   * @param {object} options
   * @param {{now: () => number}} options.clock
   * @param {() => string} options.getCronExpression resolved expression (may change)
   * @param {(context: {reason: string, at: number, scheduled: boolean}) => Promise<unknown>} options.run
   * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger]
   */
  constructor({ clock, getCronExpression, run, logger = null }) {
    if (!clock || typeof clock.now !== 'function') throw new TypeError('CronScheduler requires a clock');
    if (typeof getCronExpression !== 'function') throw new TypeError('CronScheduler requires getCronExpression');
    if (typeof run !== 'function') throw new TypeError('CronScheduler requires a run function');
    this.clock = clock;
    this.getCronExpression = getCronExpression;
    this.run = run;
    this.logger = logger;
    this.running = false;
    this.lastSuccessAt = null;
    this.lastAttemptAt = null;
    this.lastError = null;
    this.ticks = 0;
    this.runs = 0;
    this.skipped = 0;
  }

  /** The parsed spec for the CURRENT expression (config changes are picked up). */
  spec() {
    return parseCron(this.getCronExpression());
  }

  nextRunAt(now = this.clock.now()) {
    return nextRun(this.spec(), now);
  }

  /**
   * One tick. Idempotent per minute; concurrent calls while `running` are skipped.
   * @returns {Promise<{ran: boolean, skipped?: boolean, reason?: string, at: number}>}
   */
  async tick({ now = this.clock.now() } = {}) {
    this.ticks += 1;
    if (this.running) {
      this.skipped += 1;
      this.logger?.warn?.('hippocampus: maintenance tick skipped — previous run still in flight');
      return { ran: false, skipped: true, reason: 'maintenance-in-flight', at: now };
    }
    let scheduled;
    try {
      scheduled = matchesCron(this.spec(), now);
    } catch (error) {
      this.lastError = { message: error?.message ?? String(error), code: error?.code ?? null, at: now };
      this.logger?.error?.(`hippocampus: invalid maintenance cron: ${this.lastError.message}`);
      return { ran: false, skipped: false, reason: 'invalid-cron', at: now };
    }
    if (!scheduled) return { ran: false, skipped: false, reason: 'not-due', at: now };

    this.running = true;
    this.lastAttemptAt = now;
    try {
      const outcome = await this.run({ reason: 'cron', at: now, scheduled: true });
      // A shared maintenance gate may refuse the run (another trigger holds it).
      // That is a skip, not a success: only a real run updates lastSuccessAt.
      if (outcome && outcome.ran === false) {
        this.skipped += 1;
        return { ran: false, skipped: true, reason: outcome.reason ?? 'skipped', at: now };
      }
      this.runs += 1;
      this.lastSuccessAt = this.clock.now();
      this.lastError = null;
      return { ran: true, skipped: false, at: now };
    } catch (error) {
      this.lastError = {
        message: error?.message ?? String(error),
        code: error?.code ?? null,
        at: this.clock.now(),
      };
      this.logger?.error?.(`hippocampus: maintenance failed: ${this.lastError.message}`);
      return { ran: false, skipped: false, reason: 'failed', at: now, error: this.lastError };
    } finally {
      this.running = false;
    }
  }

  status(now = this.clock.now()) {
    let nextAt = null;
    let parseError = null;
    try {
      nextAt = this.nextRunAt(now);
    } catch (error) {
      parseError = { message: error?.message ?? String(error), code: error?.code ?? null };
    }
    return {
      cron: this.getCronExpression(),
      running: this.running,
      lastSuccessAt: this.lastSuccessAt,
      lastAttemptAt: this.lastAttemptAt,
      lastError: this.lastError,
      nextRunAt: nextAt,
      cronError: parseError,
      ticks: this.ticks,
      runs: this.runs,
      skipped: this.skipped,
    };
  }
}
