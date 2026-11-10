/**
 * Index construction — a PURE function of (log records, policy, now).
 *
 * Purity matters: "the index is rebuildable" is only true if rebuilding is a pure
 * fold over the log. Everything downstream (tag index, active set, day diaries,
 * tombstones, aliases) is derived here and nothing else. Delete `index/` at any
 * time and the next maintenance reproduces it byte-for-byte from the same log,
 * policy and clock instant.
 *
 * Derivation order:
 *   records -> fold (episodes / reinforcement / tombstones)
 *           -> canonicalised event projections
 *           -> tag table (postings + strength)
 *           -> active set (admission scores -> budget -> cap -> eviction)
 *           -> day diary blocks with covers
 */

import { MemoryError, ErrorCodes } from '../errors.js';
import { buildAliasMap, hashPolicy, normalisedScore, normaliseTagToken } from '../policy.js';
import { decayFactor } from '../decay.js';
import { clamp01, dayKey, round, sha256, snippet } from '../util.js';
import { RECORD_TYPES } from '../log/records.js';
import { dedupeTemplates } from './templates.js';

/**
 * Fold the log into the three things derivation needs.
 * Records are consumed in log order so a `restore` after a `forget` cancels it.
 */
export function foldRecords(records) {
  const episodes = new Map();
  const reinforcements = new Map(); // eventId -> {count, weight, lastLogTime}
  const tombstones = new Map(); // eventId -> {reason, at, mode}
  const unknownTypes = new Set();

  for (const record of records) {
    switch (record.type) {
      case RECORD_TYPES.EPISODE:
        // An event_id is immutable identity: re-appending the same id is a no-op
        // duplicate, not an edit.
        if (!episodes.has(record.event_id)) episodes.set(record.event_id, record);
        break;
      case RECORD_TYPES.REINFORCE: {
        const current = reinforcements.get(record.target) ?? { count: 0, weight: 0, lastLogTime: null };
        current.count += 1;
        current.weight += Number.isFinite(record.weight) ? record.weight : 1;
        if (current.lastLogTime === null || record.log_time > current.lastLogTime) {
          current.lastLogTime = record.log_time;
        }
        reinforcements.set(record.target, current);
        break;
      }
      case RECORD_TYPES.FORGET:
        tombstones.set(record.target, {
          reason: record.reason ?? 'unspecified',
          at: record.log_time,
          mode: record.mode ?? 'purge',
        });
        break;
      case RECORD_TYPES.RESTORE:
        tombstones.delete(record.target);
        break;
      default:
        unknownTypes.add(record.type);
        break;
    }
  }
  return { episodes, reinforcements, tombstones, unknownTypes: [...unknownTypes] };
}

/** Canonical tag resolution through the synonym map. */
export function canonicalTag(aliases, tag) {
  const token = normaliseTagToken(tag);
  if (!token) return '';
  return aliases.get(token) ?? token;
}

/**
 * Project one episode record into the flat shape retrieval scores.
 * Shared by full rebuild and by the incremental overlay, so both paths resolve
 * synonyms, clamp salience and derive `lastReinforcedAt` identically.
 *
 * @param {object} input
 * @param {object} input.episode episode record
 * @param {Map<string,string>} input.aliases
 * @param {{count:number,lastLogTime:number}|null} [input.reinforcement]
 */
