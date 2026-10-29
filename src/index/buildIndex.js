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
 */
export function buildIndex({ records, policy, now, semantic = [], sourceLogGen = null, previous = null, tombstones = null }) {
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

  const tags = deriveTagTable(events, { policy, now });
  const activeSet = deriveActiveSet(tags, { policy, now, previous });
  const diary = deriveDiary(events, { policy, now });

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
  };

  return {
    version: 2,
    builtAt: now,
    policyHash: hashPolicy(policy),
    sourceLogGen,
    aliases: Object.fromEntries([...aliases.entries()].sort(([a], [b]) => a.localeCompare(b))),
    events,
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
 */
export function deriveTagTable(events, { policy, now }) {
  const table = {};
  const halfLife = policy.decay.halfLifeDays;

  for (const event of events) {
    const anchor = event.anchorTime ?? event.eventTime;
    const decay = decayFactor({
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
      };
      entry.postings.push({
        eventId: event.eventId,
        strength,
        eventTime: anchor,
        salience: event.salience,
      });
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
    entry.mass = round(entry.mass, 4);
    const lastActivity = Math.max(entry.lastSeen, entry.lastReinforcedAt ?? 0);
    const cold = now - lastActivity > policy.tags.archiveAfterDays * 86_400_000;
    // Low-frequency archival: cold AND thin. A cold but heavy tag stays: it still
    // carries a pattern worth retrieving.
    entry.archived = cold && entry.eventCount < policy.tags.archiveMinEvents;
  }

  return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)));
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
      eventCount: entry.eventCount,
      mass: entry.mass,
      lastSeen: entry.lastSeen,
      lastReinforcedAt: entry.lastReinforcedAt,
    });
  }

  const eligible = scored.filter((s) => s.eligible);
  // Eviction order documented in policy: priority * decay ascending; ties break on
  // the longest-unreinforced (`lastReinforcedAt ?? lastSeen` oldest first), then tag.
  eligible.sort((a, b) => {
    if (b.evictionKey !== a.evictionKey) return b.evictionKey - a.evictionKey;
    const aLast = a.lastReinforcedAt ?? a.lastSeen;
    const bLast = b.lastReinforcedAt ?? b.lastSeen;
    if (aLast !== bLast) return aLast - bLast;
    return a.tag.localeCompare(b.tag);
  });

  const kept = eligible.slice(0, config.cap);
  const evicted = eligible.slice(config.cap);

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
      .filter((s) => !s.eligible)
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
