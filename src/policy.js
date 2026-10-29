/**
 * Policy table: the data that drives every adjudication decision.
 *
 * Hard rule from the brief: the task list (active set) is an *execution carrier*;
 * the adjudication rules live here, as data. Changing a threshold must only require
 * re-running maintenance, never rewriting the list of tag tasks — which is why
 * active-set entries carry `priority`/`budget`/metrics but no rule text, and why a
 * full rebuild takes the policy as input.
 *
 * All budget units are ENTRY COUNTS. Deliberately not tokens, not milliseconds:
 * mixing units would turn a single budget into a multi-objective optimisation.
 */

import { canonicalJson, clamp01, sha256 } from './util.js';
import { MemoryError, ErrorCodes } from './errors.js';

export const POLICY_VERSION = 1;

/**
 * Defaults are explicit and first-class: the delivery must state them, not leave
 * them to be discovered in code. Every value is overridable via plugin config.
 */
export const DEFAULT_POLICY = Object.freeze({
  version: POLICY_VERSION,

  // ---- Layer A: resident active set (the task list) -------------------------
  activeSet: {
    /** Hard cap on resident tag tasks. Budget unit: entries. */
    cap: 200,
    /** Candidate slots one tag task may contribute to the online queue. */
    tagBudget: 8,
    /** Admission thresholds — "just barely qualifies" is a score, not a checkbox.
     *  minEvents 1: a single high-salience memory still earns an active tag, so a
     *  fresh store does not start in degraded mode. Raise it to require repetition. */
    minEvents: 1,
    minMass: 0.3,
    /** Normaliser for mass when computing priority (mass at which massScore -> 1). */
    massScale: 4,
    /** priority = w.mass*massScore + w.recency*recencyScore + w.reinforcement*reinforceScore */
    weights: { mass: 0.55, recency: 0.3, reinforcement: 0.15 },
    /** Eviction order: lowest priority * decay first; ties -> longest-unreinforced. */
    eviction: 'priority-times-decay-asc',
  },

  // ---- Layer B: online candidate queue -------------------------------------
  candidates: {
    topK: 20,
    maxTopK: 100,
    /** Day-diary blocks considered by the coarse stage. */
    blockTopK: 5,
    /** Scores below this are dropped (still non-silent: reason is reported). */
    minScore: 0.02,
  },

  // ---- Decay ---------------------------------------------------------------
  decay: {
    halfLifeDays: 30,
    /** Block-level curve is slower: a day is not forgotten as fast as an event. */
    blockHalfLifeDays: 90,
    /** Semantic patterns decay slower still — they outlive episodes by design. */
    semanticHalfLifeDays: 180,
    floor: 0.02,
  },

  // ---- Tags ---------------------------------------------------------------
  tags: {
    /**
     * Synonym groups used for normalisation. `canonical` wins; aliases are folded
     * into it at index build time. Adding a group needs no data migration: the
     * index is rebuildable.
     */
    synonyms: [
      { canonical: 'typescript', aliases: ['ts', 'tsx'] },
      { canonical: 'javascript', aliases: ['js', 'nodejs'] },
      { canonical: 'postgres', aliases: ['postgresql', 'psql'] },
      { canonical: 'preference', aliases: ['pref', 'preferences'] },
    ],
    /** Jaccard threshold for the offline near-duplicate merge (advisory only). */
    mergeJaccard: 0.8,
    /** Low-frequency archival: cold + thin tags leave the hot path. */
    archiveAfterDays: 120,
    archiveMinEvents: 3,
  },

  // ---- Retrieval ----------------------------------------------------------
  retrieval: {
    /** Degraded mode scans the most recent N diary blocks. Never a full scan. */
    degradedRecentBlocks: 3,
    /** Hard cap on events examined by one query (backpressure, not correctness). */
    maxScannedEvents: 5000,
    /** Candidate queue size before scoring truncation, as a multiple of topK. */
    prefilterFactor: 4,
  },

  // ---- Delete pipeline ----------------------------------------------------
  delete: {
    /** At or above this salience an episode must be distilled before deletion. */
    consolidateSalience: 0.6,
    /**
     * 'auto'   — distil a summary automatically, then continue (default)
     * 'strict' — pause at `pending-consolidation` until a summary exists
     * 'off'    — do not consolidate (only for throwaway data)
     */
    consolidationMode: 'auto',
    /** Kept for readability of old configs; maps onto consolidationMode. */
    requireConsolidation: true,
    /** Archive (cold retention) before physical removal. */
    archiveBeforeDelete: true,
  },

  // ---- Maintenance --------------------------------------------------------
  maintenance: {
    intervalMs: 6 * 60 * 60 * 1000,
    /** Compact the log into fewer segments once it grows past this. */
    compactAfterSegments: 8,
    maxSegmentRecords: 5000,
    /** Boot does a light consistency check, never a rebuild. */
    bootCheck: 'light',
    /** Index generations kept on disk (active + standby + rollback target). */
    keepGenerations: 3,
  },

  // ---- L2.5 temporary semantic layer (trend quarantine) --------------------
  temp: {
    /** Default TTL of a quarantined trend, in days. */
    ttlDays: 30,
    /**
     * Sliding window at the END of the TTL. An aggregation-confirmed
     * reinforcement inside `[expiresAt - promotionWindowDays, expiresAt]` promotes;
     * anything else is deleted at expiry. There is no third outcome.
     */
    promotionWindowDays: 20,
    /** Burst detection: same content repeated this often inside the window. */
    burstWindowDays: 3,
    burstMinOccurrences: 3,
    /** Score multiplier applied to temp entries at recall time. */
    retrievalPenalty: 0.4,
    /** Hard cap on quarantined entries; oldest are adjudicated first. */
    maxEntries: 500,
  },

  // ---- Context window (engine-driven paging, never model-driven) -----------
  context: {
    /** Token budget of the injected memory blocks. */
    maxTokens: 4000,
    /** Evict as soon as usage crosses this fraction of maxTokens. */
    threshold: 0.85,
    /** Evict down to this fraction (hysteresis: avoids evict-one-per-turn). */
    target: 0.7,
    /** Tokens injected per recall, so a burst cannot flood the window. */
    blockTopK: 8,
  },

  // ---- Identity & idempotency ---------------------------------------------
  identity: {
    /**
     * Where event_time comes from. Wall clock is NEVER silently used:
     *   'content'  derive it from content_hash (default: replayable)
     *   'explicit' require the caller to pass event_time / happened_at
     *   'ingest'   opt in to the injected clock (record is tagged time_source)
     */
    eventTimePolicy: 'content',
    /** Independent idempotency index on (content_hash, event_time). */
    dedupe: true,
    /** Empty payloads go to the dead-letter queue instead of overwriting. */
    deadLetterOnInvalid: true,
    /** Max catch-up passes while a rebuild chases appended records. */
    maxCatchupPasses: 3,
  },
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, override) {
  if (!isPlainObject(override)) return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

function requirePositiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new MemoryError(ErrorCodes.INVALID_POLICY, `${label} must be a positive integer`, { value });
  }
}

function requirePositiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new MemoryError(ErrorCodes.INVALID_POLICY, `${label} must be a positive number`, { value });
  }
}

function requireNonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new MemoryError(ErrorCodes.INVALID_POLICY, `${label} must be a non-negative number`, { value });
  }
}

/**
 * Validate + freeze a resolved policy.
 * @param {object} policy
 * @returns {Readonly<object>}
 */
export function validatePolicy(policy) {
  requirePositiveInt(policy.activeSet.cap, 'activeSet.cap');
  requirePositiveInt(policy.activeSet.tagBudget, 'activeSet.tagBudget');
  requirePositiveInt(policy.activeSet.minEvents, 'activeSet.minEvents');
  requireNonNegativeNumber(policy.activeSet.minMass, 'activeSet.minMass');
  requirePositiveNumber(policy.activeSet.massScale, 'activeSet.massScale');
  const w = policy.activeSet.weights;
  const weightSum = w.mass + w.recency + w.reinforcement;
  if (!(weightSum > 0)) {
    throw new MemoryError(ErrorCodes.INVALID_POLICY, 'activeSet.weights must sum to a positive number');
  }
  if (policy.activeSet.eviction !== 'priority-times-decay-asc') {
    throw new MemoryError(ErrorCodes.INVALID_POLICY, 'activeSet.eviction is the only supported strategy', {
      value: policy.activeSet.eviction,
    });
  }

  requirePositiveInt(policy.candidates.topK, 'candidates.topK');
  requirePositiveInt(policy.candidates.maxTopK, 'candidates.maxTopK');
  if (policy.candidates.topK > policy.candidates.maxTopK) {
    throw new MemoryError(ErrorCodes.INVALID_POLICY, 'candidates.topK must be <= candidates.maxTopK');
  }
  requirePositiveInt(policy.candidates.blockTopK, 'candidates.blockTopK');
  requireNonNegativeNumber(policy.candidates.minScore, 'candidates.minScore');

  requirePositiveNumber(policy.decay.halfLifeDays, 'decay.halfLifeDays');
  requirePositiveNumber(policy.decay.blockHalfLifeDays, 'decay.blockHalfLifeDays');
  requirePositiveNumber(policy.decay.semanticHalfLifeDays, 'decay.semanticHalfLifeDays');
  if (policy.decay.floor < 0 || policy.decay.floor > 1) {
    throw new MemoryError(ErrorCodes.INVALID_POLICY, 'decay.floor must be within [0,1]');
  }

  if (!Array.isArray(policy.tags.synonyms)) {
    throw new MemoryError(ErrorCodes.INVALID_POLICY, 'tags.synonyms must be an array');
  }
  const aliasOwner = new Map();
  for (const group of policy.tags.synonyms) {
    if (!group || typeof group.canonical !== 'string' || !group.canonical.trim()) {
      throw new MemoryError(ErrorCodes.INVALID_POLICY, 'each synonym group needs a canonical tag');
    }
    const canonical = normaliseTagToken(group.canonical);
    if (!canonical) throw new MemoryError(ErrorCodes.INVALID_POLICY, 'canonical tag must not be empty');
    const tokens = [canonical, ...(group.aliases ?? []).map(normaliseTagToken)];
    for (const token of tokens) {
      if (!token) throw new MemoryError(ErrorCodes.INVALID_POLICY, 'alias must not be empty', { canonical });
      const owner = aliasOwner.get(token);
      if (owner && owner !== canonical) {
        throw new MemoryError(ErrorCodes.INVALID_POLICY, `tag "${token}" is claimed by two synonym groups`, {
          first: owner,
          second: canonical,
        });
      }
      aliasOwner.set(token, canonical);
    }
  }
  requireNonNegativeNumber(policy.tags.mergeJaccard, 'tags.mergeJaccard');
  requireNonNegativeNumber(policy.tags.archiveAfterDays, 'tags.archiveAfterDays');
  requirePositiveInt(policy.tags.archiveMinEvents, 'tags.archiveMinEvents');

  requirePositiveInt(policy.retrieval.degradedRecentBlocks, 'retrieval.degradedRecentBlocks');
  requirePositiveInt(policy.retrieval.maxScannedEvents, 'retrieval.maxScannedEvents');
  requirePositiveNumber(policy.retrieval.prefilterFactor, 'retrieval.prefilterFactor');

  if (policy.delete.consolidateSalience < 0 || policy.delete.consolidateSalience > 1) {
    throw new MemoryError(ErrorCodes.INVALID_POLICY, 'delete.consolidateSalience must be within [0,1]');
  }
  if (typeof policy.delete.requireConsolidation !== 'boolean') {
    throw new MemoryError(ErrorCodes.INVALID_POLICY, 'delete.requireConsolidation must be a boolean');
  }

  requirePositiveInt(policy.maintenance.intervalMs, 'maintenance.intervalMs');
  requirePositiveInt(policy.maintenance.compactAfterSegments, 'maintenance.compactAfterSegments');
  requirePositiveInt(policy.maintenance.maxSegmentRecords, 'maintenance.maxSegmentRecords');
  requirePositiveInt(policy.maintenance.keepGenerations, 'maintenance.keepGenerations');

  const timePolicies = new Set(['content', 'explicit', 'ingest']);
  if (!timePolicies.has(policy.identity.eventTimePolicy)) {
    throw new MemoryError(ErrorCodes.INVALID_POLICY, 'identity.eventTimePolicy must be content|explicit|ingest', {
      value: policy.identity.eventTimePolicy,
    });
  }
  for (const key of ['dedupe', 'deadLetterOnInvalid']) {
    if (typeof policy.identity[key] !== 'boolean') {
      throw new MemoryError(ErrorCodes.INVALID_POLICY, `identity.${key} must be a boolean`);
    }
  }
  requirePositiveInt(policy.identity.maxCatchupPasses, 'identity.maxCatchupPasses');

  return deepFreeze(policy);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Merge user overrides onto defaults and validate. */
export function resolvePolicy(overrides = {}) {
  const merged = deepMerge(structuredClone(DEFAULT_POLICY), overrides);
  return validatePolicy(merged);
}

/** Stable hash of the effective policy, stored in every index generation. */
export function hashPolicy(policy) {
  return sha256(canonicalJson(policy)).slice(0, 16);
}

/** tag token normalisation: trim, lowercase, collapse separators. */
export function normaliseTagToken(token) {
  if (typeof token !== 'string') return '';
  return token
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

/**
 * alias -> canonical map, built from the policy's synonym groups.
 * @returns {Map<string,string>}
 */
export function buildAliasMap(policy) {
  const map = new Map();
  for (const group of policy.tags.synonyms) {
    const canonical = normaliseTagToken(group.canonical);
    map.set(canonical, canonical);
    for (const alias of group.aliases ?? []) {
      const token = normaliseTagToken(alias);
      if (token) map.set(token, canonical);
    }
  }
  return map;
}

/** Continuous score helper: 0..1 for "how strongly does this tag qualify". */
export function normalisedScore(value, scale) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return clamp01(value / scale);
}
