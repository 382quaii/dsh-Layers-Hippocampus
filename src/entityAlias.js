/**
 * Entity merging (v1.6.9) — keep one entity from becoming five tags.
 *
 * The write path is the only place where an entity can be merged WITHOUT paying
 * for it, so the local half lives here and costs zero tokens:
 *
 *   1. **Dictionary** (`state/entity_alias.json`): an explicit `{"地瓜": "红薯"}`
 *      map. Checked first, because a human-asserted pair always beats a heuristic.
 *   2. **Substring containment**: with `entity:红薯` already known, writing
 *      `entity:烤红薯` folds into `红薯` (the existing, shorter entity is the
 *      canonical one — a qualifier is a refinement, not a new subject).
 *   3. **Edit distance**: a near-miss (`entity:红薯` vs `entity:红暑`) with
 *      similarity ≥ 0.8 is a spelling error, not a second entity.
 *
 * The offline half (module 1.3) lives in `dream.js`: the LLM is asked for a
 * synonym map, the result is written back here, and the tag index re-folds the
 * old names into the canonical one on the next rebuild — the append-only log is
 * never rewritten, so a wrong merge is undone by deleting one JSON file.
 *
 * Discipline:
 *   - deterministic, no dependencies, no LLM on the write path;
 *   - a merge is recorded on `meta.entity_merged` so an operator can audit it;
 *   - never merges across the `entity:` namespace (a `topic:` tag is not an entity);
 *   - words shorter than `MIN_FUZZY_CHARS` only merge by exact dictionary hit —
 *     two-character fuzzy matching is where false merges live.
 */

import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic } from './util.js';

export const ENTITY_PREFIX = 'entity:';
export const ENTITY_ALIAS_SCHEMA = 1;
/** Similarity floor for the edit-distance merge. */
export const EDIT_MERGE_MIN_SIMILARITY = 0.8;
/** Below this length a word may only merge through the dictionary. */
export const MIN_FUZZY_CHARS = 3;
/** Longest entity word considered (tags are capped at 64 chars; this is the word). */
export const ENTITY_WORD_MAX_CHARS = 32;
/** Alias chains are bounded: a cycle must cost a constant, not an infinite walk. */
export const ALIAS_CHAIN_LIMIT = 4;

/** Strip the namespace and normalise one entity word. */
export function entityWord(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^entity:/, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-:]+|[-:]+$/g, '');
  return text.slice(0, ENTITY_WORD_MAX_CHARS);
}

/** True when a tag lives in the entity namespace. */
export function isEntityTag(tag) {
  return typeof tag === 'string' && tag.startsWith(ENTITY_PREFIX);
}

/**
 * Levenshtein distance, two-row DP. Inputs are already short (≤32 code units), so
 * the O(n·m) cost is bounded by the entity cap rather than by the payload.
 */
