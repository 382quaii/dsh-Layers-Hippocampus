/**
 * WriteQueue — a tiny rate gate for bursty writes.
 *
 * The contract is deliberately narrow: `push` is synchronous and never blocks the
 * caller; when more than `thresholdPerWindow` pushes land inside one tick window,
 * the batch is deferred and flushed asynchronously (drained by `flush()` on the
 * next timer tick or by an explicit caller). No dependencies, no promises in the
 * hot path.
 */
export const DEFAULT_WINDOW_MS = 1000;
export const DEFAULT_THRESHOLD = 20;
export const DEFAULT_FLUSH_MS = 1000;

export class WriteQueue {
  /**
   * @param {object} options
   * @param {object} options.clock        injected clock (FakeClock in tests)
   * @param {(batch: Array) => void} options.onFlush  sync sink for a drained batch
   * @param {number} [options.thresholdPerWindow]
   * @param {number} [options.windowMs]
   * @param {number} [options.flushMs]
   */
  constructor({ clock, onFlush, thresholdPerWindow = DEFAULT_THRESHOLD, windowMs = DEFAULT_WINDOW_MS, flushMs = DEFAULT_FLUSH_MS } = {}) {
    if (typeof onFlush !== 'function') throw new Error('WriteQueue requires onFlush');
    this.clock = clock;
    this.onFlush = onFlush;
    this.thresholdPerWindow = thresholdPerWindow;
    this.windowMs = windowMs;
    this.flushMs = flushMs;
    this.pending = [];
    this.windowStart = clock ? clock.now() : Date.now();
    this.windowCount = 0;
    this.timer = null;
    this.flushes = 0;
  }

  get length() {
    return this.pending.length;
  }

  /** True when the current tick window already exceeded the threshold. */
  get throttled() {
    return this.windowCount > this.thresholdPerWindow;
  }

  /** Synchronous, non-blocking enqueue. Returns the queue depth. */
  push(item) {
    this.pending.push(item);
    const now = this.clock ? this.clock.now() : Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    if (this.throttled || this.pending.length >= this.thresholdPerWindow) {
      this._schedule();
    }
    return this.pending.length;
  }

  _schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  /** Drain everything currently pending (idempotent, synchronous). */
  flush() {
    if (this.pending.length === 0) return 0;
    const batch = this.pending.splice(0, this.pending.length);
    this.flushes += 1;
    this.onFlush(batch);
    return batch.length;
  }

  /** Drop the timer (unload). */
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
