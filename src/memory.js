/**
 * Memory facade — the seam between the DSH plugin adapter and the storage layers.
 *
 *   const memory = await Memory.open({ dataDir, clock: new FakeClock(t0), policy });
 *   await memory.remember({ content: '...', tags: ['topic'], eventTime: t0 });
 *   await memory.recall({ text: '...' });
 *
 * Identity discipline enforced here, in one place:
 *   - `remember` resolves content_hash -> event_time -> DEDUPE -> occurrence_index
 *     -> event_id (see log/ingest.js). A replay returns the existing event id and
 *     writes nothing; a genuine repeat at the same instant gets the next index.
 *   - control records (reinforce/forget/restore) derive their ids from
 *     (type, target, time, log position), so replaying the log reproduces them.
 *
 * Layering budget (what each layer may touch):
 *   log      truth source, append-only; rewritten only by compaction/purge
 *   index    derived, rebuildable, A/B double-buffered; never authoritative
 *   semantic separate truth stream; unaffected by episode deletion
 */

import fs from 'node:fs';
import path from 'node:path';
import { assertClock, SystemClock } from './clock.js';
import { DeletePipeline } from './deletePipeline.js';
import { MemoryError, ErrorCodes, invalidInput } from './errors.js';
import { buildAliasMap, hashPolicy, resolvePolicy } from './policy.js';
import { controlIdFor } from './identity.js';
import { makeForget, makeReinforce, makeRestore } from './log/records.js';
import { ingestEpisode } from './log/ingest.js';
import { LogStore } from './log/logStore.js';
import { DeadLetterQueue, IdentityLedger, TombstoneStore } from './log/identityLedger.js';
import { IndexStore } from './index/indexStore.js';
import { IndexManager } from './index/indexManager.js';
import { GraphCache, GRAPH_HARD_CAP, GRAPH_TOP_NEIGHBORS } from './graph.js';
import { foldRecords } from './index/buildIndex.js';
import { Maintenance } from './maintenance.js';
import { recall as runRecall, tokenize } from './retrieval.js';
import { SemanticStore } from './semantic/semanticStore.js';
import { TempSemanticStore } from './semantic/tempSemantic.js';
import { ContextEngine } from './context/contextEngine.js';
import { nextRun, parseCron } from './cron.js';
import { ensureDir, dayKey, genNumber, sha256, readJson, writeJsonAtomic, snippet } from './util.js';

/** Recursive byte size of a directory tree (symlinks count as their target size). */
function diskUsage(dir) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
      } catch {
        /* a file removed mid-walk simply does not count */
      }
    }
  };
  walk(dir);
  return total;
}

/** Accepted media kinds for `media_url` attachments. */
export const MEDIA_TYPES = Object.freeze(['image', 'video', 'document', 'audio']);
/** A run this long of base64 alphabet characters means the bytes were pasted into `content`. */
export const BASE64_RUN_LIMIT = 256;
/** Snapshot shape for state/active-task.json. */
export const ACTIVE_TASK_SCHEMA = 1;
/** A checkpoint nobody refreshed for this long is demoted by maintenance. */
export const ACTIVE_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Neighbours of a query tag that enter the candidate pool. */
export const GRAPH_ASSOCIATIONS = 3;
/** Score multiplier for an event reached only through a graph neighbour. */
export const ASSOCIATION_PENALTY = 0.5;
/** Evicted blocks folded into one episode per batch. */
export const FOLD_BATCH = 5;
/** Tag written on a folded-context episode. */
export const FOLDED_TAG = 'status:folded';
/** Tag written on a monthly memo. */
export const MONTHLY_TAG = 'status:monthly';

const BASE64_RUN = /[A-Za-z0-9+/]{256,}={0,2}/;
const ABSOLUTE_MEDIA = /^([A-Za-z]:[\\/]|\\\\|\/)/;

/**
 * Reject embedded base64 payloads past the documented threshold. The rule is
 * length-only (>= 256 consecutive base64 characters), so a 200-character run is
 * ordinary text and passes: false positives here would reject real prose.
 */
export function ensureNoEmbeddedBase64(content) {
  if (typeof content !== 'string') return;
  const match = BASE64_RUN.exec(content);
  if (!match) return;
  throw new MemoryError(
    ErrorCodes.INVALID_MEDIA,
    `content embeds a base64 payload of ${match[0].length} characters (limit ${BASE64_RUN_LIMIT}); store it as a file and pass media_url instead`,
    { key: 'content', runLength: match[0].length, limit: BASE64_RUN_LIMIT, hint: 'use media_url + media_type' },
  );
}

