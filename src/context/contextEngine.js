/**
 * Context window paging — module 3 of the memory design.
 *
 * Discipline: the paging decision is a MEASUREMENT, never an instruction to the
 * model. "Please trim your context when it gets long" is a request the model can
 * drift from; an engine that measures token usage and evicts by a deterministic
 * score cannot drift. So this engine owns the block table and the eviction, and
 * the system prompt only ever renders the surviving blocks.
 *
 * Eviction score: salience * decay(now - at). Lowest score leaves first; pinned
 * blocks never leave. Hysteresis (threshold -> target) prevents the worst failure
 * of naive paging: evicting one block per turn forever because the trigger sits
 * exactly at the boundary.
 */
import { decayFactor } from '../decay.js';
import { readJson, round, snippet, writeJsonAtomic } from '../util.js';

/** Cheap, stable estimate. Do not pretend it is an exact tokeniser. */
export function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4));
}

export class ContextEngine {
  /**
   * @param {object}   options
   * @param {object}   options.clock     Clock (injected; tests use FakeClock)
   * @param {Function} options.getPolicy () => resolved policy (context section)
   * @param {number}   [options.nativeTokenLimit]        model-native window size
   * @param {number}   [options.autoRolloverThreshold]   fraction of native window that triggers a handoff
   * @param {boolean}  [options.autoRolloverEnabled]     false disables handoff and enables forced eviction
   * @param {Function} [options.getSessionTokens]        () => tokens consumed by the live session
   */
  constructor({
    clock,
    getPolicy,
    maxTokens,
    threshold,
    target,
    statsFile = null,
    nativeTokenLimit,
    autoRolloverThreshold,
    autoRolloverEnabled,
    getSessionTokens,
  } = {}) {
    this.clock = clock;
    this.getPolicy = getPolicy;
    this.maxTokensOverride = maxTokens ?? null;
    this.thresholdOverride = threshold ?? null;
    this.targetOverride = target ?? null;
    // v1.5.0 routing options. An explicit constructor value wins over the policy
    // block, which wins over the documented default — same precedence as limits.
    // `null` means "not supplied" so a caller cannot accidentally pin undefined.
    this.nativeTokenLimitOverride =
      Number.isFinite(nativeTokenLimit) && nativeTokenLimit > 0 ? Math.round(nativeTokenLimit) : null;
    this.rolloverThresholdOverride = Number.isFinite(autoRolloverThreshold) ? autoRolloverThreshold : null;
    this.rolloverEnabledOverride = typeof autoRolloverEnabled === 'boolean' ? autoRolloverEnabled : null;
    this.getSessionTokens = typeof getSessionTokens === 'function' ? getSessionTokens : null;
    this.statsFile = statsFile;
    /** @type {Array<object>} insertion-ordered block table */
    this.blocks = [];
    this.seq = 0;
    this.evicted = [];
    // Cumulative, persisted: "saved tokens" is a DERIVED STATE, so it is recorded
    // at eviction time (where the fact is known) and survives restarts. Summing a
    // live in-memory list would reset on every boot and quietly understate savings.
    const stats = statsFile ? readJson(statsFile, null) : null;
    this.savedTokens = Number.isFinite(stats?.savedTokens) ? stats.savedTokens : 0;
    this.evictedBlocks = Number.isInteger(stats?.evictedBlocks) ? stats.evictedBlocks : 0;
  }

  _persistStats() {
    if (!this.statsFile) return;
    try {
      writeJsonAtomic(this.statsFile, {
        savedTokens: this.savedTokens,
        evictedBlocks: this.evictedBlocks,
        updatedAt: this.clock.now(),
      });
    } catch {
      // A failed stats write must never block retrieval; the counters stay in memory.
    }
  }

  get limits() {
    const pol = this.getPolicy?.()?.context ?? {};
    return {
      maxTokens: this.maxTokensOverride ?? pol.maxTokens ?? 4000,
      threshold: this.thresholdOverride ?? pol.threshold ?? 0.85,
      target: this.targetOverride ?? pol.target ?? 0.7,
    };
  }

  get nativeTokenLimit() {
    const pol = this.getPolicy?.()?.context ?? {};
    return this.nativeTokenLimitOverride ?? pol.nativeTokenLimit ?? 8000;
  }

  get rolloverThreshold() {
    const pol = this.getPolicy?.()?.context ?? {};
    return this.rolloverThresholdOverride ?? pol.autoRolloverThreshold ?? 0.85;
  }