export function projectEpisode({ episode, aliases, reinforcement = null }) {
  const strengthByTag = new Map();
  for (const tag of episode.tags ?? []) {
    const canonical = canonicalTag(aliases, tag.tag);
    if (!canonical) continue;
    const strength = Number.isFinite(tag.strength) ? clamp01(tag.strength) : 0.7;
    strengthByTag.set(canonical, Math.max(strength, strengthByTag.get(canonical) ?? 0));
  }
  // `event_time` is an identity coordinate: when it is derived from the content
  // hash (policy.identity.eventTimePolicy === 'content') it is deterministic but
  // says nothing about when the memory became true. Recency — decay, diary day,
  // temp-layer windows — therefore anchors on `log_time` for derived events, and
  // on `event_time` when the caller supplied one.
  const anchorTime = episode.time_source === 'content' ? episode.log_time : episode.event_time;
  return {
    eventId: episode.event_id,
    entityId: episode.entity_id ?? null,
    contentHash: episode.content_hash ?? null,
    occurrenceIndex: episode.occurrence_index ?? 0,
    eventTime: episode.event_time,
    anchorTime,
    logTime: episode.log_time,
    day: dayKey(anchorTime),
    salience: clamp01(Number(episode.salience ?? 0.5)),
    // v1.5.6: a pinned record never decays (charter: lessons must survive time).
    pinned: episode.meta?.pinned === true,
    // v1.5.7: generic per-record decay multiplier supplied through the cross-plugin
    // service (`customDecayRate` / `customHalfLifeDays`). The engine never inspects
    // tags here; null means "use the policy default".
    decayRate:
      Number.isFinite(episode.meta?.decay_rate) && episode.meta.decay_rate > 0 ? episode.meta.decay_rate : null,
    // Federated big-tag metadata (Orchestrator) is META only: it is exposed for the
    // L2 merge / federation layer but is never a tag, so it cannot enter this
    // sub-space's inverted index.
    globalTags: Array.isArray(episode.meta?.global_tags)
      ? [...new Set(episode.meta.global_tags.filter((tag) => typeof tag === 'string' && tag))].sort()
      : [],
    // v1.5.6: monthly-memo provenance, used by the read-time cross-space merge.
    sourceEventIds: Array.isArray(episode.meta?.source_event_ids)
      ? [...new Set(episode.meta.source_event_ids.filter((id) => typeof id === 'string' && id))].sort()
      : [],
    content: episode.content,
    tags: [...strengthByTag.entries()]
      .map(([tag, strength]) => ({ tag, strength: round(strength, 4) }))
      .sort((a, b) => a.tag.localeCompare(b.tag)),
    lastReinforcedAt: reinforcement ? reinforcement.lastLogTime : null,
    reinforcementCount: reinforcement ? reinforcement.count : 0,
  };
}

/**
 * @param {object} input
 * @param {object[]} input.records log records in log order
 * @param {Readonly<object>} input.policy resolved policy
 * @param {number} input.now epoch ms from the injected clock
 * @param {object[]} [input.semantic] folded semantic summaries (for reference counts only)
 * @param {string|null} [input.sourceLogGen]
 * @param {object|null} [input.previous] previous index, used to report churn
 * @param {number} [input.maxPostingsPerTag] physical cap on postings per tag (v1.5.0)
 */
export function buildIndex({
  records,
  policy,
  now,
  semantic = [],
  sourceLogGen = null,
  previous = null,
  tombstones = null,
  maxPostingsPerTag = 500,
}) {
  if (!Array.isArray(records)) throw new MemoryError(ErrorCodes.INVALID_INPUT, 'records must be an array');
  if (!Number.isFinite(now)) throw new MemoryError(ErrorCodes.INVALID_INPUT, 'now must be epoch ms');

  const aliases = buildAliasMap(policy);
  const { episodes, reinforcements, tombstones: folded, unknownTypes } = foldRecords(records);

  // Resurrection guard: the durable registry and the log's own forget records are
  // unioned, so a tombstone survives even after the purge rewrote the log.
  const tombstoneSet = new Set(typeof tombstones?.ids === 'function' ? tombstones.ids() : (tombstones ?? []));
  for (const eventId of folded.keys()) tombstoneSet.add(eventId);

  // ---- event projections --------------------------------------------------
  const events = [];
  let suppressed = 0;
  for (const [eventId, episode] of episodes) {
    if (tombstoneSet.has(eventId)) {
      suppressed += 1;
      continue;
    }
    events.push(projectEpisode({ episode, aliases, reinforcement: reinforcements.get(eventId) ?? null }));
  }
  // Deterministic order: newest first, ties broken by id. Index files must hash
  // identically across rebuilds, so no insertion-order dependence is allowed.
  events.sort((a, b) => b.anchorTime - a.anchorTime || a.eventId.localeCompare(b.eventId));

  // v1.6.1 referential dedup: the LOG keeps every raw row; the index stores repeated
  // long texts (tool schemas / system prompt blocks) ONCE and points at them.
  const deduped = dedupeTemplates(events);
  const indexedEvents = deduped.events;
  const templates = deduped.templates;

  const tags = deriveTagTable(indexedEvents, { policy, now, maxPostingsPerTag });
  const activeSet = deriveActiveSet(tags, { policy, now, previous });
  const diary = deriveDiary(indexedEvents, { policy, now });

  const stats = {
    // Log-side counters make the boot check a two-counter comparison.
    recordCount: records.length,
    episodes: episodes.size,
    events: events.length,
    suppressedByTombstone: suppressed,
    blocks: diary.blocks.length,
    tags: Object.keys(tags).length,
    activeTags: activeSet.entries.length,
    archivedTags: activeSet.archived.length,
    tombstones: tombstoneSet.size,
    reinforcements: [...reinforcements.values()].reduce((sum, r) => sum + r.count, 0),
    semanticSummaries: semantic.length,
    aliases: aliases.size,
    unknownRecordTypes: unknownTypes,
    // v1.5.0 physical-cap accounting: how many tags hit the posting ceiling and how
    // many event pointers were left out of the index (the log keeps them all).
    postingsTruncated: Object.values(tags).filter((entry) => entry.postingsTruncated).length,
    postingsDropped: Object.values(tags).reduce((sum, entry) => sum + entry.postingsDropped, 0),
    // v1.5.6: how many records are pinned (never decay, never archived).
    pinnedEvents: events.filter((event) => event.pinned === true).length,
    // v1.6.1 referential dedup accounting: one template row per repeated long text,
    // and how many characters the index no longer duplicates.
    templateRefs: deduped.stats.refs,
    templates: deduped.stats.templates,
    templateSavedChars: deduped.stats.savedChars,
  };

  return {
    version: 2,
    builtAt: now,
    policyHash: hashPolicy(policy),
    sourceLogGen,
    aliases: Object.fromEntries([...aliases.entries()].sort(([a], [b]) => a.localeCompare(b))),
    events: indexedEvents,
    templates,
    tags,
    activeSet,
    diary,
    tombstones: Object.fromEntries(
      [...tombstoneSet]
        .sort((a, b) => a.localeCompare(b))
        .map((id) => [id, folded.get(id) ?? { reason: 'tombstone-registry', mode: 'purge', at: null }]),
    ),
    stats,
  };
}

