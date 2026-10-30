/**
 * Retrieval — three stages, all served from the derived read model.
 *
 *   1. coarse:  day-diary blocks ranked by block decay x salience mass
 *   2. recall:  events inside the chosen blocks / tag postings
 *   3. score:   salience x time-decay x tag affinity x lexical similarity
 *
 * Rules enforced here:
 *   - The online path NEVER adjudicates. It reads the resident active set and the
 *     snapshot; it does not compute priorities, merge synonyms (that was done at
 *     build time) or archive tags.
 *   - The online path NEVER scans the full log. Candidates come from tag postings
 *     and from at most `blockTopK` (or, degraded, `degradedRecentBlocks`) day blocks.
 *   - An empty active set is not an error and not an empty answer: it degrades to
 *     "recent blocks + tag prefix matching" and says so in `mode`/`degradedReason`.
 *   - `topK` is capped by policy; the default is 20 and the ceiling 100.
 */

import { decayFactor } from './decay.js';
import { normaliseTagToken } from './policy.js';
import { clamp, round, snippet } from './util.js';

const TOKEN_RE = /[a-z0-9]{2,}|[\u4e00-\u9fff]{1,}/gi;
/** Default penalty for an event reached through a graph neighbour. */
const ASSOCIATION_PENALTY = 0.5;
/** Monthly memos never decay, and win ties on fuzzy historical queries. */
const MONTHLY_TAG = 'status:monthly';
const FUZZY_TIME_RE = /(上个月|本月|这个月|去年|前年|今年|月度|monthly|\d{4}\s*[-年/]\s*\d{1,2})/i;

export function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  const matches = text.toLowerCase().match(TOKEN_RE);
  return matches ? matches : [];
}

