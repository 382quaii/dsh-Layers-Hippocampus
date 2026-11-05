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
import { classifyHit, parseTagPath, DAY_MS } from './tagTreeRebuild.js';
import { clamp, round, snippet } from './util.js';

const TOKEN_RE = /[a-z0-9]{2,}|[\u4e00-\u9fff]{1,}/gi;
/** Default penalty for an event reached through a graph neighbour. */
const ASSOCIATION_PENALTY = 0.5;
/** Monthly memos never decay, and win ties on fuzzy historical queries. */
const MONTHLY_TAG = 'status:monthly';
/**
 * Handoff summaries are state-machine bookkeeping, not memories a user asks for.
 * They are ranked at 2% weight (v1.5.4) so real facts always outrank them; they
 * remain reachable if a query explicitly names their tags.
 */
const HANDOFF_INTERNAL_TAG = 'status:handoff';
const HANDOFF_INTERNAL_PENALTY = 0.02;
const FUZZY_TIME_RE = /(上个月|本月|这个月|去年|前年|今年|月度|monthly|\d{4}\s*[-年/]\s*\d{1,2})/i;

/**
 * Tag-explosion defence (v1.5.0): three thresholds, three layers.
 *
 * A tag mentioned by hundreds of episodes is not a filter, it is a dump. Expanding
 * its posting list floods the candidate pool and pushes the one precise memory out of
 * the top-k — the model then answers from noise. The same flood exists one layer down
 * in deep_raw, so the numbers are shared vocabulary, not per-call tuning knobs:
 *
 *   - TAG_OVERFLOW_THRESHOLD: an EXPLICIT query tag above this size is not expanded
 *     into candidates at all; recall returns a structured hint asking for a precise
 *     time window instead.
 *   - OVERSIZED_TAG_RECENT: if the caller insists on that tag, it gets this many of
 *     the most recent events — a bounded preview, never the full posting list.
 *   - SUPER_TAG_THRESHOLD: a tag this large makes deep_raw require a time window,
 *     because an unbounded forensic scan is the same explosion with raw turns.
 */
export const TAG_OVERFLOW_THRESHOLD = 50;
export const OVERSIZED_TAG_RECENT = 3;
export const SUPER_TAG_THRESHOLD = 500;

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

// NOTE (v1.5.3): the `minInjectConfidence` / `applyConfidence` pass was REMOVED.
// It never demonstrably saved tokens (0.6 and 0 produced byte-identical output on
// homogeneous corpora) while every added hit-shaping pass is permanent token tax
// and a misleading config knob. Recall now returns ranked hits as-is; the only
// payload reduction is the token-budget slimmer, which has a measured effect.

function isoTimestamp(epochMs) {
  return new Date(epochMs).toISOString();
}

/**
 * Ghost-mid degradation: anti-hallucination on a fading branch.
 *
 * A hit whose tags reach it ONLY through a mid-level tag (`tech/frontend`) is not
 * concrete evidence once that mid is in its grace window — the leaf-level facts
 * below it are dead, and injecting a broad summary as if it were a remembered
 * detail is exactly how a model starts inventing the specifics. Such hits are
 * removed from `hits` (body, snippet and score never reach the prompt) and replaced
 * by one metadata hint per mid: path, count, remaining grace and the exact
 * `deep_raw` time window that WOULD return the verbatim turns.
 *
 * Hits that carry a leaf path or a flat tag stay direct: a specific memory is
 * specific, whatever state its siblings are in.
 *
 * A query that EXPLICITLY names a fading mid (`tags: ["tech/frontend"]`) but finds
 * no live episode under it is not an empty answer either: it gets the same metadata
 * hint (count 0) instead of silence, so the model knows a fuzzy memory exists and
 * where the verbatim turns are.
 *
 * @param {Array<object>} hits retrieval hits (tags are canonical tag strings)
 * @param {Array<{name: string, parentId?: string|null, graceUntil?: number|null}>} ghosts
 * @param {{now?: number, queryTags?: string[]}} [options]
 */
