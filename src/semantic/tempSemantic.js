/**
 * L2.5 — temporary semantic layer (trend quarantine).
 *
 * The threat this layer exists for: a model fed 1e4 conversation traces absorbs
 * the corpus' *statistical hot words* (meme phrasing, one-off trending slang,
 * register quirks) as if they were this user's traits. That is how a model turns
 * into a "naughty" assistant: it learned the crowd, not the person.
 *
 * So a trend never becomes a trait directly. It enters here, is scored over
 * `ttlDays`, and has exactly two exits at expiry:
 *
 *   - reinforced inside the final `promotionWindowDays` window AND confirmed by
 *     aggregation (>= 2 occurrences) -> promoted to L3, becomes a trait;
 *   - anything else -> deleted, including the quarantine record itself.
 *
 * There is deliberately no third outcome. "Maybe" is how noise survives, and the
 * TTL is the only thing that makes bounded storage possible.
 *
 * This layer is an INDEX + quarantine, never a source of truth: the underlying
 * episodes stay in the append-only log, and a rebuild re-derives everything from
 * the log plus this file's own append-only journal.
 */
import path from 'node:path';
import { DAY_MS } from '../clock.js';
import { invalidInput } from '../errors.js';
import {
  appendLineDurable,
  clamp01,
  ensureDir,
  isNonEmptyString,
  readJsonLines,
  sha256,
  snippet,
  writeFileAtomic,
} from '../util.js';

export const TEMP_RECORD_VERSION = 1;

export const TEMP_TYPES = Object.freeze({
  OBSERVE: 'temp_observe',
  PROMOTE: 'temp_promote',
  PURGE: 'temp_purge',
});

export const TEMP_STATUS = Object.freeze({
  TEMP: 'temp',
  PERMANENT: 'permanent',
});

/** Content-addressed: the same trend text always maps to the same id. */
export function tempIdFor(content) {
  return `tp_${sha256(normaliseTrendText(content)).slice(0, 16)}`;
}

/** Burst detection compares on this normalised form, not on raw bytes. */
export function normaliseTrendText(content) {
  return String(content ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, ' ')
    .slice(0, 2000);
}

export class TempSemanticStore {
  /**
   * @param {object}   options
   * @param {string}   options.root          `<dataDir>/semantic`
   * @param {object}   options.clock         Clock (now() only; never Date.now here)
   * @param {Function} options.ids           id factory from createIdFactory()
   * @param {object}   options.semanticStore L3 store, used only on promotion
   * @param {object}   options.getPolicy     () => resolved policy
   */
  constructor({ root, clock, ids, semanticStore, getPolicy, maxEntries }) {
    this.root = root;
    this.logPath = path.join(root, 'temp.log.jsonl');
    this.clock = clock;
    this.ids = ids;
    this.semanticStore = semanticStore;
    this.getPolicy = getPolicy;
    this.maxEntries = maxEntries ?? null;
    /** @type {Map<string, object>} tempId -> folded entry */
    this.entries = new Map();
    this.revision = 0;
    this.loaded = false;
  }

  async init() {
    ensureDir(this.root);
    this.load();
    this.loaded = true;
    return this;
  }

  /** Rebuild in-memory state from the append-only journal. */
  load() {
    this.entries.clear();
    this.revision = 0;
    for (const { value } of readJsonLines(this.logPath)) {
      if (value && typeof value === 'object') this.fold(value);
    }
    return this;
  }

