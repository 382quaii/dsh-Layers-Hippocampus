/**
 * L2 multi-merge ("多合一蒸馏", v1.5.6).
 *
 * Over time a tag collects many near-duplicate L2 episodes (the same failure, the
 * same lesson, the same deployment note). This engine condenses each tag's
 * duplicates into ONE durable record and marks the sources as merged:
 *
 *   - PINNED and ORDINARY records are grouped SEPARATELY and never mixed
 *     (a pinned lesson must not be diluted by ordinary chatter, and vice versa);
 *   - the merged text = earliest/latest time + deduplicated core text (each source
 *     capped, the whole line capped by `l2Merge.maxSummaryChars`);
 *   - a pinned merge keeps `pinned: true` and inherits every tag;
 *   - `meta.global_tags` (federated big-tag metadata from the Orchestrator) is
 *     COPIED into the merged record's meta but NEVER becomes a tag — so it can never
 *     enter the sub-space inverted index;
 *   - the log stays append-only: "merged_into" is engine state
 *     (`state/l2-merge.json`), so originals stay recoverable; subsequent passes
 *     skip them and the merge is idempotent.
 *
 * Engine-driven, deterministic, dependency-free. Runs at the END of `maintain()`
 * (offline), never on the online path.
 */

import path from 'node:path';
import { ensureDir, readJson, snippet, writeJsonAtomic } from './util.js';

export const L2_MERGE_TAG = 'status:l2-merged';
export const L2_MERGE_STATE_SCHEMA = 1;
const INTERNAL_TAG = /^(?:status:|month:|context:)/;
const INTERNAL_TAGS = new Set(['active_task']);
const MAX_TRACKED_SOURCES = 50_000;

export const DEFAULT_L2_MERGE = Object.freeze({
  enabled: true,
  minGroupSize: 2,
  maxGroupsPerRun: 5,
  maxSummaryChars: 400,
});

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function dayOf(epochMs) {
  const date = new Date(Number(epochMs));
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '?';
}

function isInternal(tag) {
  return INTERNAL_TAGS.has(tag) || INTERNAL_TAG.test(tag);
}

function tagNames(event) {
  return (event.tags ?? []).map((tag) => (typeof tag === 'string' ? tag : tag?.tag)).filter((tag) => typeof tag === 'string' && tag);
}

export class L2MergeEngine {
  constructor({ memory, clock, getConfig }) {
    this.memory = memory;
    this.clock = clock;
    this.getConfig = getConfig ?? (() => ({}));
    this.file = path.join(memory.paths.state, 'l2-merge.json');
    this.state = null;
    this._running = false;
  }

  config() {
    const raw = this.getConfig?.() ?? {};
    return {
      enabled: raw.enabled !== false,
      minGroupSize: clampInt(raw.minGroupSize, DEFAULT_L2_MERGE.minGroupSize, 2, 20),
      maxGroupsPerRun: clampInt(raw.maxGroupsPerRun, DEFAULT_L2_MERGE.maxGroupsPerRun, 1, 50),
      maxSummaryChars: clampInt(raw.maxSummaryChars, DEFAULT_L2_MERGE.maxSummaryChars, 100, 2000),
    };
  }

  _load() {
    if (this.state) return this.state;
    const raw = readJson(this.file, null);
    const base = {
      schema: L2_MERGE_STATE_SCHEMA,
      mergedSourceIds: [],
      groups: {},
      stats: { runs: 0, groups: 0, sources: 0, lastRunAt: null },
    };
    if (!raw || raw.schema !== L2_MERGE_STATE_SCHEMA) {
      this.state = base;
      return this.state;
    }
    this.state = {
      ...base,
      ...raw,
      mergedSourceIds: [...new Set((Array.isArray(raw.mergedSourceIds) ? raw.mergedSourceIds : []).filter((id) => typeof id === 'string'))],
      groups: raw.groups && typeof raw.groups === 'object' ? { ...raw.groups } : {},
      stats: { ...base.stats, ...(raw.stats && typeof raw.stats === 'object' ? raw.stats : {}) },
    };
    return this.state;
  }

  _persist() {
    ensureDir(path.dirname(this.file));
    writeJsonAtomic(this.file, this._load());
  }

  status() {
    const state = this._load();
    return {
      schema: L2_MERGE_STATE_SCHEMA,
      mergedSources: state.mergedSourceIds.length,
      groups: Object.keys(state.groups).length,
      stats: { ...state.stats },
      enabled: this.config().enabled,
    };
  }

  /** Group candidate events by (primary tag, pinned|ordinary). */
  collectGroups(config, mergedIds) {
    const view = this.memory.indexManager?.snapshot?.();
    const rawEvents = view?.events;
    const events = rawEvents instanceof Map ? [...rawEvents.values()] : Array.isArray(rawEvents) ? rawEvents : [];
    const buckets = new Map();
    for (const event of events) {
      if (!event || typeof event.eventId !== 'string' || typeof event.content !== 'string') continue;
      if (mergedIds.has(event.eventId)) continue;
      const names = tagNames(event);
      if (names.length === 0 || names.some(isInternal)) continue;
      const candidates = names.filter((tag) => !isInternal(tag));
      if (candidates.length === 0) continue;
      const primary = candidates.slice().sort()[0];
      const layer = event.pinned === true ? 'pinned' : 'ordinary';
      const key = `${primary}|${layer}`;
      const bucket = buckets.get(key) ?? { tag: primary, layer, events: [] };
      bucket.events.push(event);
      buckets.set(key, bucket);
    }
    return [...buckets.values()]
      .filter((bucket) => bucket.events.length >= config.minGroupSize)
      .sort((a, b) => b.events.length - a.events.length || a.tag.localeCompare(b.tag) || a.layer.localeCompare(b.layer));
  }

