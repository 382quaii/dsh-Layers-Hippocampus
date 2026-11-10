/**
 * Semantic layer: patterns, habits and preferences distilled from episodes.
 *
 * Deliberately a SEPARATE append-only log (`semantic/sem.log.jsonl`) with its own
 * lifecycle. It is not part of the episode log and is never rewritten by episode
 * deletion or log compaction. That is what "episodic memory may die, patterns do
 * not" means mechanically: purging an episode cannot touch this file.
 *
 * A summary carries `confidence` and `updatedAt`; it is versioned by summary_id so
 * re-running consolidation is idempotent instead of appending duplicates.
 */

import path from 'node:path';
import { MemoryError, ErrorCodes } from '../errors.js';
import {
  appendLineDurable,
  canonicalJson,
  ensureDir,
  readJson,
  readJsonLines,
  sha256,
  writeJsonAtomic,
} from '../util.js';
import { normaliseTagToken } from '../policy.js';
import { extractTags } from '../tagging.js';
import { controlIdFor } from '../identity.js';

export const SUMMARY_TYPES = Object.freeze({ UPSERT: 'semantic_upsert', RETIRE: 'semantic_retire' });

/** Content-addressed summary id: same sources + same title produce the same id. */
export function summaryIdFor({ title, sourceEvents }) {
  const material = `${title}|${[...sourceEvents].sort().join(',')}`;
  return `sm_${sha256(material).slice(0, 16)}`;
}

export class SemanticStore {
  constructor({ root, valueFile = 'sem.log.jsonl', snapshotFile = 'sem.snapshot.json' }) {
    this.root = root;
    this.valueFile = path.join(root, valueFile);
    this.snapshotFile = path.join(root, snapshotFile);
    this._seq = 0;
    ensureDir(root);
  }

  /**
   * Deterministic semantic-event id: (content_hash, event_time, position).
   * Position is the semantic-log line number, so replaying the same semantic log
   * with the same clock reproduces exactly the same ids.
   */
  nextEventId({ clock, payload }) {
    const contentHash = sha256(canonicalJson(payload));
    const eventId = controlIdFor({
      type: 'summary',
      contentHash,
      eventTime: clock.now(),
      occurrenceIndex: this._seq,
    });
    this._seq += 1;
    return eventId;
  }