export function degradeGhostHits(hits = [], ghosts = [], { now = 0, queryTags = [] } = {}) {
  const list = Array.isArray(hits) ? hits : [];
  const ghostList = (Array.isArray(ghosts) ? ghosts : []).filter(
    (ghost) => ghost && typeof ghost.name === 'string' && ghost.name.length > 0,
  );
  if (ghostList.length === 0) return { hits: list, ghostHints: [], notes: [] };

  const byName = new Map(ghostList.map((ghost) => [ghost.name, ghost]));
  // Ghosts are matched by FULL path when the root is known: two namespaces can both
  // have a mid called `frontend`, and `web/frontend` must not be degraded because
  // `tech/frontend` is fading. A ghost without a root falls back to its name.
  const ghostPathOf = (ghost) => {
    const rootName = typeof ghost?.parentId === 'string' ? ghost.parentId.replace(/^root:/, '') : null;
    return rootName ? `${rootName}/${ghost.name}` : null;
  };
  const byPath = new Map();
  for (const ghost of ghostList) {
    const path = ghostPathOf(ghost);
    if (path !== null && !byPath.has(path)) byPath.set(path, ghost);
  }
  const ghostForPath = (root, mid) => {
    if (!root || !mid) return null;
    const byFull = byPath.get(`${root}/${mid}`);
    if (byFull) return byFull;
    // A rootless ghost is a last resort: the tree could not name its root.
    const byNameGhost = byName.get(mid) ?? null;
    return byNameGhost && ghostPathOf(byNameGhost) === null ? byNameGhost : null;
  };
  const kept = [];
  const groups = new Map();

  const groupFor = (ghost) => {
    const ghostPath = ghostPathOf(ghost) ?? ghost.name;
    let group = groups.get(ghostPath);
    if (group) return group;
    group = {
      mid: ghost.name,
      path: ghostPath,
      count: 0,
      tags: new Set(),
      start: null,
      end: null,
      graceUntil: Number.isFinite(ghost?.graceUntil) ? ghost.graceUntil : null,
    };
    groups.set(ghostPath, group);
    return group;
  };

  // Query-scoped hint: only when the recall found nothing at all. If concrete hits
  // exist they already answer the query, and the per-hit rule above decides.
  if (list.length === 0) {
    for (const tag of Array.isArray(queryTags) ? queryTags : []) {
      if (typeof tag !== 'string') continue;
      const path = parseTagPath(tag);
      if (!path || !path.mid) continue;
      const ghost = ghostForPath(path.root, path.mid);
      if (ghost) groupFor(ghost).tags.add(tag);
    }
  }

  for (const hit of list) {
    const tags = Array.isArray(hit?.tags) ? hit.tags.filter((tag) => typeof tag === 'string') : [];
    if (classifyHit(tags, ghostList) !== 'path-only') {
      kept.push(hit);
      continue;
    }
    let ghost = null;
    const matchedTags = [];
    for (const tag of tags) {
      const path = parseTagPath(tag);
      if (!path || !path.mid) continue;
      const candidate = ghostForPath(path.root, path.mid);
      if (!candidate) continue;
      if (ghost === null) ghost = candidate;
      if (candidate === ghost) matchedTags.push(tag);
    }
    if (ghost === null) {
      // Same mid name, different namespace: classifyHit is name-keyed, but the full
      // path decides whether THIS hit really sits under a fading branch.
      kept.push(hit);
      continue;
    }
    const group = groupFor(ghost);
    group.count += 1;
    for (const tag of matchedTags) group.tags.add(tag);
    // The deep_raw hint must point at a REAL time window: the raw shards are filed
    // by the day the turn was logged, so use the diary `day` (anchor time). The
    // event_time coordinate can be content-hash derived and is not a wall-clock fact.
    const day = typeof hit?.day === 'string' ? hit.day : null;
    const dayStart = day ? Date.parse(`${day}T00:00:00.000Z`) : null;
    const at = Number.isFinite(dayStart) ? dayStart : Number.isFinite(hit?.eventTime) ? hit.eventTime : null;
    if (at !== null) {
      group.start = group.start === null ? at : Math.min(group.start, at);
      const endAt = Number.isFinite(dayStart) ? dayStart + DAY_MS - 1 : at;
      group.end = group.end === null ? endAt : Math.max(group.end, endAt);
    }
  }

  if (groups.size === 0) return { hits: list, ghostHints: [], notes: [] };

  const ghostHints = [...groups.values()]
    .sort((a, b) => b.count - a.count || a.mid.localeCompare(b.mid))
    .map((group) => {
      const daysLeft = group.graceUntil === null ? null : Math.max(0, Math.ceil((group.graceUntil - now) / DAY_MS));
      const window = group.start === null ? null : { start: group.start, end: group.end };
      const range =
        window === null
          ? 'start_time="<起>", end_time="<止>"'
          : `start_time="${isoTimestamp(window.start)}", end_time="${isoTimestamp(window.end)}"`;
      const found = group.count > 0 ? `共 ${group.count} 条` : '索引中已无实体命中';
      return {
        mid: group.mid,
        path: group.path,
        count: group.count,
        tags: [...group.tags].sort(),
        graceUntil: group.graceUntil,
        graceDaysLeft: daysLeft,
        window,
        hint: `检测到关于[${group.mid}]的模糊记忆（路径 ${group.path}），${found}；具体摘要未注入以防幻觉，请使用 memory_recall(mode="deep_raw", ${range}) 查阅原话`,
      };
    });

  const degraded = list.length - kept.length;
  return {
    hits: kept,
    ghostHints,
    notes: [degraded > 0 ? `ghost-degraded:${degraded}:mids=${ghostHints.length}` : `ghost-hints:${ghostHints.length}`],
  };
}