/** `media_url` is a pointer, never inline bytes. */
export function validateMedia(mediaUrl, mediaType) {
  if (mediaUrl === null || mediaUrl === undefined || mediaUrl === '') {
    if (mediaType !== null && mediaType !== undefined) {
      throw new MemoryError(ErrorCodes.INVALID_MEDIA, 'media_type requires media_url', { key: 'media_type' });
    }
    return null;
  }
  if (typeof mediaUrl !== 'string') {
    throw new MemoryError(ErrorCodes.INVALID_MEDIA, 'media_url must be a string', { key: 'media_url' });
  }
  const isHttp = /^https?:\/\//i.test(mediaUrl);
  const isAbsolutePath = ABSOLUTE_MEDIA.test(mediaUrl);
  if (!isHttp && !isAbsolutePath) {
    throw new MemoryError(
      ErrorCodes.INVALID_MEDIA,
      'media_url must be an http(s) URL or an absolute file path',
      { key: 'media_url', got: mediaUrl.slice(0, 80) },
    );
  }
  if (mediaType === null || mediaType === undefined) {
    throw new MemoryError(ErrorCodes.INVALID_MEDIA, 'media_type is required when media_url is set', {
      key: 'media_type',
      allowed: MEDIA_TYPES,
    });
  }
  if (!MEDIA_TYPES.includes(mediaType)) {
    throw new MemoryError(ErrorCodes.INVALID_MEDIA, `media_type must be one of ${MEDIA_TYPES.join(' | ')}`, {
      key: 'media_type',
      got: mediaType,
      allowed: MEDIA_TYPES,
    });
  }
  return { url: mediaUrl, type: mediaType };
}

/** Names mentioned as @handle or Capitalised-Latin runs — cheap, deterministic. */
function extractNames(text) {
  const found = new Set();
  for (const match of String(text).matchAll(/@([\w\u4e00-\u9fa5]{2,20})/g)) found.add(match[1]);
  for (const match of String(text).matchAll(/\b([A-Z][a-z]{2,15})\b/g)) found.add(match[1]);
  return [...found].slice(0, 5);
}

/** Task statements: `任务：…`, `TODO: …`, `目标: …`. */
function extractTasks(text) {
  const found = new Set();
  for (const match of String(text).matchAll(/(?:任务|目标|TODO|Task|task)\s*[:：]\s*([^\n。；;]{2,60})/g)) {
    found.add(match[1].trim());
  }
  return [...found].slice(0, 5);
}

function firstSentence(text) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return '';
  const cut = line.split(/[。.!?！？]/)[0] || line;
  return snippet(cut, 80);
}

const SUBDIRS = Object.freeze({  log: 'log',
  archive: 'archive',
  index: 'index',
  semantic: 'semantic',
  journal: 'journal',
  state: 'state',
  identity: 'identity',
});

export class Memory {
  /**
   * @param {object} options
   * @param {string} options.dataDir absolute directory owned by this plugin
   * @param {object} [options.clock] Clock with now(); never defaulted in tests
   * @param {object} [options.policy] partial policy overrides
   * @param {object} [options.config] { maxSegmentRecords, context }
   */
  constructor({ dataDir, clock = new SystemClock(), policy = {}, config = {} }) {
    if (!dataDir) throw new MemoryError(ErrorCodes.INVALID_CONFIG, 'dataDir is required');
    assertClock(clock);
    this.dataDir = path.resolve(dataDir);
    this.clock = clock;
    this.config = config;
    this.policy = resolvePolicy(policy);
    this.policyHash = hashPolicy(this.policy);

    this.paths = Object.fromEntries(
      Object.entries(SUBDIRS).map(([key, name]) => [key, path.join(this.dataDir, name)]),
    );

    this.logStore = new LogStore({
      root: this.paths.log,
      archiveRoot: this.paths.archive,
      maxSegmentRecords: config.maxSegmentRecords ?? this.policy.maintenance.maxSegmentRecords,
    });

    // ---- identity & tombstone ledgers (derived from the log at open) --------
    this.ledger = new IdentityLedger({ file: path.join(this.paths.identity, 'ledger.json') });
    this.tombstones = new TombstoneStore({ file: path.join(this.paths.log, 'tombstones.jsonl') });
    this.dlq = new DeadLetterQueue({ file: path.join(this.paths.log, 'dlq.jsonl'), clock: this.clock });

    // ---- derived read model ------------------------------------------------
    this.indexStore = new IndexStore({ root: this.paths.index });
    this.indexManager = new IndexManager({
      store: this.indexStore,
      logStore: this.logStore,
      getPolicy: () => this.policy,
      clock: this.clock,
      getTombstones: () => this.tombstones.ids(),
    });

    this.semanticStore = new SemanticStore({ root: this.paths.semantic });
    // Offline graph projection: rebuilt by maintain(), read as a slice by the API.
    this.graph = new GraphCache({ dataDir: this.dataDir, clock: this.clock });
    this.tempStore = new TempSemanticStore({
      root: this.paths.semantic,
      clock: this.clock,
      ids: null,
      semanticStore: this.semanticStore,
      getPolicy: () => this.policy,
    });
    this.context = new ContextEngine({
      clock: this.clock,
      getPolicy: () => this.policy,
      maxTokens: config.context?.maxTokens,
      threshold: config.context?.threshold,
      target: config.context?.target,
      statsFile: path.join(this.paths.state, 'context.json'),
    });
    this.deletePipeline = new DeletePipeline({
      logStore: this.logStore,
      semanticStore: this.semanticStore,
      journalDir: this.paths.journal,
      clock: this.clock,
      tombstones: this.tombstones,
      getPolicy: () => this.policy,
    });
    this.maintenance = new Maintenance({
      logStore: this.logStore,
      indexStore: this.indexStore,
      indexManager: this.indexManager,
      semanticStore: this.semanticStore,
      tempLayer: this.tempStore,
      deletePipeline: this.deletePipeline,
      clock: this.clock,
      getPolicy: () => this.policy,
      stateFile: path.join(this.paths.state, 'maintenance.json'),
    });

    this._semanticCache = null;
    this._briefing = null;
    this._boot = null;
    /** Evicted block ids already folded into a summary (per process). */
    this._foldedIds = new Set();
    this._closed = false;
    this._writeChain = Promise.resolve();
    this.maintenance.onPublished = () => {
      this._semanticCache = null;
    };
  }

