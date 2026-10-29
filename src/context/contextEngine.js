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
   */
  constructor({ clock, getPolicy, maxTokens, threshold, target, statsFile = null } = {}) {
    this.clock = clock;
    this.getPolicy = getPolicy;
    this.maxTokensOverride = maxTokens ?? null;
    this.thresholdOverride = threshold ?? null;
    this.targetOverride = target ?? null;
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
   */
  enforce({ now = this.clock.now() } = {}) {
    const { maxTokens, threshold, target } = this.limits;
    const before = this.tokens();
    const evictedNow = [];

    if (before <= threshold * maxTokens) {
      return { triggered: false, before, after: before, evicted: [], threshold, target, maxTokens };
    }

    const limit = target * maxTokens;
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
      const record = { id: victim.id, kind: victim.kind, tokens: victim.tokens, score: round(victimScore, 6) };
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
    };
  }

  render() {
    return this.blocks
      .map((block) => (block.kind === 'briefing' ? block.text : `- [memory ${block.id}] ${snippet(block.text, 200)}`))
      .join('\n');
  }

  snapshot({ now = this.clock.now() } = {}) {
    const { maxTokens } = this.limits;
    return {
      ...this.usage({ now }),
      maxTokens,
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