/**
 * tag -> postings + aggregate metrics used by both the online scorer and the
 * offline adjudicator.
 *
 * Physical cap (v1.5.0): one tag can be mentioned by an unbounded number of events,
 * so the index keeps at most `maxPostingsPerTag` postings per tag. The cap is
 * deliberately applied to the POINTER LIST ONLY: `eventCount` and `mass` are
 * accumulated over every matching event, because degradation thresholds ("this tag
 * has 600 events") and the honest totals in status/hints must stay true even when
 * the index only points at 500 of them.
 *
 * Which postings survive matters: retrieval order is recency, but retention order is
 * value — highest salience first, newest as the tie-break, eventId last for
 * determinism. A low-salience flood must not push out a decisive old memory just
 * because it arrived later.
 *
 * @param {object[]} events projections from buildIndex()
 * @param {{policy: Readonly<object>, now: number, maxPostingsPerTag?: number}} options
 */
export function deriveTagTable(events, { policy, now, maxPostingsPerTag = 500 }) {
  const table = {};
  const halfLife = policy.decay.halfLifeDays;
  // The config layer validates 1..100000; a direct caller gets the default rather
  // than a silently empty index (slice(0, 0) would drop every posting).
  const cap = Number.isFinite(maxPostingsPerTag) && maxPostingsPerTag >= 1 ? Math.floor(maxPostingsPerTag) : 500;

  for (const event of events) {
    const anchor = event.anchorTime ?? event.eventTime;
    const pinnedEvent = event.pinned === true;
    // v1.5.6: pinned records are exempt from time decay (they anchor lessons that
    // must remain retrievable regardless of age).
    const decay = pinnedEvent
      ? 1
      : decayFactor({
          eventTime: anchor,
          lastReinforcedAt: event.lastReinforcedAt,
          now,
          halfLifeDays: halfLife,
          floor: policy.decay.floor,
        });
    for (const { tag, strength } of event.tags) {
      const entry = table[tag] ?? {
        tag,
        postings: [],
        eventCount: 0,
        mass: 0,
        lastSeen: 0,
        lastReinforcedAt: null,
        reinforcementCount: 0,
        archived: false,
        pinned: false,
      };
      entry.postings.push({
        eventId: event.eventId,
        strength,
        eventTime: anchor,
        salience: event.salience,
        pinned: pinnedEvent,
      });
      if (pinnedEvent) entry.pinned = true;
      entry.eventCount += 1;
      entry.mass += event.salience * decay;
      entry.lastSeen = Math.max(entry.lastSeen, anchor);
      entry.reinforcementCount += event.reinforcementCount;
      if (event.lastReinforcedAt !== null) {
        entry.lastReinforcedAt = Math.max(entry.lastReinforcedAt ?? 0, event.lastReinforcedAt);
      }
      table[tag] = entry;
    }
  }

  for (const entry of Object.values(table)) {
    entry.postings.sort((a, b) => b.eventTime - a.eventTime || a.eventId.localeCompare(b.eventId));
    capPostings(entry, cap);
    entry.mass = round(entry.mass, 4);
    const lastActivity = Math.max(entry.lastSeen, entry.lastReinforcedAt ?? 0);
    const cold = now - lastActivity > policy.tags.archiveAfterDays * 86_400_000;
    // Low-frequency archival: cold AND thin. A cold but heavy tag stays: it still
    // carries a pattern worth retrieving. v1.5.6: a tag holding a pinned record is
    // never archived — pinned lessons must stay addressable.
    entry.archived = entry.pinned ? false : cold && entry.eventCount < policy.tags.archiveMinEvents;
  }

  return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Enforce the per-tag posting cap on one already-sorted entry.
 *
 * The flags are always present (not only on truncated tags) so a reader never has to
 * distinguish "unknown" from "not truncated": `postingsLimit` is the cap in force,
 * `postingsTruncated`/`postingsDropped` are 0/false for a tag below it. Only the
 * postings list changes here — aggregate counters stay over the full event set.
 */
function capPostings(entry, cap) {
  entry.postingsLimit = cap;
  if (entry.postings.length <= cap) {
    entry.postingsTruncated = false;
    entry.postingsDropped = 0;
    return;
  }
  const retained = entry.postings
    .slice()
    // v1.5.6: pinned postings are never the ones dropped by the physical cap.
    .sort(
      (a, b) =>
        Number(b.pinned === true) - Number(a.pinned === true) ||
        b.salience - a.salience ||
        b.eventTime - a.eventTime ||
        a.eventId.localeCompare(b.eventId),
    )
    .slice(0, cap);
  // Retention rank is not retrieval order: survivors go back to newest-first so the
  // cap is invisible to every existing consumer except for the dropped ids.
  retained.sort((a, b) => b.eventTime - a.eventTime || a.eventId.localeCompare(b.eventId));
  entry.postingsTruncated = true;
  entry.postingsDropped = entry.postings.length - retained.length;
  entry.postings = retained;
}

/**
 * Layer A of the tag index: the resident task list.
 *
 * Each entry is a *task* with a continuous priority and an entry budget. Admission
 * is a score crossing a threshold, never a boolean checkbox — so "just qualifies"
 * and "critically important" occupy different ranks and the eviction order can tell
 * them apart.
 */
export function deriveActiveSet(tags, { policy, now, previous = null }) {
  const config = policy.activeSet;
  const weights = config.weights;
  const halfLife = policy.decay.halfLifeDays;
  const decayOf = (time) =>
    decayFactor({
      eventTime: time,
      now,
      halfLifeDays: halfLife,
      floor: policy.decay.floor,
    });

  const scored = [];
  const archived = [];

  for (const entry of Object.values(tags)) {
    if (entry.archived) {
      archived.push({
        tag: entry.tag,
        reason: 'low-frequency',
        eventCount: entry.eventCount,
        lastSeen: entry.lastSeen,
        lastActivity: Math.max(entry.lastSeen, entry.lastReinforcedAt ?? 0),
      });
      continue;
    }
    const massScore = normalisedScore(entry.mass, config.massScale);
    const recencyScore = decayOf(entry.lastSeen);
    const reinforcementScore = normalisedScore(entry.reinforcementCount, Math.max(1, entry.eventCount));
    const priority = clamp01(
      weights.mass * massScore + weights.recency * recencyScore + weights.reinforcement * reinforcementScore,
    );
    // Decay anchor for eviction: the later of last activity and last reinforcement.
    // No stored field is consulted — `lastReinforcedAt` came from reinforce records.
    const anchor = entry.lastReinforcedAt ?? entry.lastSeen;
    const decayScore =
      anchor === entry.lastSeen && entry.lastReinforcedAt === null ? recencyScore : decayOf(anchor);

    scored.push({
      tag: entry.tag,
      priority: round(priority, 4),
      decayScore: round(decayScore, 4),
      evictionKey: round(priority * decayScore, 6),
      // "Eligible" is a threshold on the continuous score plus a volume floor.
      eligible: entry.eventCount >= config.minEvents && entry.mass >= config.minMass,
      // v1.5.6: a tag carrying a pinned record is admitted regardless of score.
      pinned: entry.pinned === true,
      eventCount: entry.eventCount,
      mass: entry.mass,
      lastSeen: entry.lastSeen,
      lastReinforcedAt: entry.lastReinforcedAt,
    });
  }

  // v1.5.6: pinned tags bypass the cap entirely (they are the anchors the whole
  // pinned mechanism exists to protect); ordinary tags compete for the remainder.
  const pinnedTags = scored.filter((s) => s.pinned);
  const eligible = scored.filter((s) => !s.pinned && s.eligible);
  // Eviction order documented in policy: priority * decay ascending; ties break on
  // the longest-unreinforced (`lastReinforcedAt ?? lastSeen` oldest first), then tag.
  eligible.sort((a, b) => {
    if (b.evictionKey !== a.evictionKey) return b.evictionKey - a.evictionKey;
    const aLast = a.lastReinforcedAt ?? a.lastSeen;
    const bLast = b.lastReinforcedAt ?? b.lastSeen;
    if (aLast !== bLast) return aLast - bLast;
    return a.tag.localeCompare(b.tag);
  });

  const pinnedKeep = pinnedTags.slice(0, config.cap);
  const remaining = Math.max(0, config.cap - pinnedKeep.length);
  const kept = [...pinnedKeep, ...eligible.slice(0, remaining)];
  const evicted = eligible.slice(remaining);

  const entries = kept.map((entry) => ({
    tag: entry.tag,
    priority: entry.priority,
    decayScore: entry.decayScore,
    // Budget is derived from priority, so an important tag gets more candidate
    // slots without a separate switch to maintain.
    budget: Math.max(1, Math.round(config.tagBudget * entry.priority)),
    eventCount: entry.eventCount,
    mass: entry.mass,
    lastSeen: entry.lastSeen,
    lastReinforcedAt: entry.lastReinforcedAt,
  }));

  const previousTags = new Set((previous?.activeSet?.entries ?? []).map((e) => e.tag));
  const currentTags = new Set(entries.map((e) => e.tag));

  return {
    cap: config.cap,
    tagBudget: config.tagBudget,
    generatedAt: now,
    entries,
    evicted: evicted.map((e) => ({
      tag: e.tag,
      priority: e.priority,
      decayScore: e.decayScore,
      reason: 'over-cap',
      lastReinforcedAt: e.lastReinforcedAt,
    })),
    archived,
    belowThreshold: scored
      .filter((s) => !s.pinned && !s.eligible)
      .map((s) => ({ tag: s.tag, priority: s.priority, eventCount: s.eventCount, mass: s.mass })),
    budgetUsed: entries.reduce((sum, e) => sum + e.budget, 0),
    churn: {
      admitted: [...currentTags].filter((tag) => !previousTags.has(tag)).sort(),
      dropped: [...previousTags].filter((tag) => !currentTags.has(tag)).sort(),
    },
  };
}

/**
 * Time coarse index: one block per UTC day, each with a cover summary.
 * Decay applies at block level (slower curve) and again at event level.
 */
export function deriveDiary(events, { policy, now }) {
  const byDay = new Map();
  for (const event of events) {
    const list = byDay.get(event.day) ?? [];
    list.push(event);
    byDay.set(event.day, list);
  }

  const blocks = [];
  for (const [day, list] of byDay) {
    const sorted = list
      .slice()
      .sort((a, b) => b.salience - a.salience || a.eventId.localeCompare(b.eventId));
    const decays = list.map((event) =>
      decayFactor({
        eventTime: event.anchorTime ?? event.eventTime,
        lastReinforcedAt: event.lastReinforcedAt,
        now,
        halfLifeDays: policy.decay.blockHalfLifeDays,
        floor: policy.decay.floor,
      }),
    );
    const tagCounts = new Map();
    for (const event of list) for (const { tag } of event.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    blocks.push({
      day,
      eventCount: list.length,
      salienceMass: round(list.reduce((sum, e) => sum + e.salience, 0), 4),
      decay: round(Math.max(...decays), 6),
      lastEventTime: Math.max(...list.map((e) => e.anchorTime ?? e.eventTime)),
      tags: [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([tag]) => tag),
      cover: sorted.slice(0, 3).map((event) => ({
        eventId: event.eventId,
        salience: event.salience,
        snippet: snippet(event.content, 160),
      })),
      eventIds: sorted.map((e) => e.eventId),
    });
  }

  blocks.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  return { blocks, generatedAt: now };
}

/**
 * Content hash of a derived index, so a reader can prove two builds of the same
 * (log, policy, now) agree — the property the "index is rebuildable" test asserts.
 */
export function indexDigest(index) {
  const haystack = JSON.stringify({
    events: index.events.map((e) => [e.eventId, e.salience, e.tags]),
    active: index.activeSet.entries.map((e) => [e.tag, e.priority]),
    blocks: index.diary.blocks.map((b) => [b.day, b.eventCount]),
    tombstones: Object.keys(index.tombstones ?? {}),
  });
  return sha256(haystack);
}
