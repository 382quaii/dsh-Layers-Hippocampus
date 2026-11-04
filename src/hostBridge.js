/**
 * Host lifecycle bridge (v1.5.6 / P1-7).
 *
 * The DSH Host exposes process-local Emit events. The two that matter for the
 * "dream at the low valley" policy are:
 *
 *   - `agent/created`   `(payload: { agent, source, signal? })`  — a session started
 *   - `session/created` `(session)`                              — durable creation
 *
 * This bridge does ONE thing on those signals: if no Dream ran for
 * `dream.compensateAfterHours`, and the price window permits it, run a compensating
 * Dream through the SAME single maintenance gate (`runtime.runMaintenance`) — so it
 * can never race a cron run, never queue, and never run during a peak.
 *
 * Price information is injected, never invented:
 *   - `setPriceProbe(fn)` — an external plugin (`dsh-price-tip`-style) may answer
 *     `{ low: boolean }`, `true`/`false`, or `null` (unknown);
 *   - `DSH_DREAM_PRICE=low|high` — a manual override for an operator;
 *   - unknown + an LLM-backed Dream ⇒ SKIP ("price-unknown"). Unknown + a local-only
 *     Dream ⇒ allowed (local recompute is cheap and the compensation is the point).
 *
 * Zero dependencies; the bus is a plain `{on, off}` seam so tests can mock the Host.
 */

export const HOST_EVENT_NAMES = Object.freeze({
  agentCreated: 'agent/created',
  sessionCreated: 'session/created',
  agentDisposed: 'agent/disposed',
  agentPresetSelected: 'agent-preset/selected',
});

export const DEFAULT_COMPENSATE_AFTER_HOURS = 24;
const HOUR_MS = 3_600_000;

/** Normalise whatever a price provider returned into `{known, low}`. */
export function normalisePrice(value) {
  if (value === true) return { known: true, low: true };
  if (value === false) return { known: true, low: false };
  if (value && typeof value === 'object' && typeof value.low === 'boolean') {
    return { known: true, low: value.low };
  }
  return { known: false, low: null };
}

export class HostBridge {
  constructor({
    bus = null,
    clock = () => Date.now(),
    logger = null,
    getConfig = () => ({}),
    getLastDreamAt = () => null,
    onDream = null,
    onAgentCreated = null,
    onAgentPresetSelected = null,
    env = process.env,
  } = {}) {
    this.bus = bus;
    this.clock = clock;
    this.logger = logger;
    this.getConfig = getConfig;
    this.getLastDreamAt = getLastDreamAt;
    this.onDream = typeof onDream === 'function' ? onDream : null;
    // v1.5.6: session-created hook (awaited: it may re-apply the handoff working
    // mode before the first turn) and preset-selection observer.
    this.onAgentCreated = typeof onAgentCreated === 'function' ? onAgentCreated : null;
    this.onAgentPresetSelected = typeof onAgentPresetSelected === 'function' ? onAgentPresetSelected : null;
    this.env = env ?? {};
    this._priceProbe = null;
    this._bound = null;
    this._compensating = false;
    this.stats = {
      sessionStarts: 0,
      lastSessionStartAt: null,
      compensations: 0,
      lastCompensationAt: null,
      skipped: 0,
      lastSkipReason: null,
      presetSelections: 0,
    };
  }

  /** Subscribe to the lifecycle events. Returns a disposer; idempotent. */
  attach(bus = this.bus) {
    if (this._bound) return () => this.detach();
    if (!bus || typeof bus.on !== 'function') return () => {};
    // `agent/created` is a SERIAL Host event: a returned promise is awaited before
    // the agent's creation resolves. That is exactly the window `agentPresets.select`
    // needs ("before a session starts its first turn"), so the preset hook is
    // awaited; Dream compensation stays fire-and-forget.
    const onStart = (payload) => {
      this.stats.sessionStarts += 1;
      this.stats.lastSessionStartAt = this.clock();
      this.maybeCompensate({ trigger: 'session-start' }).catch((error) => {
        this.logger?.warn?.(`hippocampus: dream compensation failed: ${error?.message ?? error}`);
      });
      if (!this.onAgentCreated) return undefined;
      return Promise.resolve()
        .then(() => this.onAgentCreated(payload))
        .catch((error) => {
          // A failed preset inheritance must NEVER fail agent creation.
          this.logger?.warn?.(`hippocampus: session preset hook failed: ${error?.message ?? error}`);
        });
    };
    const onPreset = (sessionId, agentPreset) => {
      this.stats.presetSelections += 1;
      try {
        this.onAgentPresetSelected?.(sessionId, agentPreset);
      } catch (error) {
        this.logger?.warn?.(`hippocampus: preset observer failed: ${error?.message ?? error}`);
      }
    };
    const onDisposed = () => {};
    bus.on(HOST_EVENT_NAMES.agentCreated, onStart);
    bus.on(HOST_EVENT_NAMES.sessionCreated, onStart);
    bus.on(HOST_EVENT_NAMES.agentPresetSelected, onPreset);
    bus.on(HOST_EVENT_NAMES.agentDisposed, onDisposed);
    this._bound = { bus, onStart, onPreset, onDisposed };
    return () => this.detach();
  }