  static async open(options) {
    const memory = new Memory(options);
    await memory.init();
    return memory;
  }

  async init() {
    for (const dir of Object.values(this.paths)) ensureDir(dir);
    await this.logStore.ensure();

    const snapshot = await this.logStore.snapshot();
    // Identity and tombstones are DERIVED: rebuild from the log, never trust the
    // persisted hint alone (a crash between append and persist must not matter).
    this.ledger.loadHint();
    this.ledger.rebuild(snapshot.records);
    this.ledger.persist();
    this.tombstones.load();
    this.tombstones.mergeFolded(foldRecords(snapshot.records).tombstones);
    this.dlq.load();
    await this.tempStore.init();

    this._boot = await this.maintenance.bootCheck();
    this._bootBefore = this._boot;
    if (this._boot.status !== 'ok') {
      await this.indexManager.rebuild({ reason: `boot:${this._boot.status}` });
      this._boot = { ...this._boot, status: 'ok', reason: `rebuilt (${this._boot.reason ?? this._boot.status})` };
    }
    this.refreshBriefing();
    return this;
  }

  // ---- write path --------------------------------------------------------

  /**
   * Append an episode. Returns the immutable handle the caller keeps forever.
   *
   * Idempotent by default: a replayed payload at the same event_time returns the
   * existing event id and appends nothing. Pass `dedupe:false` to record a genuine
   * second occurrence — it then gets the next occurrence_index and a distinct id.
   */
  async remember({
    content,
    eventTime,
    happenedAt,
    tags = [],
    salience = 0.5,
    meta = null,
    entity = null,
    idempotencyKey = null,
    dedupe = true,
    isTransientTrend = false,
    mediaUrl = null,
    mediaType = null,
  }) {
    this.assertOpen();
    ensureNoEmbeddedBase64(content);
    const media = validateMedia(mediaUrl, mediaType);
    const payload = {
      content,
      tags,
      salience,
      meta,
      entity,
      event_time: eventTime ?? happenedAt,
      ...(media ? { media } : {}),
    };
    const plan = ingestEpisode({
      payload,
      clock: this.clock,
      policy: this.policy,
      ledger: this.ledger,
      dlq: this.dlq,
      dedupe,
      clientKey: idempotencyKey,
    });

    if (plan.status === 'duplicate') {
      return {
        status: 'duplicate',
        duplicate: true,
        eventId: plan.eventId,
        contentHash: plan.contentHash,
        eventTime: plan.eventTime,
        dedupeKey: plan.dedupeKey,
        note: 'payload already stored for this event_time; nothing was written',
      };
    }

    if (plan.status === 'dead-letter') {
      this.ledger.persist();
      return {
        status: 'dead-letter',
        deadLetter: true,
        dlqId: plan.dlqId,
        contentHash: plan.contentHash,
        eventTime: plan.eventTime,
        occurrenceIndex: plan.occurrenceIndex ?? 0,
        reason: plan.reason,
        note: 'invalid payload routed to the DLQ; it never overwrites a stored event',
      };
    }

    const record = plan.record;
    await this.logStore.append([record]);
    this.ledger.persist();
    await this.indexManager.applyRecords([record]);

    let trend = null;
    if (isTransientTrend) {
      trend = await this.tempStore.observe({
        content: record.content,
        sourceEvents: [record.event_id],
        tags: record.tags.map((tag) => tag.tag),
        occurredAt: record.event_time,
      });
    }
    this.refreshBriefing();
    return {
      status: 'appended',
      eventId: record.event_id,
      entityId: record.entity_id,
      contentHash: record.content_hash,
      occurrenceIndex: record.occurrence_index,
      eventTime: record.event_time,
      timeSource: record.time_source,
      timeUncertain: record.time_uncertain === true,
      logTime: record.log_time,
      salience: record.salience,
      tags: record.tags.map((tag) => tag.tag),
      day: dayKey(record.time_source === 'content' ? record.log_time : record.event_time),
      indexGeneration: this.indexManager.generation,
      indexed: true,
      trend: trend ? { tempId: trend.tempId, action: trend.action, hitCount: trend.entry?.hitCount ?? 0 } : null,
    };
  }

