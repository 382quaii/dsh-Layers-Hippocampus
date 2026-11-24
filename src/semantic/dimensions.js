/**
 * L3 six dimensions (v1.7.0, roadmap item M2).
 *
 * The semantic layer used to be a flat pile of free-text summaries ranked only by
 * confidence. That is unusable as a persona: the model cannot tell a PREFERENCE from
 * a FACT, and nothing stopped physiological state ("fatigue", "mood") from being
 * written as personality.
 *
 * Contract:
 *  - every L3 record carries exactly ONE `dimension` out of `L3_DIMENSIONS`;
 *  - the dimension is also written as a `dim:<dimension>` tag, so tag-driven
 *    retrieval can reach it with no new index structure;
 *  - physiological / body-state vocabulary is REFUSED at the boundary: this plugin
 *    models a persona, not a body (user decision 2026-11-24).
 */

/** The six dimensions, in the order they are rendered into the prompt. */
export const L3_DIMENSIONS = Object.freeze([
  'persona',
  'preferences',
  'facts-rules',
  'relationships',
  'skills-patterns',
  'boundaries',
]);

export const DIMENSION_TAG_PREFIX = 'dim:';

/** Default when nothing can be inferred: a durable statement is a fact or a rule. */
export const DEFAULT_DIMENSION = 'facts-rules';

/**
 * Physiological / body-state vocabulary. A summary that carries any of these is NOT
 * a persona trait — the emotion plugin owns the body; the memory plugin refuses it
 * so "fatigue 0.31" can never be inherited as a personality.
 */
export const PHYSIOLOGY_TERMS = Object.freeze([
  'bodystate',
  'body_state',
  'fatigue',
  'mood',
  'hormone',
  'heart-rate',
  'heartrate',
  '体温',
  '心率',
  '心跳',
  '疲劳',
  '体力',
  '精力值',
  '激素',
  '生理状态',
  '情动值',
  '血糖',
  '血压',
  '困倦',
]);

/** Aliases accepted from callers/LLMs, mapped onto the enumeration. */
const DIMENSION_ALIASES = Object.freeze({
  persona: 'persona',
  personality: 'persona',
  identity: 'persona',
  preference: 'preferences',
  preferences: 'preferences',
  habit: 'preferences',
  偏好: 'preferences',
  fact: 'facts-rules',
  facts: 'facts-rules',
  rule: 'facts-rules',
  rules: 'facts-rules',
  'facts-rules': 'facts-rules',
  factsrules: 'facts-rules',
  relationship: 'relationships',
  relationships: 'relationships',
  relation: 'relationships',
  skill: 'skills-patterns',
  skills: 'skills-patterns',
  patterns: 'skills-patterns',
  'skills-patterns': 'skills-patterns',
  boundary: 'boundaries',
  boundaries: 'boundaries',
  limit: 'boundaries',
  limits: 'boundaries',
});

const DIMENSION_PATTERNS = [
  [/^(?:pref|偏好|喜欢|习惯)/, 'preferences'],
  [/^(?:rel|关系|人际)/, 'relationships'],
  [/^(?:skill|pattern|技能|模式|做法)/, 'skills-patterns'],
  [/^(?:bound|boundary|边界|红线|底线)/, 'boundaries'],
  [/^(?:persona|人格|性格|身份)/, 'persona'],
  [/^(?:fact|rule|事实|规则|结论)/, 'facts-rules'],
];

/**
 * Normalise anything the caller/LLM sends into one of the six dimensions.
 * @returns {string|null} `null` when the value is not a recognisable dimension.
 */
export function normaliseDimension(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (key.length === 0) return null;
  if (DIMENSION_ALIASES[key]) return DIMENSION_ALIASES[key];
  for (const [pattern, dimension] of DIMENSION_PATTERNS) {
    if (pattern.test(key)) return dimension;
  }
  return null;
}

export function dimensionTag(dimension) {
  return `${DIMENSION_TAG_PREFIX}${dimension}`;
}

/** True when the text names a physiological state (never persona material). */
export function containsPhysiology(text) {
  const haystack = String(text ?? '').toLowerCase();
  if (haystack.length === 0) return false;
  return PHYSIOLOGY_TERMS.some((term) => haystack.includes(term));
}

/** Drop the offending lines instead of the whole record: the rest may be persona. */
export function stripPhysiology(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const kept = lines.filter((line) => !containsPhysiology(line));
  return kept.join('\n').trim();
}

/**
 * Deterministic dimension inference: tags win, then title/text keywords, then the
 * default. Mechanical on purpose — it must work with no model call, offline, inside
 * the delete pipeline.
 */
export function inferDimension({ title = '', text = '', tags = [] } = {}) {
  for (const entry of Array.isArray(tags) ? tags : []) {
    const tag = typeof entry === 'string' ? entry : entry?.tag;
    if (typeof tag !== 'string') continue;
    if (!tag.startsWith(DIMENSION_TAG_PREFIX)) continue;
    const normalised = normaliseDimension(tag.slice(DIMENSION_TAG_PREFIX.length));
    if (normalised) return normalised;
  }
  const titleDimension = normaliseDimension(title);
  if (titleDimension) return titleDimension;
  const haystack = `${title} ${text}`.toLowerCase();
  if (/偏好|喜欢|更喜欢|习惯用|prefer/.test(haystack)) return 'preferences';
  if (/关系|称呼|对我|朋友|队友|relationship/.test(haystack)) return 'relationships';
  if (/技能|做法|套路|模式|流程|skill|pattern/.test(haystack)) return 'skills-patterns';
  if (/边界|红线|底线|禁止|不得|boundary|never/.test(haystack)) return 'boundaries';
  if (/人格|性格|身份|persona|personality/.test(haystack)) return 'persona';
  return DEFAULT_DIMENSION;
}

/** The dimension recorded on one L3 record (`dim:` tag first, then the field). */
export function dimensionOf(summary = {}) {
  const explicit = normaliseDimension(summary?.dimension);
  if (explicit) return explicit;
  return inferDimension({ title: summary?.title ?? '', text: summary?.text ?? '', tags: summary?.tags ?? [] });
}

/** Group summaries by dimension, preserving the canonical dimension order. */
export function groupByDimension(summaries = []) {
  const buckets = new Map(L3_DIMENSIONS.map((dimension) => [dimension, []]));
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    const dimension = dimensionOf(summary);
    if (!buckets.has(dimension)) buckets.set(dimension, []);
    buckets.get(dimension).push(summary);
  }
  return buckets;
}