  get rolloverEnabled() {
    const pol = this.getPolicy?.()?.context ?? {};
    return this.rolloverEnabledOverride ?? pol.autoRolloverEnabled ?? true;
  }

  /**
   * The native/layered decision, derived purely from measurements.
   *
   * `tokens` is the effective occupancy: the larger of the blocks this engine
   * tracks and the live session size. A session can be inside the native window
   * while the engine's own block table is empty (or vice versa), so neither number
   * alone is the honest answer. `getSessionTokens` is the injection point; a
   * caller may also pass `sessionTokens` per call.
   *
   * mode 'native': the model's own window can hold this session; no folding is
   * allowed (there is nothing to fold into yet). mode 'layered': the session has
   * outgrown the native window, so the layered memory pipeline may take over.
   *
   * `remainingTokens` is headroom to the HANDOFF point (threshold * native), not
   * to the hard limit: crossing the hard limit is already too late to hand off.
   *
   * @param {{ now?: number, sessionTokens?: number }} [options]
   */
  nativeState({ now = this.clock.now(), sessionTokens } = {}) {
    void now; // part of the API so callers can pin one timestamp across a snapshot
    const limit = this.nativeTokenLimit;
    const threshold = this.rolloverThreshold;
    const enabled = this.rolloverEnabled;
    const reported = Number.isFinite(sessionTokens) ? sessionTokens : this.getSessionTokens?.();
    const session = Number.isFinite(reported) ? reported : 0;
    const tokens = Math.max(this.tokens(), session);
    const ratio = round(limit > 0 ? tokens / limit : 0, 4);
    const handoffThresholdTokens = Math.round(threshold * limit);
    return {
      mode: tokens < limit ? 'native' : 'layered',
      tokens,
      // Effective occupancy (max of block table and session). `effectiveTokens` is
      // the canonical name; `sessionTokens` is kept as an alias so existing callers
      // that read the session-side name keep working.
      effectiveTokens: tokens,
      sessionTokens: tokens,
      nativeTokenLimit: limit,
      ratio,
      rolloverThreshold: threshold,
      rolloverEnabled: enabled,
      rolloverDue: enabled && ratio >= threshold,
      remainingTokens: Math.max(0, Math.ceil(threshold * limit - tokens)),
      // Rollover disabled means no handoff can move the session; once the native
      // window is effectively exhausted (95%) eviction is the only honest option
      // left, and it must be FORCED rather than silently ignored.
      forceEvictionDue: !enabled && ratio >= 0.95,
      handoffThresholdTokens,
    };
  }

  /**
   * Folding ("推币机") is a layered-mode operation: folding blocks out of the
   * native window would evict context the model still holds natively. Memory asks
   * this gate before folding; the engine itself never folds.
   */
  foldAllowed(options = {}) {
    return this.nativeState(options).mode === 'layered';
  }

  /**
   * Add or refresh a block. Same id replaces in place, keeping insertion order —
   * a refreshed memory must not jump to the end of the window.
   */
  inject({
    id,
    kind = 'recall',
    text,
    tokens,
    salience = 0.5,
    at,
    pinned = false,
    now = this.clock.now(),
  }) {
    if (!id) throw new Error('ContextEngine.inject requires an id');
    const body = String(text ?? '');
    if (!body) return null;
    const block = {
      id,
      kind,
      text: body,
      tokens: Number.isFinite(tokens) ? Math.max(1, Math.round(tokens)) : estimateTokens(body),
      salience: Number.isFinite(salience) ? Math.max(0, Math.min(1, salience)) : 0.5,
      at: Number.isFinite(at) ? at : now,
      pinned: pinned === true,
      seq: 0,
    };
    const index = this.blocks.findIndex((b) => b.id === id);
    if (index >= 0) {
      block.seq = this.blocks[index].seq;
      this.blocks[index] = block;
    } else {
      this.seq += 1;
      block.seq = this.seq;
      this.blocks.push(block);
    }
    return block;
  }

  tokens() {
    return this.blocks.reduce((sum, block) => sum + block.tokens, 0);
  }

  usage({ now = this.clock.now() } = {}) {
    const { maxTokens, threshold } = this.limits;
    const tokens = this.tokens();
    return {
      tokens,
      maxTokens,
      ratio: round(maxTokens > 0 ? tokens / maxTokens : 0, 4),
      overThreshold: tokens > threshold * maxTokens,
      blocks: this.blocks.length,
    };
  }