  _buildText(tag, layer, sources, config) {
    const ordered = sources.slice().sort((a, b) => (a.eventTime ?? 0) - (b.eventTime ?? 0) || a.eventId.localeCompare(b.eventId));
    const first = dayOf(ordered[0]?.eventTime ?? 0);
    const last = dayOf(ordered[ordered.length - 1]?.eventTime ?? 0);
    const seen = new Set();
    const cores = [];
    for (const event of ordered) {
      const core = snippet(String(event.content).replace(/\s+/g, ' ').trim(), 200);
      if (!core) continue;
      const key = core.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cores.push(core);
      if (cores.length >= 4) break;
    }
    let text = `L2经验合并·${tag}（${ordered.length} 条 / ${first}~${last}，${layer === 'pinned' ? '固定' : '普通'}）：${cores.join('；')}`;
    // ASCII ellipsis on purpose: identity canonicalisation (NFKC) is length-stable
    // for "...", while a "…" would expand and silently exceed the cap.
    if (text.length > config.maxSummaryChars) text = `${text.slice(0, Math.max(1, config.maxSummaryChars - 3))}...`;
    return text;
  }

  async _mergeGroup(bucket, config, now, state) {
    const sources = bucket.events.slice();
    const sourceEventIds = sources.map((event) => event.eventId).sort();
    const tags = [...new Set(sources.flatMap((event) => tagNames(event)).filter((tag) => !isInternal(tag)))].sort();
    // Federated big-tag metadata is copied as META only: never a tag, so it can
    // never enter this sub-space's inverted index.
    const globalTags = [...new Set(sources.flatMap((event) => (Array.isArray(event.globalTags) ? event.globalTags : [])))].sort();
    const salience = Math.min(1, Math.max(0.6, ...sources.map((event) => Number(event.salience) || 0)));
    const pinned = bucket.layer === 'pinned';
    const result = await this.memory.remember({
      content: this._buildText(bucket.tag, bucket.layer, sources, config),
      tags: [...tags, L2_MERGE_TAG],
      salience,
      pinned,
      eventTime: now,
      meta: {
        l2_merged: true,
        merged_pinned: pinned,
        merged_count: sources.length,
        source_event_ids: sourceEventIds,
        ...(globalTags.length > 0 ? { global_tags: globalTags } : {}),
      },
    });
    for (const id of sourceEventIds) state.mergedSourceIds.push(id);
    state.groups[`${bucket.tag}|${bucket.layer}`] = {
      tag: bucket.tag,
      layer: bucket.layer,
      mergedEventId: result?.eventId ?? null,
      sources: sourceEventIds,
      at: now,
    };
    state.stats.mergedGroups = (state.stats.mergedGroups ?? 0) + 1;
    state.stats.mergedSources = (state.stats.mergedSources ?? 0) + sourceEventIds.length;
    return {
      tag: bucket.tag,
      layer: bucket.layer,
      eventId: result?.eventId ?? null,
      status: result?.status ?? null,
      sources: sourceEventIds,
      globalTags,
      text: String(result?.content ?? '').slice(0, 80),
    };
  }

  /**
   * Run one offline merge pass. Single-flight: a concurrent run is refused, never
   * queued (the maintenance gate already serialises, this is belt-and-braces).
   */
  async run({ now = this.clock.now() } = {}) {
    const config = this.config();
    if (!config.enabled) return { status: 'disabled', groups: 0, merged: 0, results: [] };
    if (this._running) return { status: 'skipped', reason: 'l2-merge-in-flight', groups: 0, merged: 0, results: [] };
    this._running = true;
    try {
      const state = this._load();
      // Bound the tracked set: only ids still present in the index matter.
      const view = this.memory.indexManager?.snapshot?.();
      const rawEvents = view?.events;
      const events = rawEvents instanceof Map ? [...rawEvents.values()] : Array.isArray(rawEvents) ? rawEvents : [];
      const alive = new Set(events.map((event) => event.eventId));
      state.mergedSourceIds = state.mergedSourceIds.filter((id) => alive.has(id)).slice(-MAX_TRACKED_SOURCES);
      const mergedIds = new Set(state.mergedSourceIds);
      const groups = this.collectGroups(config, mergedIds);
      const results = [];
      for (const bucket of groups.slice(0, config.maxGroupsPerRun)) {
        results.push(await this._mergeGroup(bucket, config, now, state));
      }
      state.stats.runs = (state.stats.runs ?? 0) + 1;
      state.stats.lastRunAt = now;
      this._persist();
      return {
        status: results.length > 0 ? 'ok' : 'idle',
        groups: groups.length,
        merged: results.length,
        results,
        stats: this.status(),
      };
    } finally {
      this._running = false;
    }
  }
}
