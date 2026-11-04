/**
 * Dream wake-up timer (v1.5.6 low-valley scheduler, Phase 2).
 *
 * Phase 1 made `tick()` obey the peak/valley window. That is enough only while the
 * Host keeps ticking; a valley that opens while the process is asleep/idle would wait
 * for the next cron tick. This timer arms ONE wake-up at the queued Dream's due time
 * (or the next valley start) and, crucially, treats a LATE wake correctly:
 *
 *   - setTimeout can fire late after an OS sleep; on fire we re-read the clock and
 *     the window instead of trusting the scheduled instant;
 *   - woke during a valley  -> run the queued Dream and report `lateMs`/`catchUp`;
 *   - woke during a PEAK    -> never spend money; re-arm at the next valley;
 *   - the queue itself is durable (`state/dream-queue.json`), so even a missed fire
 *     is recovered on the next boot (delay 0 => catch-up run).
 *
 * Timers are injectable so the behaviour is testable without real waiting.
 */

export const DEFAULT_WAKE_MARGIN_MS = 60_000;

export class DreamTimer {
  constructor({
    clock = () => Date.now(),
    getQueue = () => ({ pending: false }),
    onDue = async () => {},
    isLow = () => true,
    nextLow = (now) => now,
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (handle) => clearTimeout(handle),
    logger = null,
    wakeMarginMs = DEFAULT_WAKE_MARGIN_MS,
  } = {}) {
    this.clock = clock;
    this.getQueue = getQueue;
    this.onDue = onDue;
    this.isLow = isLow;
    this.nextLow = nextLow;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.logger = logger;
    this.wakeMarginMs = wakeMarginMs;
    this._timer = null;
    this._scheduledAt = null;
    this._dueAt = null;
    this.stats = { arms: 0, wakes: 0, lateWakes: 0, reschedules: 0, runs: 0, lastWakeAt: null, lastLateMs: 0 };
  }

  /** Cancel a pending wake. Idempotent. */
  cancel() {
    if (this._timer !== null) {
      try {
        this.clearTimer(this._timer);
      } catch {
        /* a dying timer handle must not throw during disposal */
      }
    }
    this._timer = null;
    this._scheduledAt = null;
    this._dueAt = null;
    return this;
  }

  /**
   * Arm from the CURRENT queue. Returns `{armed, at, delay}`; no pending queue means
   * cancelled/disarmed. Deterministic given clock/window.
   */
  schedule(now = this.clock()) {
    this.cancel();
    const queue = this.getQueue();
    if (!queue || queue.pending !== true) return { armed: false, at: null, delay: null };
    const dueAt = Number.isFinite(Number(queue.dueAt)) ? Number(queue.dueAt) : now;
    // While already in the valley we may wake as soon as the due instant passes;
    // during a peak we must wait for the next valley (never spend at peak).
    const target = this.isLow(now) ? Math.max(now, dueAt) : Math.max(dueAt, this.nextLow(now));
    const delay = Math.max(0, target - now);
    this._scheduledAt = now;
    this._dueAt = target;
    this._timer = this.setTimer(() => {
      this._timer = null;
      Promise.resolve()
        .then(() => this._fire())
        .catch((error) => this.logger?.warn?.(`hippocampus: dream wake failed: ${error?.message ?? error}`));
    }, delay);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    this.stats.arms += 1;
    return { armed: true, at: target, delay };
  }

  async _fire() {
    const now = this.clock();
    const scheduledAt = this._scheduledAt ?? now;
    const lateMs = Math.max(0, now - (this._dueAt ?? scheduledAt));
    // Re-read the window: an OS sleep may have moved us into a peak, or past one.
    if (!this.isLow(now)) {
      this.stats.reschedules += 1;
      this.logger?.info?.('hippocampus: dream wake landed in a peak window; re-arming for the next valley');
      this.schedule(now);
      return { ran: false, reason: 'still-peak', lateMs };
    }
    if (lateMs > this.wakeMarginMs) {
      this.stats.lateWakes += 1;
      this.logger?.warn?.(`hippocampus: dream wake was ${Math.round(lateMs / 1000)}s late (sleep/clock jump); catching up`);
    }
    this.stats.wakes += 1;
    this.stats.lastWakeAt = now;
    this.stats.lastLateMs = lateMs;
    await this.onDue({ now, lateMs, catchUp: lateMs > this.wakeMarginMs });
    this.stats.runs += 1;
    return { ran: true, lateMs };
  }

  status() {
    return {
      armed: this._timer !== null,
      at: this._dueAt,
      scheduledAsOf: this._scheduledAt,
      wakeMarginMs: this.wakeMarginMs,
      ...this.stats,
    };
  }
}
