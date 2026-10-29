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
      .map((record) => ({
        summaryId: record.summary_id,
        title: record.title,
        text: record.text,
        confidence: record.confidence,
        tags: record.tags ?? [],
        sourceEvents: record.source_events ?? [],
        firstSeenAt: record.first_seen_at ?? record.log_time,
        updatedAt: record.log_time,
      }))
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
    const tags = (event.tags ?? []).map((t) => (typeof t === 'string' ? t : t.tag));
    const title = tags.length > 0 ? `Pattern: ${tags.slice(0, 3).join(' + ')}` : 'Pattern: unlabelled episode';
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
      tags,
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
    };
  }
}