  score(block, now) {
    return (
      block.salience *
      decayFactor({ eventTime: block.at, now, halfLifeDays: this.getPolicy?.()?.decay?.halfLifeDays ?? 30, floor: 0 })
    );
  }

  /**
   * Evict until usage is back under `target`. Deterministic: score ascending,
   * ties broken by insertion order (oldest leaves first).
   *
   * Two triggers exist, and they are deliberately kept apart:
   *   - 'threshold'    the legacy rule: before > threshold * maxTokens. Unchanged
   *                    for every existing caller;
   *   - 'native-force' only when auto-rollover is DISABLED and the native window
   *                    is >= 95% full. With rollover off there is no handoff to
   *                    move the session, so the window itself must shrink.
   *                    Its eviction limit is the stricter of target*maxTokens and
   *                    target*nativeTokenLimit: a large maxTokens must not make the
   *                    forced eviction a no-op when the native window is small.
   */
  enforce({ now = this.clock.now() } = {}) {
    const { maxTokens, threshold, target } = this.limits;
    const before = this.tokens();
    const native = this.nativeState({ now });
    const legacyTriggered = before > threshold * maxTokens;
    const forced = !legacyTriggered && !native.rolloverEnabled && native.forceEvictionDue;
    const evictedNow = [];

    if (!legacyTriggered && !forced) {
      return {
        triggered: false,
        before,
        after: before,
        evicted: [],
        threshold,
        target,
        maxTokens,
        pinnedFloorReached: false,
        reason: null,
        forced: false,
        native,
      };
    }

    const limit = forced ? Math.min(target * maxTokens, target * native.nativeTokenLimit) : target * maxTokens;
    let current = before;
    while (current > limit) {
      let victim = null;
      let victimScore = Infinity;
      for (const block of this.blocks) {
        if (block.pinned) continue;
        const score = this.score(block, now);
        if (
          victim === null ||
          score < victimScore - 1e-12 ||
          (Math.abs(score - victimScore) <= 1e-12 && block.seq < victim.seq)
        ) {
          victim = block;
          victimScore = score;
        }
      }
      if (!victim) break; // everything left is pinned: report, never force
      this.blocks = this.blocks.filter((b) => b.id !== victim.id);
      current -= victim.tokens;
      // Keep the TEXT of the victim: folding ("推币机") needs what was evicted,
      // not just its id — the block is gone from the window either way.
      const record = { id: victim.id, kind: victim.kind, tokens: victim.tokens, score: round(victimScore, 6), text: victim.text, at: victim.at };
      evictedNow.push(record);
      this.evicted.push({ ...record, at: now });
    }
    if (evictedNow.length > 0) {
      // "Cumulative saved tokens" is exactly the sum of evicted block tokens.
      this.savedTokens += evictedNow.reduce((sum, record) => sum + record.tokens, 0);
      this.evictedBlocks += evictedNow.length;
      this._persistStats();
    }

    return {
      triggered: true,
      before,
      after: current,
      evicted: evictedNow,
      threshold,
      target,
      maxTokens,
      pinnedFloorReached: current > limit,
      reason: legacyTriggered ? 'threshold' : 'native-force',
      forced,
      native,
    };
  }

  /**
   * Render the surviving blocks. v1.5.6: `excludeIds` lets prompt assembly drop
   * blocks already injected earlier in the SAME session (dedup by block id).
   */
  render({ excludeIds = null } = {}) {
    const excluded = excludeIds instanceof Set ? excludeIds : null;
    return this.blocks
      .filter((block) => !(excluded && excluded.has(block.id)))
      .map((block) => (block.kind === 'briefing' ? block.text : `- [memory ${block.id}] ${snippet(block.text, 200)}`))
      .join('\n');
  }

  snapshot({ now = this.clock.now() } = {}) {
    const { maxTokens } = this.limits;
    return {
      ...this.usage({ now }),
      maxTokens,
      // Native/layered measurement rides along with the panel snapshot so status
      // readers never have to reconstruct it from the block table.
      native: this.nativeState({ now }),
      blocks: this.blocks.map((block) => ({
        id: block.id,
        kind: block.kind,
        tokens: block.tokens,
        salience: block.salience,
        score: round(this.score(block, now), 6),
        pinned: block.pinned,
        at: block.at,
      })),
      recentlyEvicted: this.evicted.slice(-10),
      savedTokens: this.savedTokens,
      evictedBlocks: this.evictedBlocks,
    };
  }

  clear() {
    this.blocks = [];
    this.evicted = [];
    this.seq = 0;
  }
}