  /**
   * Fold the append-only semantic log into current summaries.
   * @returns {object[]} latest version per summary_id, retire events removed
   */
  list() {
    const byId = new Map();
    let lines = 0;
    for (const { value } of readJsonLines(this.valueFile)) {
      lines += 1;
      if (value?.type === SUMMARY_TYPES.UPSERT) byId.set(value.summary_id, { ...value });
      else if (value?.type === SUMMARY_TYPES.RETIRE) byId.delete(value.summary_id);
    }
    if (this._seq < lines) this._seq = lines;
    return [...byId.values()]
      .map((record) => {
        const tags = record.tags ?? [];
        return {
          summaryId: record.summary_id,
          title: record.title,
          text: record.text,
          confidence: record.confidence,
          tags,
          sourceEvents: record.source_events ?? [],
          firstSeenAt: record.first_seen_at ?? record.log_time,
          updatedAt: record.log_time,
          // v1.5.6: historical summaries written before the tag invariant existed are
          // READABLE but marked degraded instead of being silently rewritten.
          degraded: tags.length === 0,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt || a.summaryId.localeCompare(b.summaryId));
  }

  covers(eventId) {
    return this.list().filter((summary) => summary.sourceEvents.includes(eventId));
  }

  /**
   * Idempotent upsert. Re-running consolidation with the same inputs is a no-op.
   * @param {object} input
   * @param {Function} input.nextId id factory
   * @param {object} input.clock
   */
  upsert({ clock, title, text, confidence, tags = [], sourceEvents = [] }) {
    if (!title || !text) throw new MemoryError(ErrorCodes.INVALID_INPUT, 'summary needs title and text');
    const mergedTags = [...new Set(tags.map(normaliseTagToken).filter(Boolean))].sort();
    // v1.5.6 invariant: an L3 summary without an anchor is dead knowledge — tag-driven
    // retrieval can never reach it. Refuse at the explicit API; the offline callers
    // derive a deterministic fallback tag instead (see ensureForEvent).
    if (mergedTags.length === 0) {
      throw new MemoryError(ErrorCodes.SEMANTIC_TAG_REQUIRED, 'semantic summary requires at least one tag', {
        title,
        sourceEvents: [...sourceEvents].sort(),
        hint: '提供 tags，或让写作路径从内容提取（extractTags）；离线路径会写 origin:unlabelled-* 兜底锚点',
      });
    }
    const summaryId = summaryIdFor({ title, sourceEvents });
    const existing = this.list().find((summary) => summary.summaryId === summaryId);
    const record = {
      v: 1,
      type: SUMMARY_TYPES.UPSERT,
      summary_id: summaryId,
      title,
      text,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
      tags: mergedTags,
      source_events: [...sourceEvents].sort(),
      first_seen_at: existing?.firstSeenAt ?? clock.now(),
      event_time: clock.now(),
      log_time: clock.now(),
      event_id: this.nextEventId({ clock, payload: { summaryId, text, confidence, tags: mergedTags } }),
    };
    appendLineDurable(this.valueFile, `${JSON.stringify(record)}\n`);
    return this.summarise(record);
  }

  retire({ clock, summaryId, reason = 'superseded' }) {
    const record = {
      v: 1,
      type: SUMMARY_TYPES.RETIRE,
      summary_id: summaryId,
      reason,
      event_time: clock.now(),
      log_time: clock.now(),
      event_id: this.nextEventId({ clock, payload: { summaryId, reason, retire: true } }),
    };
    appendLineDurable(this.valueFile, `${JSON.stringify(record)}\n`);
    return record;
  }

  /**
   * Deterministic extractive distillation of one episode.
   * No model call is required on the delete path: deletion must be able to complete
   * offline and under maintenance, so the default distiller is mechanical.
   * A caller may inject a better distiller later (same signature).
   */
  ensureForEvent({ nextId, clock, event, reason = 'delete-consolidation' }) {
    // v1.5.6: the offline path must never fail the delete pipeline, but it must also
    // never write dead knowledge. Fallback chain: event tags -> content heuristics ->
    // an explicit provenance anchor.
    const tags = (event.tags ?? []).map((t) => (typeof t === 'string' ? t : t.tag)).filter(Boolean);
    const derived = tags.length > 0 ? [] : extractTags(event.content, { maxTags: 2 });
    const finalTags = tags.length > 0 ? tags : derived.length > 0 ? derived : ['origin:unlabelled-episode'];
    const anchor = finalTags.slice(0, 3).join(' + ');
    const title = tags.length > 0 ? `Pattern: ${anchor}` : `Pattern: ${anchor} (derived)`;
    const text = `Distilled from a high-salience episode (${reason}). ${event.content.slice(0, 600)}`;
    const confidence = Math.max(
      0.3,
      Math.min(0.95, 0.45 + 0.2 * (event.salience ?? 0.5) + 0.1 * (event.reinforcementCount ?? 0)),
    );
    return this.upsert({
      nextId,
      clock,
      title,
      text,
      confidence,
      tags: finalTags,
      sourceEvents: [event.event_id],
    });
  }

  /** Derived, compacted view; safe to delete, never a truth source. */
  snapshot(clock) {
    const summaries = this.list();
    writeJsonAtomic(this.snapshotFile, { generatedAt: clock?.now() ?? null, summaries });
    return summaries;
  }

  status() {
    const summaries = this.list();
    const cache = readJson(this.snapshotFile, null);
    return {
      summaries: summaries.length,
      lastUpdatedAt: summaries[0]?.updatedAt ?? null,
      snapshotPresent: Boolean(cache),
    };
  }

  /**
   * L3 capacity breaker (v1.6.1): the semantic layer must grow with event
   * IMPORTANCE, never with conversation count. When the folded view exceeds
   * `maxEntries`, the least-recently-updated summaries are retired via the
   * append-only `semantic_retire` record — never deleted from the file, so the
   * decision itself stays auditable and replayable.
   *
   * @param {{clock: object, maxEntries?: number, lruOnCap?: boolean}} input
   * @returns {{kept: number, retired: string[], capped: boolean}}
   */
  enforceCapacity({ clock, maxEntries, lruOnCap = true }) {
    const cap = Number.isFinite(maxEntries) ? Math.max(1, Math.floor(maxEntries)) : Infinity;
    const summaries = this.list();
    if (!lruOnCap || !Number.isFinite(cap) || summaries.length <= cap) {
      return { kept: summaries.length, retired: [], capped: false };
    }
    // `list()` is sorted newest-first by updatedAt, so the tail is the LRU end.
    const excess = summaries.slice(cap);
    const retired = excess.map((summary) => summary.summaryId);
    for (const summaryId of retired) this.retire({ clock, summaryId, reason: 'capacity-lru' });
    return { kept: summaries.length - retired.length, retired, capped: true };
  }

  summarise(record) {
    return {
      summaryId: record.summary_id,
      title: record.title,
      text: record.text,
      confidence: record.confidence,
      tags: record.tags,
      sourceEvents: record.source_events,
      firstSeenAt: record.first_seen_at,
      updatedAt: record.log_time,
      degraded: (record.tags ?? []).length === 0,
    };
  }
}