  fold(record) {
    switch (record.type) {
      case TEMP_TYPES.OBSERVE: {
        const existing = this.entries.get(record.temp_id);
        // A promoted or purged entry is frozen: re-observing must not resurrect it.
        if (existing && existing.status !== TEMP_STATUS.TEMP) return;
        const fresh = Array.isArray(record.fresh_events) ? record.fresh_events : [];
        if (!existing) {
          this.entries.set(record.temp_id, {
            tempId: record.temp_id,
            content: record.content,
            sourceEvents: [...fresh],
            tags: [...(record.tags ?? [])],
            createdAt: record.created_at,
            lastHitAt: record.occurred_at,
            hitCount: Math.max(1, fresh.length),
            ttlDays: Number.isFinite(record.ttl_days) ? record.ttl_days : null,
            isTransientTrend: record.is_transient_trend !== false,
            status: TEMP_STATUS.TEMP,
            promotedSummaryId: null,
            promotedAt: null,
          });
          return;
        }
        for (const id of fresh) if (!existing.sourceEvents.includes(id)) existing.sourceEvents.push(id);
        for (const tag of record.tags ?? []) if (!existing.tags.includes(tag)) existing.tags.push(tag);
        existing.lastHitAt = Math.max(existing.lastHitAt, record.occurred_at);
        existing.hitCount += fresh.length;
        return;
      }
      case TEMP_TYPES.PROMOTE: {
        const entry = this.entries.get(record.temp_id);
        if (!entry) return;
        entry.status = TEMP_STATUS.PERMANENT;
        entry.promotedSummaryId = record.summary_id;
        entry.promotedAt = record.recorded_at;
        return;
      }
      case TEMP_TYPES.PURGE: {
        // The journal is rewritten after a purge, so a folded PURGE only happens
        // when a crash interrupted the rewrite. Mark it gone either way.
        this.entries.delete(record.temp_id);
        return;
      }
      default:
        return; // unknown record types are ignored, never fatal
    }
  }

  async appendRecord(record) {
    appendLineDurable(this.logPath, `${JSON.stringify(record)}\n`);
    this.fold(record);
    this.revision += 1;
    return record;
  }

  ttlFor(entry) {
    const policy = this.getPolicy?.();
    return Number.isFinite(entry.ttlDays) ? entry.ttlDays : (policy?.temp?.ttlDays ?? 30);
  }

  expiresAt(entry) {
    return entry.createdAt + this.ttlFor(entry) * DAY_MS;
  }

  view(entry, now = this.clock.now()) {
    if (!entry) return null;
    const expiresAt = this.expiresAt(entry);
    return {
      tempId: entry.tempId,
      status: entry.status,
      content: entry.content,
      snippet: snippet(entry.content, 240),
      tags: [...entry.tags],
      sourceEvents: [...entry.sourceEvents],
      hitCount: entry.hitCount,
      isTransientTrend: entry.isTransientTrend,
      createdAt: entry.createdAt,
      lastHitAt: entry.lastHitAt,
      ttlDays: this.ttlFor(entry),
      expiresAt,
      expired: now >= expiresAt,
      promotedSummaryId: entry.promotedSummaryId,
      promotedAt: entry.promotedAt,
    };
  }

  list({ status, now } = {}) {
    const out = [];
    for (const entry of this.entries.values()) {
      if (status && entry.status !== status) continue;
      out.push(this.view(entry, now));
    }
    return out.sort((a, b) => b.lastHitAt - a.lastHitAt || a.tempId.localeCompare(b.tempId));
  }