/**
 * Event-time span of a tag's postings, so an oversized-tag hint can hand the caller
 * a range that actually contains data. Postings store the anchor time (recency
 * coordinate), matching what decay uses.
 */
function postingsWindow(postings) {
  if (!Array.isArray(postings) || postings.length === 0) return null;
  let start = Infinity;
  let end = -Infinity;
  for (const posting of postings) {
    const at = posting?.eventTime;
    if (!Number.isFinite(at)) continue;
    if (at < start) start = at;
    if (at > end) end = at;
  }
  return start === Infinity ? null : { start, end };
}

/**
 * The refusal must be actionable: it says how big the tag is AND the two ways out
 * (a precise window, or deep_raw for the verbatim turns). Silence would look like an
 * empty memory; an unbounded dump would look like a working one.
 */
function oversizedTagHint(tag, total, window, { recent = false } = {}) {
  return {
    tag,
    total,
    code: 'MEM_E_TAG_OVERFLOW',
    hint: `[系统提示] 发现关于 [${tag}] 的记忆共 ${total} 条，数据量过大。请提供更精确的 startTime/endTime 或使用 deep_raw 查阅。`,
    window,
    ...(recent ? { recent: true } : {}),
  };
}

/**
 * The N most recent events carrying one tag, scanned from the event list rather than
 * from `index.tags[tag].postings`: the posting list is physically capped, so the
 * newest events are exactly what a salience-ranked cap may have dropped.
 */