/** Set-based Jaccard similarity over lowercased tokens. Deterministic, dependency-free. */
export function similarity(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

/**
 * @param {object} input
 * @param {object|null} input.index derived view (published generation + overlay merge)
 * @param {object} [input.query] { text?, tags?, topK? }
 * @param {Readonly<object>} input.policy
 * @param {number} input.now epoch ms from the injected clock
 * @param {object[]} [input.semantic] folded semantic summaries
 * @param {object[]} [input.tempSemantic] folded L2.5 quarantine entries
 */
export function recall({ index, query = {}, policy, now, semantic = [], tempSemantic = [], associations = [] }) {
  const topK = Math.round(clamp(Number(query.topK) || policy.candidates.topK, 1, policy.candidates.maxTopK));
  const text = typeof query.text === 'string' ? query.text.trim() : '';
  const rawTags = Array.isArray(query.tags) ? query.tags : query.tags ? [query.tags] : [];
  const aliases = index?.aliases ?? {};
  const canonicalise = (tag) => {
    const token = normaliseTagToken(tag);
    if (!token) return '';
    return aliases[token] ?? token;
  };
  const queryTags = uniqueSorted(rawTags.map(canonicalise).filter(Boolean));

  const base = {
    query: { text, tags: queryTags, topK },
    generation: index?.generation ?? null,
    builtAt: index?.builtAt ?? null,
    notes: [],
  };

  // Semantic recall is independent of episode lifetime: an empty (or fully
  // purged) event index must still answer with patterns distilled earlier.
  const semanticHits = rankSemantic({ semantic, queryTags, text, now, policy });

  // L2.5 is recallable, but never on equal footing with a promoted trait: every
  // temp hit carries an explicit penalty and its remaining TTL, so a caller that
  // ignores the penalty still sees why it should not.
  const tempHits = rankTempSemantic({ tempEntries: tempSemantic, queryTags, text, now, policy });

  if (!index || !Array.isArray(index.events) || index.events.length === 0) {
    return {
      ...base,
      mode: 'degraded',
      degradedReason: index ? 'empty-index' : 'no-index',
      hits: [],
      semantic: semanticHits,
      tempSemantic: tempHits,
      scanned: { blocks: 0, candidates: 0, scored: 0 },
    };
  }

  const active = index.activeSet?.entries ?? [];
  const degraded = active.length === 0;
  const mode = degraded ? 'degraded' : 'active';
  const degradedReason = degraded ? 'empty-active-set' : undefined;
  const activeTags = new Set(active.map((entry) => entry.tag));
  const eventById = new Map(index.events.map((event) => [event.eventId, event]));

  // ---- tag matching (exact, hierarchical, then prefix) ---------------------
  /** @type {Map<string, number>} tag -> match weight */
  const tagHits = new Map();
  const addHit = (tag, weight) => {
    if (!index.tags[tag]) return;
    tagHits.set(tag, Math.max(tagHits.get(tag) ?? 0, weight));
  };

  for (const tag of queryTags) {
    addHit(tag, 1);
    for (const candidate of Object.keys(index.tags)) {
      if (candidate === tag) continue;
      if (candidate.startsWith(`${tag}:`) || candidate.startsWith(`${tag}/`) || candidate.startsWith(`${tag}.`)) {
        addHit(candidate, 0.9);
      } else if (tag.length >= 3 && candidate.startsWith(tag)) {
        addHit(candidate, 0.5);
      }
    }
  }
  if (text) {
    // Tags mentioned inside free text still narrow the candidate set.
    for (const token of tokenize(text)) {
      if (index.tags[token]) addHit(token, 0.8);
    }
  }

  // ---- candidate accumulation ---------------------------------------------
  /** @type {Map<string, number>} eventId -> accumulated affinity */
  const affinity = new Map();
  for (const [tag, weight] of tagHits) {
    const multiplier = activeTags.size === 0 ? 1 : activeTags.has(tag) ? 1 : 0.6;
    for (const posting of index.tags[tag].postings) {
      affinity.set(posting.eventId, (affinity.get(posting.eventId) ?? 0) + posting.strength * weight * multiplier);
    }
  }

  // ---- graph association (online wake-up) ---------------------------------
  // Neighbours of a matched tag enter the pool with a fixed penalty. An event
  // reached ONLY through a neighbour is marked and charged the penalty again at
  // scoring time, so an associative hit can never outrank a direct one.
  const associationOf = new Map(); // eventId -> { via, penalty }
  const directCandidates = new Set(affinity.keys());
  for (const association of associations) {
    const tag = association?.tag;
    if (!tag || !index.tags[tag]) continue;
    const penalty = Number.isFinite(association.penalty) ? association.penalty : ASSOCIATION_PENALTY;
    for (const posting of index.tags[tag].postings) {
      affinity.set(posting.eventId, (affinity.get(posting.eventId) ?? 0) + posting.strength * penalty);
      if (!directCandidates.has(posting.eventId) && !associationOf.has(posting.eventId)) {
        associationOf.set(posting.eventId, { via: association.via ?? tag, penalty });
      }
    }
    tagHits.set(tag, Math.max(tagHits.get(tag) ?? 0, penalty));
  }

  const blocks = index.diary?.blocks ?? [];
  const blockByEvent = new Map();
  for (const block of blocks) for (const id of block.eventIds) blockByEvent.set(id, block.day);

  const blockWeight = (block) => block.decay * block.salienceMass;

  /** @type {Set<string>} */
  const candidates = new Set(affinity.keys());
  if (candidates.size === 0 && !degraded) {
    // Stage 1 coarse recall in the normal path: no tag hit at all -> rank day
    // blocks by decayed salience mass and take the top few.
    const ranked = blocks
      .slice()
      .sort((a, b) => blockWeight(b) - blockWeight(a) || (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
    for (const block of ranked.slice(0, policy.candidates.blockTopK)) for (const id of block.eventIds) candidates.add(id);
    base.notes.push(`no-tag-match:coarse-blocks=${Math.min(policy.candidates.blockTopK, ranked.length)}`);
  }

  if (degraded) {
    // Explicit degradation: the N most recent diary blocks (newest by day, never
    // "highest weight" — a heavy old block must not hijack the fallback) plus the
    // tag prefix matches already accumulated above. Bounded on both sides.
    const newest = blocks
      .slice()
      .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
      .slice(0, policy.retrieval.degradedRecentBlocks);
    for (const block of newest) for (const id of block.eventIds) candidates.add(id);
    base.notes.push(`degraded:empty-active-set:recentBlocks=${newest.length}`);
  }

  // Monthly memos are summaries, not residents: they are pulled in when the query
  // asks about a fuzzy historical period ("上个月", "2023-10", "去年" …), which is
  // exactly the case where day-block paging cannot answer.
  const monthlyEvents = index.events.filter((event) => (event.tags ?? []).some((tag) => (tag.tag ?? tag) === MONTHLY_TAG));
  if (monthlyEvents.length > 0 && text && FUZZY_TIME_RE.test(text)) {
    for (const event of monthlyEvents) candidates.add(event.eventId);
    base.notes.push(`monthly-candidates:${monthlyEvents.length}:fuzzy-time`);
  }

  // ---- scoring ------------------------------------------------------------
  const halfLife = policy.decay.halfLifeDays;
  const floor = policy.decay.floor;
  let scored = [];
  for (const eventId of candidates) {
    const event = eventById.get(eventId);
    if (!event) continue;
    const tags = event.tags.map((t) => t.tag);
    const monthly = tags.includes(MONTHLY_TAG);
    // A monthly memo is a stable summary, not a fading episode: no decay at all,
    // and a small boost when the query is about a fuzzy historical period.
    const decay = monthly
      ? 1
      : decayFactor({
          eventTime: event.anchorTime ?? event.eventTime,
          lastReinforcedAt: event.lastReinforcedAt,
          now,
          halfLifeDays: halfLife,
          floor,
        });
    const tagScore = affinity.get(eventId) ?? 0;
    const tagAffinity = 1 + Math.min(2, tagScore);
    const lexical = text ? similarity(text, event.content) : 0;
    const lexicalBoost = text ? 0.6 + 0.4 * lexical : 1;
    const association = associationOf.get(eventId) ?? null;
    const associationFactor = association ? association.penalty : 1;
    const timeBoost = monthly && text && FUZZY_TIME_RE.test(text) ? 1.3 : 1;
    const score = event.salience * decay * tagAffinity * lexicalBoost * associationFactor * timeBoost;
    scored.push({
      eventId,
      eventTime: event.eventTime,
      day: event.day ?? blockByEvent.get(eventId) ?? null,
      score,
      salience: event.salience,
      decay,
      tagAffinity: round(tagAffinity, 4),
      lexical: round(lexical, 4),
      tags,
      monthly,
      ...(association ? { association } : {}),
      reinforcementCount: event.reinforcementCount ?? 0,
      snippet: snippet(event.content, 400),
    });
  }

  scored.sort((a, b) => b.score - a.score || a.eventId.localeCompare(b.eventId));
  if (scored.length > policy.retrieval.maxScannedEvents) {
    base.notes.push(`scan-capped:${policy.retrieval.maxScannedEvents}`);
    scored = scored.slice(0, policy.retrieval.maxScannedEvents);
  }

  const minScore = policy.candidates.minScore;
  let filtered = scored.filter((hit) => hit.score >= minScore);
  if (filtered.length === 0 && scored.length > 0) {
    // Never silently return nothing when there is something: return it, say so.
    filtered = scored;
    base.notes.push(`min-score-relaxed:${minScore}`);
  }

  const hits = filtered.slice(0, topK).map((hit) => ({
    ...hit,
    score: round(hit.score, 6),
  }));

  if (hits.length === 0) base.notes.push('no-candidates');

  return {
    ...base,
    mode,
    degradedReason,
    hits,
    semantic: semanticHits,
    tempSemantic: tempHits,
    scanned: {
      blocks: blocks.length,
      candidates: candidates.size,
      scored: scored.length,
      tagHits: tagHits.size,
      associations: associations.length,
      monthly: scored.filter((hit) => hit.monthly).length,
    },
    candidateTags: [...tagHits.keys()].sort(),
  };
}

/**
 * Semantic layer retrieval. Patterns outlive episodes, so they are scored on their
 * own slower curve and carry confidence instead of salience.
 */
export function rankSemantic({ semantic, queryTags, text, now, policy, limit = 3 }) {
  if (!Array.isArray(semantic) || semantic.length === 0) return [];
  const querySet = new Set(queryTags);
  const scored = [];
  for (const summary of semantic) {
    const tagOverlap = (summary.tags ?? []).filter((tag) => querySet.has(normaliseTagToken(tag))).length;
    const lexical = text ? similarity(text, `${summary.title ?? ''} ${summary.text ?? ''}`) : 0;
    if (queryTags.length > 0 && tagOverlap === 0 && lexical === 0) continue;
    if (queryTags.length === 0 && text && lexical === 0) continue;
    const decay = decayFactor({
      eventTime: summary.updatedAt ?? summary.firstSeenAt ?? now,
      now,
      halfLifeDays: policy.decay.semanticHalfLifeDays,
      floor: policy.decay.floor,
    });
    const confidence = Number.isFinite(summary.confidence) ? summary.confidence : 0.5;
    scored.push({
      summaryId: summary.summaryId,
      title: summary.title,
      text: snippet(summary.text ?? '', 400),
      confidence: round(confidence, 4),
      decay,
      tags: summary.tags ?? [],
      updatedAt: summary.updatedAt ?? null,
      score: round(confidence * decay * (1 + tagOverlap + lexical), 6),
    });
  }
  scored.sort((a, b) => b.score - a.score || String(a.summaryId).localeCompare(String(b.summaryId)));
  return scored.slice(0, limit);
}

/**
 * L2.5 retrieval: quarantined trends are retrievable but deliberately
 * disadvantaged. Three guards travel with every hit:
 *   - `priority: 'temp'` so a caller can filter them out wholesale;
 *   - `penalty` (policy.temp.retrievalPenalty) applied to the score;
 *   - `expiresAt` / `ttlDays` so the caller can see the hypothesis is on a clock.
 * Expired entries are not served at all — they are awaiting adjudication, and
 * serving them would make the TTL a lie.
 */
export function rankTempSemantic({ tempEntries = [], queryTags = [], text = '', now, policy, limit = 3 }) {
  if (!Array.isArray(tempEntries) || tempEntries.length === 0) return [];
  const penalty = policy.temp?.retrievalPenalty ?? 0.4;
  const querySet = new Set(queryTags);
  const scored = [];

  for (const entry of tempEntries) {
    if (entry.status && entry.status !== 'temp') continue;
    if (Number.isFinite(entry.expiresAt) && now >= entry.expiresAt) continue;
    const tags = entry.tags ?? [];
    const tagOverlap = tags.filter((tag) => querySet.has(normaliseTagToken(tag))).length;
    const lexical = text ? similarity(text, entry.content ?? '') : 0;
    if (queryTags.length > 0 && tagOverlap === 0 && lexical === 0) continue;
    if (queryTags.length === 0 && text && lexical === 0) continue;
    const decay = decayFactor({
      eventTime: entry.createdAt ?? entry.lastHitAt ?? now,
      now,
      halfLifeDays: policy.decay.halfLifeDays,
      floor: policy.decay.floor,
    });
    // 0.5 base: a quarantine entry is a hypothesis, never evidence.
    scored.push({
      tempId: entry.tempId,
      status: 'temp',
      priority: 'temp',
      content: snippet(entry.content ?? '', 400),
      tags,
      hitCount: entry.hitCount ?? 0,
      ttlDays: entry.ttlDays ?? policy.temp?.ttlDays ?? 30,
      expiresAt: entry.expiresAt ?? null,
      decay,
      penalty,
      score: round(0.5 * (1 + tagOverlap + lexical) * decay * penalty, 6),
    });
  }

  scored.sort((a, b) => b.score - a.score || String(a.tempId).localeCompare(String(b.tempId)));
  return scored.slice(0, limit);
}