  countTemp() {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.status === TEMP_STATUS.TEMP) n += 1;
    return n;
  }

  /**
   * Record one occurrence of a candidate trend.
   *
   * `sourceEvents` are episode ids. An observation with no *new* source event is
   * a duplicate and is dropped, which keeps repeated maintenance sweeps
   * idempotent (the same 3 episodes must not add 3 hits on every run).
   */
  async observe({
    content,
    sourceEvents = [],
    tags = [],
    occurredAt,
    isTransientTrend = true,
    ttlDays,
    now = this.clock.now(),
  }) {
    if (!isNonEmptyString(content)) throw invalidInput('trend content must be a non-empty string');
    const tempId = tempIdFor(content);
    const existing = this.entries.get(tempId);
    const fresh = [...new Set(sourceEvents.filter(Boolean))].filter(
      (id) => !existing || !existing.sourceEvents.includes(id),
    );

    if (existing && existing.status !== TEMP_STATUS.TEMP) {
      return { action: 'ignored', reason: `status:${existing.status}`, tempId, entry: this.view(existing, now) };
    }
    if (existing && fresh.length === 0) {
      return { action: 'duplicate', tempId, entry: this.view(existing, now) };
    }
    const cap = this.maxEntries ?? this.getPolicy?.()?.temp?.maxEntries ?? 500;
    if (!existing && this.countTemp() >= cap) {
      return { action: 'over-cap', reason: `temp.maxEntries=${cap}`, tempId, entry: null };
    }

    const at = Number.isFinite(occurredAt) ? occurredAt : now;
    await this.appendRecord({
      v: TEMP_RECORD_VERSION,
      type: TEMP_TYPES.OBSERVE,
      temp_id: tempId,
      content: String(content).trim(),
      fresh_events: fresh,
      tags: [...tags],
      occurred_at: at,
      created_at: existing ? existing.createdAt : at,
      ttl_days: Number.isFinite(ttlDays) ? ttlDays : (existing ? existing.ttlDays : null),
      is_transient_trend: isTransientTrend !== false,
      recorded_at: now,
    });
    return {
      action: existing ? 'reinforced' : 'observed',
      tempId,
      entry: this.view(this.entries.get(tempId), now),
    };
  }

  /**
   * Expiry adjudication — the only place where an entry leaves the quarantine.
   *
   * Promotion needs BOTH: the last reinforcement inside the trailing
   * `promotionWindowDays`, AND aggregation confirmation (>= 2 occurrences).
   * Everything else is purged, and the purge is a physical rewrite of this
   * journal (copy-on-write: temp file + rename), never a blocking in-place edit.
   */
  async adjudicate({ now = this.clock.now(), policy } = {}) {
    const pol = policy ?? this.getPolicy?.();
    const windowMs = (pol?.temp?.promotionWindowDays ?? 20) * DAY_MS;
    const promoted = [];
    const purged = [];
    let retained = 0;

    for (const entry of [...this.entries.values()]) {
      if (entry.status !== TEMP_STATUS.TEMP) continue;
      const expiresAt = this.expiresAt(entry);
      if (now < expiresAt) {
        retained += 1;
        continue;
      }
      const windowStart = expiresAt - windowMs;
      const reinforcedInWindow = entry.lastHitAt >= windowStart;
      const aggregationConfirmed = entry.hitCount >= 2;

      if (reinforcedInWindow && aggregationConfirmed) {
        const summary = this.semanticStore.upsert({
          nextId: this.ids,
          clock: this.clock,
          title: `Trend: ${snippet(entry.content, 40)}`,
          text: entry.content,
          confidence: clamp01(0.5 + 0.1 * entry.hitCount),
          tags: entry.tags,
          sourceEvents: entry.sourceEvents,
        });
        await this.appendRecord({
          v: TEMP_RECORD_VERSION,
          type: TEMP_TYPES.PROMOTE,
          temp_id: entry.tempId,
          summary_id: summary.summaryId,
          hit_count: entry.hitCount,
          recorded_at: now,
        });
        promoted.push({ tempId: entry.tempId, summaryId: summary.summaryId, hitCount: entry.hitCount });
      } else {
        purged.push(entry.tempId);
      }
    }

    if (purged.length > 0) {
      for (const tempId of purged) {
        await this.appendRecord({
          v: TEMP_RECORD_VERSION,
          type: TEMP_TYPES.PURGE,
          temp_id: tempId,
          reason: 'expired-without-reinforcement',
          recorded_at: now,
        });
      }
      await this.rewrite();
    }

    return {
      promoted,
      purged,
      retained,
      expired: promoted.length + purged.length,
      windowMs,
    };
  }

  /**
   * Burst detection: one-off repetition becomes a quarantine candidate, not a
   * trait. `now` is the clock, the window is trailing — never a fixed calendar.
   */
  async detectBursts({ episodes = [], now = this.clock.now(), policy } = {}) {
    const pol = policy ?? this.getPolicy?.();
    const windowMs = (pol?.temp?.burstWindowDays ?? 3) * DAY_MS;
    const minOccurrences = pol?.temp?.burstMinOccurrences ?? 3;
    const windowStart = now - windowMs;

    const groups = new Map();
    for (const episode of episodes) {
      if (!episode?.content) continue;
      const at = episode.anchorTime ?? episode.eventTime;
      if (!(at >= windowStart && at <= now)) continue;
      const key = normaliseTrendText(episode.content);
      if (!key) continue;
      const bucket = groups.get(key) ?? [];
      bucket.push(episode);
      groups.set(key, bucket);
    }

    const bursts = [];
    for (const bucket of groups.values()) {
      if (bucket.length < minOccurrences) continue;
      bucket.sort(
        (a, b) => (a.anchorTime ?? a.eventTime) - (b.anchorTime ?? b.eventTime) || a.eventId.localeCompare(b.eventId),
      );
      let last = null;
      for (const episode of bucket) {
        const tags = (episode.tags ?? []).map((t) => (typeof t === 'string' ? t : t.tag)).filter(Boolean);
        const result = await this.observe({
          content: episode.content,
          sourceEvents: [episode.eventId],
          tags,
          occurredAt: episode.anchorTime ?? episode.eventTime,
          isTransientTrend: true,
          now,
        });
        if (result.entry) last = result.entry;
      }
      if (last) bursts.push({ tempId: last.tempId, count: bucket.length, hitCount: last.hitCount });
    }
    return { bursts, windowStart, windowMs };
  }

  /** One maintenance step: aggregate bursts first, then adjudicate expiries. */
  async sweep({ episodes = [], now = this.clock.now(), policy } = {}) {
    const burst = await this.detectBursts({ episodes, now, policy });
    const adjudication = await this.adjudicate({ now, policy });
    return { ...adjudication, bursts: burst.bursts, burstWindowStart: burst.windowStart };
  }

  /** Physical rewrite of the quarantine journal (drops purged entries). */
  async rewrite() {
    const now = this.clock.now();
    const lines = [];
    for (const entry of this.entries.values()) {
      lines.push(
        JSON.stringify({
          v: TEMP_RECORD_VERSION,
          type: TEMP_TYPES.OBSERVE,
          temp_id: entry.tempId,
          content: entry.content,
          fresh_events: entry.sourceEvents,
          tags: entry.tags,
          occurred_at: entry.lastHitAt,
          created_at: entry.createdAt,
          ttl_days: entry.ttlDays,
          is_transient_trend: entry.isTransientTrend,
          recorded_at: now,
        }),
      );
      if (entry.status === TEMP_STATUS.PERMANENT) {
        lines.push(
          JSON.stringify({
            v: TEMP_RECORD_VERSION,
            type: TEMP_TYPES.PROMOTE,
            temp_id: entry.tempId,
            summary_id: entry.promotedSummaryId,
            recorded_at: entry.promotedAt ?? now,
          }),
        );
      }
    }
    writeFileAtomic(this.logPath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
    this.load();
  }

  status({ now = this.clock.now() } = {}) {
    const entries = this.list({ now });
    return {
      revision: this.revision,
      total: entries.length,
      temp: entries.filter((e) => e.status === TEMP_STATUS.TEMP).length,
      permanent: entries.filter((e) => e.status === TEMP_STATUS.PERMANENT).length,
      expiringSoon: entries.filter((e) => e.status === TEMP_STATUS.TEMP && !e.expired).length,
      entries,
    };
  }

  /** Rendered into the system-prompt context block; always explicit. */
  render({ now = this.clock.now() } = {}) {
    const entries = this.list({ status: TEMP_STATUS.TEMP, now });
    if (entries.length === 0) return '';
    return entries
      .slice(0, 10)
      .map((e) => `- [temp, hits=${e.hitCount}, ttl=${e.ttlDays}d] ${snippet(e.content, 120)}`)
      .join('\n');
  }
}