function recentEventsForTag(events, tag, limit) {
  const matches = [];
  for (const event of events) {
    if (!Array.isArray(event?.tags)) continue;
    if (event.tags.some((item) => (item?.tag ?? item) === tag)) matches.push(event);
  }
  matches.sort(
    (a, b) =>
      (b.anchorTime ?? b.eventTime) - (a.anchorTime ?? a.eventTime) || a.eventId.localeCompare(b.eventId),
  );
  return matches.slice(0, limit);
}

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
    // Always present, possibly empty: a caller reads this field, not a maybe-key.
    oversizedTagHints: [],
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

  // ---- oversized explicit tags (v1.5.0) -----------------------------------
  // Only EXPLICIT query tags are guarded: a free-text token or a graph neighbour
  // reaching a big tag still narrows a real question, but a literal `tags: ['big']`
  // over the threshold means "dump that tag", and expanding it would crowd every
  // precise hit out of the top-k.
  const oversizedTagHints = [];
  const oversizedTags = new Set();
  const oversizedRecentIds = new Set();
  let insensitiveOversizedTags = 0;
  for (const tag of queryTags) {
    const entry = index.tags[tag];
    if (!entry || !(Number(entry.eventCount) > TAG_OVERFLOW_THRESHOLD)) continue;
    oversizedTags.add(tag);
    const window = postingsWindow(entry.postings);
    if (query.allowOversizedTags === true) {
      // The caller insisted. Honour the intent but bound the damage: a fixed preview
      // of the newest events read from the event list, never the whole posting list.
      const recent = recentEventsForTag(index.events, tag, OVERSIZED_TAG_RECENT);
      for (const event of recent) oversizedRecentIds.add(event.eventId);
      oversizedTagHints.push(oversizedTagHint(tag, entry.eventCount, window, { recent: true }));
      base.notes.push(`oversized-tag-recent:${recent.length}`);
    } else {
      insensitiveOversizedTags += 1;
      oversizedTagHints.push(oversizedTagHint(tag, entry.eventCount, window));
    }
    // No exact hit, no posting accumulation and no prefix/child expansion for this
    // tag: children are a broadening of the same overloaded subject and would
    // silently bypass the guard.
  }
  if (insensitiveOversizedTags > 0) base.notes.push(`oversized-tag:${insensitiveOversizedTags}`);

  // ---- tag matching (exact, hierarchical, then prefix) ---------------------
  /** @type {Map<string, number>} tag -> match weight */
  const tagHits = new Map();
  const addHit = (tag, weight) => {
    if (!index.tags[tag]) return;
    tagHits.set(tag, Math.max(tagHits.get(tag) ?? 0, weight));
  };

  for (const tag of queryTags) {
    if (oversizedTags.has(tag)) continue;
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
    // The graph must not smuggle an oversized tag's postings back into the pool:
    // the explicit-tag guard above is worthless if a neighbour re-expands it.
    if (oversizedTags.has(tag)) continue;
    if (Number(index.tags[tag].eventCount) > TAG_OVERFLOW_THRESHOLD) continue;
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
  // The insist preview is a candidate even though its tag's postings were not
  // expanded — these ids came straight from the event list.
  for (const eventId of oversizedRecentIds) candidates.add(eventId);
  if (candidates.size === 0 && !degraded && oversizedTagHints.length === 0) {
    // Stage 1 coarse recall in the normal path: no tag hit at all -> rank day
    // blocks by decayed salience mass and take the top few.
    //
    // Deliberately skipped when the query was degraded to oversized-tag hints: the
    // recent blocks of a dumped tag ARE that dump, so falling back here would
    // silently undo the guard and answer the flood anyway.
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
    // v1.5.4: internal handoff summaries are heavily down-ranked, never banned.
    // Without this a 0.9-salience recursive summary outranks real facts on almost
    // every query (the exact incident that motivated this patch).
    const handoffInternal = tags.includes(HANDOFF_INTERNAL_TAG);
    const handoffFactor = handoffInternal ? HANDOFF_INTERNAL_PENALTY : 1;
    // A monthly memo is a stable summary, not a fading episode: no decay at all,
    // and a small boost when the query is about a fuzzy historical period.
    // v1.5.6: pinned records never decay either — they are lessons, not episodes.
    const pinned = event.pinned === true;
    // v1.5.7: a per-record decay multiplier (generic; no tag inspection anywhere)
    // stretches/shrinks the effective half-life for this event only.
    const eventHalfLife =
      Number.isFinite(event.decayRate) && event.decayRate > 0 ? halfLife / event.decayRate : halfLife;
    const decay = monthly || pinned
      ? 1
      : decayFactor({
          eventTime: event.anchorTime ?? event.eventTime,
          lastReinforcedAt: event.lastReinforcedAt,
          now,
          halfLifeDays: eventHalfLife,
          floor,
        });
    const tagScore = affinity.get(eventId) ?? 0;
    const tagAffinity = 1 + Math.min(2, tagScore);
    const lexical = text ? similarity(text, event.content) : 0;
    const lexicalBoost = text ? 0.6 + 0.4 * lexical : 1;
    const association = associationOf.get(eventId) ?? null;
    const associationFactor = association ? association.penalty : 1;
    const timeBoost = monthly && text && FUZZY_TIME_RE.test(text) ? 1.3 : 1;
    const score = event.salience * decay * tagAffinity * lexicalBoost * associationFactor * timeBoost * handoffFactor;
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
      ...(pinned ? { pinned: true } : {}),
      ...(association ? { association } : {}),
      // Marks the two hits that exist because the caller insisted on an oversized
      // tag, so the model knows this is a bounded preview, not the answer set.
      ...(oversizedRecentIds.has(eventId) ? { oversizedRecent: true } : {}),
      reinforcementCount: event.reinforcementCount ?? 0,
      snippet: snippet(event.content, 400),
    });
  }

  scored.sort((a, b) => b.score - a.score || a.eventId.localeCompare(b.eventId));
  // v1.5.6: a pinned record that matches the query is returned FIRST, before any
  // higher-scoring episode — that is the whole point of "pinned".
  if (scored.some((hit) => hit.pinned === true)) {
    scored = [
      ...scored.filter((hit) => hit.pinned === true),
      ...scored.filter((hit) => hit.pinned !== true),
    ];
    base.notes.push(`pinned-first:${scored.filter((hit) => hit.pinned === true).length}`);
  }
  if (scored.length > policy.retrieval.maxScannedEvents) {
    base.notes.push(`scan-capped:${policy.retrieval.maxScannedEvents}`);
    scored = scored.slice(0, policy.retrieval.maxScannedEvents);
  }

  const minScore = policy.candidates.minScore;
  let filtered = scored.filter((hit) => hit.pinned === true || hit.score >= minScore);
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
    oversizedTagHints,
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
 * Super-tag detection for the forensic layer (v1.5.0).
 *
 * `deepRaw` without a time window is an unbounded scan of raw turns. When the query
 * names a tag carried by more than `threshold` events, that scan is the tag
 * explosion one layer down — so Memory.deepRaw refuses and demands a window, using
 * this list to say WHY and which tags are responsible.
 *
 * A tag can be named two ways and both count: an explicit `tags` entry, or a token
 * in the free text (canonicalised through the index's own alias map, so a synonym
 * cannot slip past the gate). Pure read: a missing or partial index means "no super
 * tags", never a throw — the gate must not turn a degraded index into a failed call.
 */
export function superTagAssociations({ index, text = '', tags = [], threshold = SUPER_TAG_THRESHOLD } = {}) {
  if (!index || typeof index !== 'object' || !index.tags || typeof index.tags !== 'object') return [];
  const limit = Number.isFinite(threshold) ? threshold : SUPER_TAG_THRESHOLD;
  try {
    const aliases = index.aliases ?? {};
    const canonicalise = (tag) => {
      const token = normaliseTagToken(tag);
      if (!token) return '';
      return aliases[token] ?? token;
    };
    const explicit = Array.isArray(tags) ? tags : tags ? [tags] : [];
    const candidates = new Set([...explicit.map(canonicalise), ...tokenize(text).map(canonicalise)].filter(Boolean));
    const found = [];
    for (const tag of candidates) {
      const eventCount = Number(index.tags[tag]?.eventCount);
      if (!Number.isFinite(eventCount) || eventCount <= limit) continue;
      found.push({ tag, eventCount });
    }
    found.sort((a, b) => b.eventCount - a.eventCount || a.tag.localeCompare(b.tag));
    return found;
  } catch {
    return [];
  }
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