  /**
   * One active heavy task (checkpoint). Exactly one is active at a time: writing
   * a new one demotes the previous, and `maintain()` demotes one that has not
   * been refreshed for ACTIVE_TASK_TTL_MS. The snapshot itself is a normal event
   * tagged `active_task`, so it is durable; the pointer in state/ only says which
   * one is current.
   */
  async checkpoint({ taskId, progress, updatedAt } = {}) {
    this.assertOpen();
    if (typeof taskId !== 'string' || !taskId.trim()) {
      throw invalidInput('checkpoint.task_id must be a non-empty string');
    }
    const now = this.clock.now();
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
      throw invalidInput('checkpoint.progress must be a number between 0 and 100', { got: progress });
    }
    const at = updatedAt === undefined || updatedAt === null ? now : Number(updatedAt);
    if (!Number.isFinite(at) || at > now + 60_000) {
      throw invalidInput('checkpoint.updated_at must be a valid past timestamp');
    }

    const previous = this.activeTask();
    const content = JSON.stringify({ task_id: taskId.trim(), progress, updated_at: at });
    const result = await this.remember({
      content,
      tags: ['active_task', `task:${taskId.trim()}`],
      salience: 1,
      eventTime: at,
      dedupe: true,
    });

    const pointer = {
      schema: ACTIVE_TASK_SCHEMA,
      active: true,
      eventId: result.eventId,
      taskId: taskId.trim(),
      progress,
      updatedAt: at,
      createdAt: previous.status === 'active' ? previous.createdAt ?? at : at,
      demotedEventId: previous.status === 'active' ? previous.eventId : null,
    };
    ensureDir(this.paths.state);
    writeJsonAtomic(this.activeTaskPath(), pointer);
    this.refreshBriefing();
    return {
      status: 'active',
      taskId: pointer.taskId,
      progress,
      updatedAt: at,
      eventId: pointer.eventId,
      demotedEventId: pointer.demotedEventId,
      duplicate: result.status === 'duplicate',
    };
  }

  activeTaskPath() {
    return path.join(this.paths.state, 'active-task.json');
  }

  /**
   * Read the active task. Reads the pointer, then looks the event up in the raw
   * index (`snapshot().events`), which is NOT filtered by the active set or its
   * 200-tag cap — a checkpoint must stay findable under heavy load.
   */
  activeTask() {
    const pointer = readJson(this.activeTaskPath(), null);
    if (!pointer || pointer.active !== true) return { status: 'none' };
    const events = this.indexManager.snapshot()?.events ?? [];
    const event = events.find((candidate) => candidate.eventId === pointer.eventId);
    if (!event) {
      return { status: 'missing', taskId: pointer.taskId, eventId: pointer.eventId, updatedAt: pointer.updatedAt };
    }
    const stale = this.clock.now() - pointer.updatedAt > ACTIVE_TASK_TTL_MS;
    return {
      status: stale ? 'stale' : 'active',
      taskId: pointer.taskId,
      eventId: pointer.eventId,
      progress: pointer.progress,
      updatedAt: pointer.updatedAt,
      createdAt: pointer.createdAt ?? pointer.updatedAt,
      ageMs: this.clock.now() - pointer.updatedAt,
      stale,
      content: event.content,
      tags: (event.tags ?? []).map((tag) => tag.tag ?? tag),
    };
  }

  /** Engine fallback: demote a checkpoint nobody refreshed for ACTIVE_TASK_TTL_MS. */
  demoteStaleTask() {
    const pointer = readJson(this.activeTaskPath(), null);
    if (!pointer || pointer.active !== true) return { demoted: false };
    const now = this.clock.now();
    const record = this.activeTask();
    const reason = record.status === 'missing' ? 'missing-event' : now - pointer.updatedAt > ACTIVE_TASK_TTL_MS ? 'stale' : null;
    if (!reason) return { demoted: false };
    writeJsonAtomic(this.activeTaskPath(), {
      schema: ACTIVE_TASK_SCHEMA,
      active: false,
      demotedEventId: pointer.eventId,
      demotedAt: now,
      reason,
      taskId: pointer.taskId,
      progress: pointer.progress,
      updatedAt: pointer.updatedAt,
    });
    return { demoted: true, reason, eventId: pointer.eventId, taskId: pointer.taskId };
  }

  /**
   * Build a deterministic control record. Control ids derive from the log position,
   * so replaying the same prefix reproduces the same ids.
   */
  async _controlRecord(kind, { target, eventTime, weight, mode, reason }) {
    const snapshot = await this.logStore.snapshot();
    const eventId = controlIdFor({
      type: kind,
      contentHash: sha256(`${kind}|${target}|${mode ?? ''}|${reason ?? ''}|${weight ?? ''}`),
      eventTime: eventTime ?? this.clock.now(),
      occurrenceIndex: snapshot.records.length,
    });
    const logTime = Math.trunc(this.clock.now());
    if (kind === 'reinforce') {
      return makeReinforce({ eventId, target, weight, eventTime, logTime });
    }
    if (kind === 'forget') {
      return makeForget({ eventId, target, mode, reason, logTime });
    }
    return makeRestore({ eventId, target, reason, logTime });
  }

  /** Reinforce existing episodes. The reinforcement log IS the anchor (no field). */
  async reinforce({ eventIds, weight = 1, eventTime }) {
    this.assertOpen();
    const ids = this.normaliseIds(eventIds);
    const snapshot = await this.logStore.snapshot();
    const known = new Set(
      snapshot.records.filter((record) => record.type === 'episode').map((record) => record.event_id),
    );
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new MemoryError(ErrorCodes.NOT_FOUND, 'cannot reinforce unknown event ids', { missing });
    }
    const records = [];
    for (const target of ids) {
      records.push(await this._controlRecord('reinforce', { target, eventTime, weight }));
    }
    await this.logStore.append(records);
    await this.indexManager.applyRecords(records);
    this.refreshBriefing();
    return {
      reinforced: ids,
      reinforcementEventIds: records.map((record) => record.event_id),
      anchor: records.reduce((max, record) => Math.max(max, record.log_time), 0),
    };
  }

  /** Delete: phase 1-4 pipeline, then a rebuild so the published index agrees. */
  async forget({ eventIds, mode = 'purge', reason = 'unspecified' }) {
    this.assertOpen();
    const ids = this.normaliseIds(eventIds);
    const job = await this.deletePipeline.request({ eventIds: ids, mode, reason });
    const maintenance = await this.maintenance.run({ reason: `forget:${job.id}` });
    return { job: this.publicJob(job), maintenance: this.publicMaintenance(maintenance) };
  }

  /** Undo a tombstone while the bytes still exist (archive mode or pre-purge). */
  async restore({ eventIds, reason = 'rollback' }) {
    this.assertOpen();
    const ids = this.normaliseIds(eventIds);
    const snapshot = await this.logStore.snapshot();
    const present = new Set(
      snapshot.records.filter((record) => record.type === 'episode').map((record) => record.event_id),
    );
    const purged = ids.filter((id) => !present.has(id));
    if (purged.length > 0) {
      throw new MemoryError(ErrorCodes.ALREADY_PURGED, 'event bytes are gone; restore the semantic summary instead', {
        purged,
      });
    }
    const records = [];
    for (const target of ids) records.push(await this._controlRecord('restore', { target, reason }));
    await this.logStore.append(records);
    for (const target of ids) this.tombstones.unmark({ eventId: target, at: this.clock.now(), reason });
    await this.maintenance.run({ reason: 'restore' });
    return { restored: ids, restoreEventIds: records.map((record) => record.event_id) };
  }

  // ---- read path ---------------------------------------------------------

  /**
   * Retrieve. Pure read: no adjudication, no writes, no log scan.
   * `indexManager.snapshot()` is a pointer read — a maintenance rebuild in flight
   * cannot block or tear this query.
   */
  async recall({ text = '', tags = [], topK } = {}) {
    this.assertOpen();
    const now = this.clock.now();
    const view = this.indexManager.snapshot();
    if (!view) {
      return {
        query: { text, tags, topK: topK ?? this.policy.candidates.topK },
        mode: 'degraded',
        degradedReason: 'no-index-yet',
        generation: null,
        hits: [],
        semantic: [],
        tempSemantic: this.tempStore.list({ status: 'temp', now }),
        scanned: { blocks: 0, candidates: 0, scored: 0, tagHits: 0 },
        candidateTags: [],
        activeTags: 0,
        notes: ['no index generation yet; run memory_admin action=maintain'],
      };
    }
    const semantic = this.semanticSummaries();
    const tempSemantic = this.tempStore.list({ status: 'temp', now });
    const associations = this.graphAssociations({ tags, text });
    const result = runRecall({
      index: view,
      query: { text, tags, topK },
      policy: this.policy,
      now,
      semantic,
      tempSemantic,
      associations,
    });
    return {
      ...result,
      stale: this._boot ? this._boot.status !== 'ok' : false,
      associations,
      // A count, not the resident list: the online queue may read the active set
      // but never enumerate it into the response (that is offline adjudication's job).
      activeTagCount: view.activeSet?.entries?.length ?? 0,
      notes: [
        ...(result.notes ?? []),
        ...(associations.length > 0 ? [`graph-associations:${associations.length}`] : []),
        ...(this._boot && this._boot.status !== 'ok' ? [`boot-check:${this._boot.status}`] : []),
      ],
    };
  }

  /**
   * Online association wake-up: for every tag the query already touches, read the
   * cached graph and take its three strongest neighbours. The neighbours enter the
   * candidate pool with a 0.5 penalty (retrieval applies it), so an associative
   * hit can never outrank a direct one.
   */
  graphAssociations({ tags = [], text = '' } = {}, { limit = GRAPH_ASSOCIATIONS } = {}) {
    const graph = this.graph.read();
    if (!graph || !Array.isArray(graph.edges) || graph.edges.length === 0) return [];
    const seeds = new Set([...tags, ...tokenize(text)]);
    if (seeds.size === 0) return [];
    const byNode = new Map();
    for (const edge of graph.edges) {
      for (const [self, other] of [
        [edge.source, edge.target],
        [edge.target, edge.source],
      ]) {
        if (!seeds.has(self)) continue;
        if (!byNode.has(self)) byNode.set(self, []);
        byNode.get(self).push({ tag: other, weight: edge.weight ?? 0 });
      }
    }
    const picked = [];
    for (const [seed, neighbours] of byNode) {
      neighbours.sort((a, b) => b.weight - a.weight || a.tag.localeCompare(b.tag));
      for (const neighbour of neighbours.slice(0, limit)) {
        picked.push({ tag: neighbour.tag, via: seed, weight: neighbour.weight, penalty: ASSOCIATION_PENALTY });
      }
    }
    return picked;
  }

  async maintain({ reason = 'manual' } = {}) {
    this.assertOpen();
    const report = await this.maintenance.run({ reason });
    this._boot = { status: 'ok', logGen: report.logGen, indexGen: report.indexGen };
    // Monthly memos are part of maintenance: a completed natural month becomes
    // one durable memo before the graph is rebuilt from the same index.
    try {
      report.monthly = await this.generateMonthlyMemos();
    } catch (error) {
      report.monthlyError = error instanceof Error ? error.message : String(error);
    }
    // The graph is part of maintenance, never of the read path: the index is
    // already "log minus tombstones", so this is a projection of a projection.
    try {
      const view = this.indexManager.snapshot();
      this.graph.rebuild(view?.events ?? [], {
        indexGeneration: report.indexGen ?? view?.generation ?? null,
        maxEdges: GRAPH_HARD_CAP,
        topNeighbors: GRAPH_TOP_NEIGHBORS,
      });
      report.graph = this.graph.status({ limit: this.config?.graphMaxEdges ?? null, indexGeneration: report.indexGen ?? null });
    } catch (error) {
      // A graph failure must not fail maintenance (and must never block recall).
      report.graphError = error instanceof Error ? error.message : String(error);
    }
    // Engine fallback for checkpoints: the model forgetting to demote is not a
    // failure mode we rely on — seven days without refresh demotes here.
    try {
      report.activeTask = this.demoteStaleTask();
    } catch (error) {
      report.activeTaskError = error instanceof Error ? error.message : String(error);
    }
    this.refreshBriefing();
    return report;
  }

  /** Panel summary of the cached graph (no nodes, no edges). */
  graphStatus() {
    this.assertOpen();
    return this.graph.status({
      limit: this.config?.graphMaxEdges ?? null,
      indexGeneration: this.indexManager.generation,
    });
  }

  /** Route payload: cached edges sliced to the configured ceiling, nothing else. */
  graphView(limit) {
    this.assertOpen();
    return this.graph.view({ limit: limit ?? this.config?.graphMaxEdges ?? 500 });
  }

  // ---- L2.5 trend quarantine ---------------------------------------------

  /**
   * Folding ("推币机"): blocks evicted from the context window are not thrown
   * away. A light rule folds the most recent batch into ONE `folded_summary`
   * episode and writes it back to L1, tagged `status:folded`, so the transition
   * from context to long-term memory is smooth and observable.
   */
  async foldEvicted(records = []) {
    this.assertOpen();
    const fresh = (records ?? []).filter((record) => record?.text && !this._foldedIds.has(record.id));
    if (fresh.length === 0) return null;
    const batch = fresh.slice(-FOLD_BATCH);
    for (const record of batch) this._foldedIds.add(record.id);
    const now = this.clock.now();
    const joined = batch.map((record) => record.text).join('\n');
    const names = extractNames(joined);
    const tasks = extractTasks(joined);
    const points = batch
      .map((record) => firstSentence(record.text))
      .filter(Boolean)
      .slice(-3);
    const content = [
      `折叠摘要（${new Date(now).toISOString().slice(0, 10)}，${batch.length} 块）`,
      points.length ? `要点：${points.join('；')}` : '要点：无',
      names.length ? `人名：${names.join('、')}` : null,
      tasks.length ? `任务：${tasks.join('、')}` : null,
    ]
      .filter(Boolean)
      .join('；');
    try {
      const result = await this.remember({
        content,
        tags: [FOLDED_TAG, 'folded_summary'],
        salience: 0.65,
        eventTime: now,
        idempotencyKey: `fold:${batch.map((record) => record.id).join(',')}`.slice(0, 200),
      });
      return { folded: batch.length, eventId: result.eventId, status: result.status, names, tasks };
    } catch (error) {
      return { folded: 0, error: error?.code ?? String(error) };
    }
  }

  monthlyStatePath() {
    return path.join(this.paths.state, 'months.json');
  }

  /**
   * Multi-level time aggregation: once a natural month is over, its diaries are
   * condensed into one monthly memo (tag `status:monthly`). Memos are written as
   * ordinary episodes, so they are durable; retrieval gives them no decay and a
   * boost when the query is about a fuzzy historical period.
   */
  async generateMonthlyMemos({ now = this.clock.now() } = {}) {
    const view = this.indexManager.snapshot();
    const events = view?.events ?? [];
    const byMonth = new Map();
    for (const event of events) {
      if (!event.day) continue;
      if ((event.tags ?? []).some((tag) => (tag.tag ?? tag) === MONTHLY_TAG)) continue;
      const month = String(event.day).slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(event);
    }
    const state = readJson(this.monthlyStatePath(), null);
    const done = new Set(Array.isArray(state?.months) ? state.months : []);
    const generated = [];
    for (const [month, list] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
      if (done.has(month)) continue;
      const [year, monthIndex] = month.split('-').map(Number);
      const nextMonth = Date.UTC(year, monthIndex, 1);
      if (now < nextMonth) continue; // the month is still running
      const tagCounts = new Map();
      for (const event of list) for (const tag of event.tags ?? []) tagCounts.set(tag.tag ?? tag, (tagCounts.get(tag.tag ?? tag) ?? 0) + 1);
      const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([tag]) => tag);
      const highlights = list
        .slice()
        .sort((a, b) => b.salience - a.salience || a.eventId.localeCompare(b.eventId))
        .slice(0, 3)
        .map((event) => snippet(event.content, 60));
      const days = new Set(list.map((event) => event.day)).size;
      const content = `月度记忆 ${month}：${list.length} 条事件 / ${days} 天；主要标签：${topTags.join('、') || '无'}；要点：${highlights.join('；') || '无'}`;
      const result = await this.remember({
        content,
        tags: [MONTHLY_TAG, `month:${month}`],
        salience: 0.95,
        eventTime: nextMonth - 1,
        entity: `month:${month}`,
      });
      done.add(month);
      generated.push({ month, eventId: result.eventId, status: result.status, events: list.length });
    }
    if (generated.length > 0) {
      ensureDir(this.paths.state);
      writeJsonAtomic(this.monthlyStatePath(), { schema: 1, months: [...done].sort(), updatedAt: now });
    }
    return { generated: generated.length, months: generated.map((entry) => entry.month), entries: generated };
  }

  async extractTrend({ content, sourceEvents = [], tags = [], occurredAt, ttlDays } = {}) {
    this.assertOpen();
    const result = await this.tempStore.observe({
      content,
      sourceEvents,
      tags,
      occurredAt: occurredAt ?? this.clock.now(),
      ttlDays,
    });
    this.refreshBriefing();
    return result;
  }

  trends({ status } = {}) {
    this.assertOpen();
    return this.tempStore.list({ status, now: this.clock.now() });
  }

  async status() {
    this.assertOpen();
    const now = this.clock.now();
    const log = await this.logStore.status();
    const index = this.indexManager.status();
    const semantic = this.semanticStore.status();
    const temp = this.tempStore.status({ now });
    const context = this.context.snapshot({ now });
    const jobs = this.deletePipeline.jobs();
    const report = this.maintenance.lastReport();
    const generation = {
      logGen: log.gen ?? null,
      indexGen: index.generation ?? null,
      logGeneration: log.gen ? genNumber(log.gen) : 0,
      indexGeneration: index.generation ? genNumber(index.generation) : 0,
    };
    return {
      dataDir: this.dataDir,
      policyHash: this.policyHash,
      log: { ...log, path: this.paths.log },
      index,
      identity: {
        ...this.ledger.status(),
        tombstones: this.tombstones.size(),
        deadLetters: this.dlq.size(),
      },
      semantic: { ...semantic, path: this.paths.semantic },
      temp,
      context,
      deletes: {
        total: jobs.length,
        pendingConsolidation: jobs.filter((job) => job.status === 'pending-consolidation').length,
        archived: jobs.filter((job) => job.status === 'archived').length,
        queued: jobs.filter((job) => job.status === 'running' || job.status === 'pending-consolidation').length,
      },
      boot: this._boot,
      budget: {
        activeSetCap: this.policy.activeSet.cap,
        activeTags: index.stats?.activeTags ?? 0,
        topKDefault: this.policy.candidates.topK,
        topKMax: this.policy.candidates.maxTopK,
        candidateBudget: (index.stats?.activeTags ?? 0) * this.policy.activeSet.tagBudget,
      },
      maintenance: { ...(report ?? {}), lastSuccessAt: report?.finishedAt ?? null },
      // ---- panel: the UI contract. Field names are part of the API. ----------
      panel: {
        generatedAt: now,
        global: {
          events: log.recordCount ?? 0,
          activeTags: index.stats?.activeTags ?? 0,
          semanticSummaries: semantic.summaries ?? 0,
          tempQuarantined: temp.temp ?? 0,
        },
        tokens: {
          contextTokens: context.tokens ?? 0,
          contextMaxTokens: context.maxTokens ?? 0,
          evictedBlocks: context.evictedBlocks ?? 0,
          // Exact definition: sum of tokens of blocks evicted by the context engine,
          // accumulated at eviction time and persisted in state/context.json.
          cumulativeSavedTokens: context.savedTokens ?? 0,
        },
        storage: {
          dataDir: this.dataDir,
          diskBytes: diskUsage(this.dataDir),
        },
        maintenance: {
          lastSuccessAt: report?.finishedAt ?? null,
          nextRunAt: this._nextRunAt(now),
          maintenanceCron: this.config?.maintenanceCron ?? null,
          running: this._scheduler?.running ?? false,
          queuedDeletes: jobs.filter((job) => job.status === 'running' || job.status === 'pending-consolidation').length,
        },
        generations: generation,
        // Cached graph summary: counts only, so the panel stays cheap.
        graph: this.graph.status({ limit: this.config?.graphMaxEdges ?? null, indexGeneration: index.generation ?? null }),
      },
    };
  }

  /** Scheduler handle for the panel (`running` is a live fact, not a stored one). */
  attachScheduler(scheduler) {
    this._scheduler = scheduler ?? null;
    return this;
  }

  _nextRunAt(now) {
    if (!this.config?.maintenanceCron) return null;
    try {
      return nextRun(parseCron(this.config.maintenanceCron), now);
    } catch {
      return null;
    }
  }

  /**
   * Boot-check evidence. `before` is what the store looked like on open (stale or
   * missing it was rebuilt, and `after` says so); never re-derives anything.
   */
  bootReport() {
    return { before: this._bootBefore ?? null, after: this._boot ?? null };
  }

  /**
   * Compact, model-facing state line used by the prompt context section.
   * Synchronous and IO-free on purpose: prompt assembly must never await disk.
   */
  briefing() {
    if (!this._briefing) this.refreshBriefing();
    return this._briefing.text;
  }

  refreshBriefing() {
    const index = this.indexManager.snapshot();
    const entries = index?.activeSet?.entries ?? [];
    const stats = index?.stats ?? {};
    const jobs = this.deletePipeline.jobs();
    const pendingDeletes = jobs.filter((job) => job.status !== 'done' && job.status !== 'archived').length;
    const top = entries
      .slice()
      .sort((a, b) => b.priority - a.priority || a.tag.localeCompare(b.tag))
      .slice(0, 8)
      .map((entry) => entry.tag);
    const parts = [
      `gen=${index?.generation ?? 'none'}`,
      `events=${stats.events ?? 0}`,
      `activeTags=${entries.length}/${this.policy.activeSet.cap}`,
      `semantic=${this.semanticStore.status().summaries}`,
      `temp=${this.tempStore.countTemp()}`,
    ];
    if (pendingDeletes > 0) parts.push(`pendingDeletes=${pendingDeletes}`);
    if (this.tombstones.size() > 0) parts.push(`tombstones=${this.tombstones.size()}`);
    const text = `Memory ${parts.join(' ')}${top.length ? ` | top: ${top.join(', ')}` : ''}`;
    this._briefing = { text, topTags: top, activeTags: entries.length, generation: index?.generation ?? null };
    return this._briefing;
  }

  semanticSummaries() {
    if (this._semanticCache) return this._semanticCache;
    this._semanticCache = this.semanticStore.list();
    return this._semanticCache;
  }

  // ---- policy & lifecycle ------------------------------------------------

  setPolicy(overrides) {
    this.policy = resolvePolicy(overrides);
    this.policyHash = hashPolicy(this.policy);
    return this.policyHash;
  }

  aliases() {
    return buildAliasMap(this.policy);
  }

  assertOpen() {
    if (this._closed) throw new MemoryError(ErrorCodes.IO, 'memory is closed');
  }

  normaliseIds(eventIds) {
    const list = Array.isArray(eventIds) ? eventIds : [eventIds];
    const ids = [...new Set(list.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))];
    if (ids.length === 0) throw new MemoryError(ErrorCodes.INVALID_INPUT, 'eventIds must be a non-empty array');
    return ids;
  }

  publicJob(job) {
    return {
      id: job.id,
      mode: job.mode,
      status: job.status,
      phase: job.phase,
      eventIds: job.eventIds,
      summaryIds: job.summaryIds,
      steps: job.steps,
    };
  }

  publicMaintenance(report) {
    return {
      indexGen: report.indexGen,
      logGen: report.logGen,
      stats: report.stats,
      activeSet: report.activeSet,
      temp: report.temp,
      notes: report.notes,
    };
  }

  close() {
    this._closed = true;
  }
}