  detach() {
    if (!this._bound) return;
    const { bus, onStart, onPreset, onDisposed } = this._bound;
    try {
      bus.off?.(HOST_EVENT_NAMES.agentCreated, onStart);
      bus.off?.(HOST_EVENT_NAMES.sessionCreated, onStart);
      bus.off?.(HOST_EVENT_NAMES.agentPresetSelected, onPreset);
      bus.off?.(HOST_EVENT_NAMES.agentDisposed, onDisposed);
    } catch {
      /* a dying bus must not throw during disposal */
    }
    this._bound = null;
  }

  /** Inject a price provider (`dsh-price-tip` style). Passing null clears it. */
  setPriceProbe(probe) {
    this._priceProbe = typeof probe === 'function' ? probe : null;
    return this;
  }

  /** `{known, low}` for one instant. Never guesses: unknown is reported as such. */
  lowValley(now = this.clock()) {
    if (this._priceProbe) {
      try {
        return normalisePrice(this._priceProbe(now));
      } catch (error) {
        this.logger?.warn?.(`hippocampus: price probe failed: ${error?.message ?? error}`);
        return { known: false, low: null };
      }
    }
    const override = String(this.env?.DSH_DREAM_PRICE ?? '').toLowerCase();
    if (override === 'low') return { known: true, low: true };
    if (override === 'high') return { known: true, low: false };
    return { known: false, low: null };
  }

  dreamPolicy() {
    const dream = this.getConfig()?.dream ?? {};
    const hours = Number(dream.compensateAfterHours);
    return {
      useLlm: dream.useLlm !== false,
      compensateAfterHours: Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_COMPENSATE_AFTER_HOURS,
    };
  }

  /** True when no Dream ran for the configured window (or one never ran). */
  dreamDue(now = this.clock()) {
    const last = Number(this.getLastDreamAt());
    if (!Number.isFinite(last) || last <= 0) return true;
    return now - last >= this.dreamPolicy().compensateAfterHours * HOUR_MS;
  }

  /**
   * The single decision point: due + allowed price + no run in flight ⇒ call the
   * host-injected `onDream`. Always returns a verdict instead of throwing.
   */
  async maybeCompensate({ trigger = 'manual', now = this.clock() } = {}) {
    const skip = (reason) => {
      this.stats.skipped += 1;
      this.stats.lastSkipReason = reason;
      return { ran: false, reason };
    };
    if (this._compensating) return skip('in-flight');
    if (this.getConfig()?.enableDream === false) return skip('dream-disabled');
    if (!this.dreamDue(now)) return skip('not-due');
    const price = this.lowValley(now);
    const policy = this.dreamPolicy();
    if (price.known && price.low === false) return skip('peak');
    if (!price.known && policy.useLlm) return skip('price-unknown');
    if (!this.onDream) return skip('no-dream-handler');

    this._compensating = true;
    try {
      const outcome = await this.onDream({ trigger, price, now });
      this.stats.compensations += 1;
      this.stats.lastCompensationAt = now;
      this.logger?.info?.(`hippocampus: compensating dream ran (${trigger})`);
      return { ran: true, trigger, outcome };
    } catch (error) {
      this.stats.skipped += 1;
      this.stats.lastSkipReason = 'error';
      this.logger?.warn?.(`hippocampus: compensating dream failed: ${error?.message ?? error}`);
      return { ran: false, reason: 'error' };
    } finally {
      this._compensating = false;
    }
  }

  /** Detached status for the panel / admin surface. */
  status() {
    const price = this.lowValley();
    return {
      ...this.stats,
      priceKnown: price.known,
      lowValley: price.low,
      dreamDue: this.dreamDue(),
      compensateAfterHours: this.dreamPolicy().compensateAfterHours,
      attached: this._bound !== null,
    };
  }
}