export function levenshtein(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  let current = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/** 1 - distance/maxLength, in [0,1]. */
export function wordSimilarity(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/** Follow the alias chain to its canonical word (bounded, cycle-safe). */
export function resolveAlias(word, aliasMap) {
  let current = entityWord(word);
  if (!current) return '';
  for (let hops = 0; hops < ALIAS_CHAIN_LIMIT; hops += 1) {
    const next = aliasMap?.get?.(current);
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Merge ONE entity word against the known vocabulary.
 *
 * @param {string} word raw word (with or without the `entity:` prefix)
 * @param {{known?: Iterable<string>, aliasMap?: Map<string,string>}} [options]
 * @returns {{word: string, merged: {from: string, to: string, reason: string}|null}}
 */
export function mergeEntityWord(word, { known = [], aliasMap = null } = {}) {
  const raw = entityWord(word);
  if (!raw) return { word: '', merged: null };
  const viaAlias = resolveAlias(raw, aliasMap);
  if (viaAlias && viaAlias !== raw) return { word: viaAlias, merged: { from: raw, to: viaAlias, reason: 'alias' } };

  const vocabulary = [...new Set([...known].map(entityWord).filter((item) => item && item !== raw))];
  if (vocabulary.length === 0) return { word: raw, merged: null };

  // 1. Substring containment: an EXISTING entity that the new word contains is the
  //    canonical one ("烤红薯" -> "红薯"). Only ever folds the LONGER word into the
  //    shorter existing one; the reverse would let one new word swallow a family.
  if (raw.length > MIN_FUZZY_CHARS - 1) {
    const containers = vocabulary.filter((existing) => existing.length >= 2 && raw.includes(existing));
    if (containers.length > 0) {
      const canonical = containers.sort((left, right) => right.length - left.length || left.localeCompare(right))[0];
      return { word: canonical, merged: { from: raw, to: canonical, reason: 'substring' } };
    }
  }

  // 2. Edit distance: same-length-ish, similarity ≥ 0.8. Short words are excluded
  //    because "红薯"/"红暑" (2 chars, distance 1 -> 0.5) would be scored as a miss
  //    anyway, while 2-char typos of DIFFERENT words are indistinguishable.
  if (raw.length >= MIN_FUZZY_CHARS) {
    let best = null;
    for (const existing of vocabulary) {
      if (Math.abs(existing.length - raw.length) > 2) continue;
      const similarity = wordSimilarity(raw, existing);
      if (similarity < EDIT_MERGE_MIN_SIMILARITY) continue;
      if (!best || similarity > best.similarity || (similarity === best.similarity && existing < best.word)) {
        best = { word: existing, similarity };
      }
    }
    if (best) {
      return {
        word: best.word,
        merged: { from: raw, to: best.word, reason: 'fuzzy', similarity: Number(best.similarity.toFixed(3)) },
      };
    }
  }
  return { word: raw, merged: null };
}

/**
 * Merge every `entity:` tag in a tag list. Non-entity tags pass through untouched
 * (and are still deduplicated), so this is safe to call on every write.
 *
 * @returns {{tags: string[], merged: Array<{from: string, to: string, reason: string}>}}
 */
export function mergeEntityTags(tags, { known = [], aliasMap = null } = {}) {
  const input = Array.isArray(tags) ? tags : [];
  const merged = [];
  const out = [];
  const seen = new Set();
  for (const tag of input) {
    if (typeof tag !== 'string' || !tag) continue;
    if (!isEntityTag(tag)) {
      if (!seen.has(tag)) {
        seen.add(tag);
        out.push(tag);
      }
      continue;
    }
    const result = mergeEntityWord(tag, { known, aliasMap });
    if (!result.word) continue;
    if (result.merged) merged.push(result.merged);
    const canonical = `${ENTITY_PREFIX}${result.word}`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return { tags: out, merged };
}

/**
 * Validation for a learned alias map: `{alias: canonical}` strings only, no
 * self-references, no chains longer than the dictionary itself.
 */
export function sanitiseAliasPairs(pairs, { known = null } = {}) {
  if (!pairs || typeof pairs !== 'object' || Array.isArray(pairs)) return {};
  const allowed = Array.isArray(known) && known.length > 0 ? new Set(known.map(entityWord)) : null;
  const clean = {};
  for (const [rawAlias, rawCanonical] of Object.entries(pairs)) {
    const alias = entityWord(rawAlias);
    const canonical = entityWord(rawCanonical);
    if (!alias || !canonical || alias === canonical) continue;
    if (alias.length > ENTITY_WORD_MAX_CHARS || canonical.length > ENTITY_WORD_MAX_CHARS) continue;
    // v1.6.9: an LLM answer may only fold onto a word the store already knows about.
    // Inventing a canonical name would create a NEW node instead of merging one.
    if (allowed && !allowed.has(canonical)) continue;
    clean[alias] = canonical;
  }
  // Break chains: an alias must point at a word that is NOT itself an alias, and a
  // two-node cycle must never survive.
  for (const alias of Object.keys(clean)) {
    let current = clean[alias];
    let hops = 0;
    while (clean[current] && hops < ALIAS_CHAIN_LIMIT) {
      current = clean[current];
      hops += 1;
    }
    if (current === alias || hops >= ALIAS_CHAIN_LIMIT) delete clean[alias];
    else clean[alias] = current;
  }
  return clean;
}

/** The prompt asking the offline LLM for a synonym map (Dream, module 1.3). */
export function aliasPrompt(words = []) {
  const list = [...new Set(words.map(entityWord).filter(Boolean))].slice(0, 60);
  return {
    system: [
      'You merge entity names that refer to the SAME thing across languages and spellings.',
      'Reply with ONE JSON object: {"aliases": {"<variant>": "<canonical>"}}.',
      'Rules: canonical values must be one of the input words; never map a word to itself;',
      'omit words that have no synonym; if unsure, omit. No prose, JSON only.',
    ].join('\n'),
    user: JSON.stringify({ words: list }),
  };
}

/**
 * Parse the LLM reply for `aliasPrompt`. Strict: a non-JSON / non-object answer is
 * a miss, never a guess (a wrong merge silently destroys a distinction).
 */
export function parseAliasReply(content) {
  const text = String(content ?? '').trim();
  if (!text) return {};
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return {};
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return {};
  }
  const raw = parsed && typeof parsed === 'object' ? (parsed.aliases ?? parsed) : null;
  return sanitiseAliasPairs(raw);
}

/**
 * Durable alias dictionary (`state/entity_alias.json`).
 *
 * The file is a CACHE of decisions, not a truth source: deleting it loses the
 * merges (tags reappear separately) but never an event.
 */
export class EntityAliasStore {
  constructor({ file, clock = Date.now } = {}) {
    this.file = file ?? null;
    this.clock = typeof clock === 'function' ? clock : () => Number(clock) || Date.now();
    /** @type {{aliases: Record<string,string>, updatedAt: number}|null} */
    this._cache = null;
  }

  _now() {
    try {
      return Number(this.clock()) || Date.now();
    } catch {
      return Date.now();
    }
  }

  load() {
    if (this._cache) return this._cache;
    const raw = this.file ? readJson(this.file, null) : null;
    const aliases = raw && typeof raw === 'object' && raw.aliases && typeof raw.aliases === 'object' ? raw.aliases : {};
    this._cache = { aliases: sanitiseAliasPairs(aliases), updatedAt: Number(raw?.updatedAt) || 0 };
    return this._cache;
  }

  /** alias(word) -> canonical word, as a Map for O(1) lookups. */
  map() {
    return new Map(Object.entries(this.load().aliases));
  }

  /** Plain `{alias: canonical}` object (for the panel / HTTP view). */
  list() {
    return { ...this.load().aliases };
  }

  resolve(word) {
    return resolveAlias(word, this.map());
  }

  /** Merge learned pairs; returns what actually changed. */
  learn(pairs) {
    const incoming = sanitiseAliasPairs(pairs);
    const current = { ...this.load().aliases };
    const added = {};
    for (const [alias, canonical] of Object.entries(incoming)) {
      if (current[alias] === canonical) continue;
      current[alias] = canonical;
      added[alias] = canonical;
    }
    if (Object.keys(added).length === 0) return { added: {}, total: Object.keys(current).length, changed: false };
    this.write(current);
    return { added, total: Object.keys(current).length, changed: true };
  }

  write(aliases) {
    const clean = sanitiseAliasPairs(aliases);
    const state = { schema: ENTITY_ALIAS_SCHEMA, aliases: clean, updatedAt: this._now() };
    this._cache = { aliases: clean, updatedAt: state.updatedAt };
    if (this.file) {
      ensureDir(path.dirname(this.file));
      writeJsonAtomic(this.file, state);
    }
    return state;
  }

  status() {
    const state = this.load();
    return {
      file: this.file,
      schema: ENTITY_ALIAS_SCHEMA,
      aliases: Object.keys(state.aliases).length,
      updatedAt: state.updatedAt || null,
    };
  }
}
