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
import { buildAliasMap, hashPolicy, normaliseTagToken, resolvePolicy } from './policy.js';
import { controlIdFor } from './identity.js';
import { makeForget, makeReinforce, makeRestore } from './log/records.js';
import { ingestEpisode } from './log/ingest.js';
import { LogStore } from './log/logStore.js';
import { DeadLetterQueue, IdentityLedger, TombstoneStore } from './log/identityLedger.js';
import { IndexStore } from './index/indexStore.js';
import { IndexManager } from './index/indexManager.js';
import { GraphCache, GRAPH_HARD_CAP, GRAPH_TOP_NEIGHBORS } from './graph.js';
import { RawStore } from './rawStore.js';
import { ReviewSchedule } from './schedule.js';
import { PendingDeletes } from './pendingDelete.js';
import { foldRecords } from './index/buildIndex.js';
import { Maintenance } from './maintenance.js';
import { TagTreeCache, eventsFromIndex } from './tagTreeCache.js';
import {
  SUPER_TAG_THRESHOLD,
  degradeGhostHits,
  recall as runRecall,
  superTagAssociations,
  tokenize,
} from './retrieval.js';
import { SemanticStore } from './semantic/semanticStore.js';
import { TempSemanticStore } from './semantic/tempSemantic.js';
import { ContextEngine } from './context/contextEngine.js';
import { DEFAULT_SPACE_ID, SpaceRouter, normaliseSpaceId, validateNewSpaceId } from './spaces/spaceRouter.js';
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
/** Snapshot shape for state/handoff.json (v1.5.0 session rollover). */
export const HANDOFF_SCHEMA = 1;
/** Tag written on the L1.5 tail summary produced by an automatic handoff. */
export const HANDOFF_TAG = 'status:handoff';
/** Session-key used when the host does not publish a session id. */
export const DEFAULT_SESSION_KEY = 'default-session';
/** Bounded session map: old session ids are forgotten, never persisted. */
export const SESSION_TRACK_LIMIT = 16;
/**
 * Handoff watchdog (v1.5.4). A distillation that hangs (lock, IO, pathological
 * payload) must NOT keep the state machine in `_handoffInFlight` forever: after
 * this budget the engine degrades to a `failed` marker and lets the next session
 * proceed. Configurable per call for tests.
 */
export const HANDOFF_TIMEOUT_MS = 5000;
export const HANDOFF_STATES = Object.freeze({ ACTIVE: 'active', FAILED: 'failed', CONSUMED: 'consumed' });
/** Any summary whose text starts with this is a handoff summary, never evidence. */
export const HANDOFF_TEXT_PREFIX = '交接摘要';
const HANDOFF_TEXT_RE = /^\s*交接摘要/;

/**
 * Bound an async handoff step. The timer is cleared in `finally` so a resolved
 * distillation cannot keep the process alive; on expiry it rejects with
 * MEM_E_HANDOFF_FAILED, which checkHandoff converts into a degraded marker.
 */
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new MemoryError(ErrorCodes.HANDOFF_FAILED, `handoff distillation exceeded ${ms}ms`, { timeoutMs: ms, reason: 'timeout' })),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

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
/**
 * Project one `session/event` payload onto a raw turn. Only the three surface
 * message types carry user/assistant/tool text; everything else is ignored.
 *
 * The Host injects a `Current runtime context.` block into user messages (cwd,
 * policy, model, …). Those parts are REPEATED every turn, so they are dropped —
 * they are neither user speech nor useful forensic content. A message that
 * carries nothing but that block yields a `contextOnly` marker and is skipped.
 */
export function turnFromSessionEvent(event) {
  const type = event?.type;
  if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/result') return null;
  const extracted = extractEventText(event?.data ?? {});
  if (!extracted) return null;
  const text = extracted.text.trim();
  if (!text) return { role: 'user', kind: 'chat', text: '', contextOnly: extracted.context === true };
  if (type === 'user/message') return { role: 'user', kind: 'chat', text };
  if (type === 'tool/result') return { role: 'tool', kind: 'tool_output', text };
  return { role: 'assistant', kind: /```|(^|\n)\s{4}\S/.test(text) ? 'code' : 'chat', text };
}

const RUNTIME_CONTEXT_MARKER = /^Current runtime context\./i;

/** Text of a message event: provider parts, plain text, or a nested result. */
function extractEventText(data) {
  const partsOf = (parts) => {
    if (typeof parts === 'string') return [parts];
    if (!Array.isArray(parts)) return [];
    return parts
      .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text : null))
      .filter((part) => typeof part === 'string' && part.length > 0);
  };
  const candidates = [data.content, data.message?.content, data.result?.content];
  let parts = [];
  for (const candidate of candidates) {
    parts = partsOf(candidate);
    if (parts.length > 0) break;
  }
  if (parts.length === 0) {
    if (typeof data.text === 'string' && data.text.trim()) parts = [data.text];
    else return null;
  }
  const bodyParts = [];
  const contextParts = [];
  for (const part of parts) {
    if (RUNTIME_CONTEXT_MARKER.test(part.trimStart())) contextParts.push(part.trim());
    else bodyParts.push(part);
  }
  const text = bodyParts.join('\n').trim();
  return { text, context: contextParts.length > 0 };
}

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
    // Kept so child spaces can be opened with the SAME policy input (the resolved
    // policy is a projection; re-resolving the projection would silently double-apply
    // aliases/defaults).
    this._policyInput = policy;
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
      // v1.5.0 tag-explosion defence: the cap is live config, read per build so an
      // operator edit takes effect on the next maintenance/lazy fold.
      getMaxPostingsPerTag: () => this.config?.index?.maxPostingsPerTag ?? 500,
    });

    this.semanticStore = new SemanticStore({ root: this.paths.semantic });
    // Offline graph projection: rebuilt by maintain(), read as a slice by the API.
    this.graph = new GraphCache({ dataDir: this.dataDir, clock: this.clock });
    // L1.5 tag tree: hierarchy/ghost projection, also rebuilt by maintain() only.
    this.tagTree = new TagTreeCache({ dataDir: this.dataDir, clock: this.clock, getConfig: () => this.config });
    // Forensic raw turns: never indexed, never loaded at boot, only deep_raw/prune.
    this.raw = new RawStore({ dataDir: this.dataDir, clock: this.clock, getConfig: () => this.config });
    // Engine-owned review schedule and pending-delete queue.
    this.reviews = new ReviewSchedule({
      file: path.join(this.paths.state, 'reviews.json'),
      clock: this.clock,
      getPolicy: () => this.policy,
    });
    this.pendingDeletes = new PendingDeletes({
      file: path.join(this.paths.state, 'pending-deletes.json'),
      clock: this.clock,
    });
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
      // v1.5.0: pure physical-layer context accounting. `nativeTokenLimit` is the
      // model's native window (Qwen mode): below it nothing is folded; the rollover
      // threshold is measured against it, not against the memory-block budget.
      nativeTokenLimit: config.context?.nativeTokenLimit,
      autoRolloverThreshold: config.context?.autoRolloverThreshold,
      autoRolloverEnabled: config.context?.autoRolloverEnabled,
      getSessionTokens: () => this.sessionUsage().tokens,
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
    /** Prompt-state line is derived from the index: refresh lazily, not per write. */
    this._briefingDirty = true;
    this._boot = null;
    /** Evicted block ids already folded into a summary (per process). */
    this._foldedIds = new Set();
    this._closed = false;
    this._writeChain = Promise.resolve();
    /**
     * v1.5.0 physical-layer space routing. The default space IS this instance (no
     * extra store, so every existing single-space behaviour is byte-identical);
     * named spaces are child store directories under <dataDir>/spaces/<id>.
     */
    this._childMemories = new Set();
    this.spaces = new SpaceRouter({
      owner: this,
      dataDir: this.dataDir,
      openChild: async (childDir) => {
        const child = new Memory({
          dataDir: childDir,
          clock: this.clock,
          policy: this._policyInput,
          config: this.config,
        });
        await child.init();
        this._childMemories.add(child);
        return child;
      },
    });
    /**
     * Session-context accounting for the rollover/handoff decision. Keyed by session
     * id (bounded); the VALUE is the absolute estimated session size fed by the
     * host's `session/event` stream, never an accumulated delta — a replay of the
     * same turn must not inflate it.
     */
    this._sessionTokens = new Map();
    this._currentSessionId = null;
    /** Tags whose oversized hint has already been shown: the next recall is "insist". */
    this._oversizedHintTags = new Set();
    this._handoffInFlight = false;
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
  assertWriteBudget() {
    const used = diskUsage(this.dataDir);
    const budgetBytes = Math.max(1, this.config?.storageBudgetMb ?? 50) * 1024 * 1024;
    if (used > budgetBytes * 0.8) {
      throw new MemoryError(ErrorCodes.WRITE_FLOOD, 'storage budget above 80%; refusing new writes until maintenance prunes', { used, budgetBytes });
    }
  }

  /**
   * Stage ONE episode: validate it, resolve identity and build the record — but do
   * NOT write the log and do NOT touch the index. `commitMany()` performs one
   * durable append, one ledger checkpoint and one lazy index delta for the whole
   * batch. A duplicate/dead-letter plan is already final and needs no I/O.
   *
   * Staging mutates the in-memory ledger (occurrence allocation + idempotency map),
   * which is what makes batching safe: two items in the same batch can never receive
   * the same occurrence index. The ledger is a rebuildable cache, so a crash before
   * its checkpoint costs a rebuild from the log, never data.
   */
  async stage({
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
  } = {}) {
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
    // The hot path must not rewrite the whole ledger per item (O(n²) bytes); the
    // ledger's own debounce persists it shortly after, and close() forces it.
    this.ledger.schedulePersist();
    return { ...plan, isTransientTrend };
  }

  /** Public result for a staged plan — the exact shape `remember()` always returned. */
  describePlan(plan, trend = null) {
    if (!plan || plan.status === 'duplicate') {
      return {
        status: 'duplicate',
        duplicate: true,
        eventId: plan?.eventId ?? null,
        contentHash: plan?.contentHash ?? null,
        eventTime: plan?.eventTime ?? null,
        dedupeKey: plan?.dedupeKey ?? null,
        note: 'payload already stored for this event_time; nothing was written',
      };
    }
    if (plan.status === 'dead-letter') {
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
   * Commit a batch of staged plans. This is the ONLY honest batching point:
   *   - one `logStore.append(records)` (one append + one manifest flush),
   *   - one ledger checkpoint (debounced),
   *   - one `indexManager.applyRecords(records)` (lazy: folded on the next read),
   *   - one briefing invalidation.
   * Order is load-bearing: the log is appended before the index delta, and the
   * ledger is only a hint. Results preserve input order.
   */
  async commitMany(plans = []) {
    this.assertOpen();
    if (!Array.isArray(plans)) throw new MemoryError(ErrorCodes.INVALID_INPUT, 'commitMany requires an array of staged plans');
    const results = new Array(plans.length);
    const ready = [];
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index];
      if (!plan || plan.status !== 'ready') {
        results[index] = this.describePlan(plan);
        continue;
      }
      ready.push({ index, plan });
    }
    if (ready.length === 0) return results;

    const records = ready.map((entry) => entry.plan.record);
    await this.logStore.append(records);
    this.ledger.schedulePersist();
    await this.indexManager.applyRecords(records);
    this._markBriefingDirty();

    for (const { index, plan } of ready) {
      const record = plan.record;
      let trend = null;
      if (plan.isTransientTrend) {
        trend = await this.tempStore.observe({
          content: record.content,
          sourceEvents: [record.event_id],
          tags: record.tags.map((tag) => tag.tag),
          occurredAt: record.event_time,
        });
      }
      results[index] = this.describePlan(plan, trend);
    }
    return results;
  }

  /**
   * Append one episode. A thin `stage -> commitMany` composition, so the single and
   * bulk paths share the same identity, durability and index semantics.
   *
   * v1.5.0 routing: `targetSpaceId` (default/absent = this store) selects the
   * physical space. Each space owns its own FIFO lock, so two spaces never serialise
   * against each other and two operations on the same space can never interleave
   * their append/index deltas. The `targetSpaceId` key is consumed here and never
   * reaches identity: record hashes are space-local.
   */
  async remember(input = {}) {
    this.assertOpen();
    const { targetSpaceId, ...rest } = input ?? {};
    const spaceId = normaliseSpaceId(targetSpaceId);
    // Default space: this instance, already inside its own router lock -> use the
    // space-local write path. A child space owns its OWN router/lock; delegate to
    // its public remember() so a transfer writes into the same child lock as a
    // direct routed write (one lock per physical directory, no interleaving).
    return this.spaces.run(spaceId, (target) =>
      target === this ? this._rememberLocal(rest) : target.remember(rest),
    );
  }

  /** The space-local write path. Callers inside a space lock use this directly. */
  async _rememberLocal(input = {}) {
    this.assertOpen();
    const plan = await this.stage(input);
    if (plan.status !== 'ready') return this.describePlan(plan);
    const [result] = await this.commitMany([plan]);
    return result;
  }

  /**
   * One active heavy task (checkpoint). Exactly one is active at a time: writing
   * a new one demotes the previous, and `maintain()` demotes one that has not
   * been refreshed for ACTIVE_TASK_TTL_MS. The snapshot itself is a normal event
   * tagged `active_task`, so it is durable; the pointer in state/ only says which
   * one is current.
   */
  async checkpoint(options = {}) {
    return this.spaces.run(DEFAULT_SPACE_ID, () => this._checkpointLocal(options));
  }

  async _checkpointLocal({ taskId, progress, updatedAt } = {}) {
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
    const result = await this._rememberLocal({
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
    this._markBriefingDirty();
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
    this.assertWriteBudget();
    await this.logStore.append(records);
    await this.indexManager.applyRecords(records);
    // A reinforcement IS a review: advance the spaced-repetition step.
    for (const target of ids) this.reviews.advance(target, { now: this.clock.now() });
    this._markBriefingDirty();
    return {
      reinforced: ids,
      reinforcementEventIds: records.map((record) => record.event_id),
      anchor: records.reduce((max, record) => Math.max(max, record.log_time), 0),
    };
  }

  /** Delete: two-phase by default (grace countdown), then the 4-phase pipeline. */
  async forget({ eventIds, mode = 'purge', reason = 'unspecified' }) {
    this.assertOpen();
    const ids = this.normaliseIds(eventIds);
    // Validate BEFORE parking: a typo must fail now, not silently expire 24h later.
    const snapshot = await this.logStore.snapshot();
    const known = new Set(
      snapshot.records.filter((record) => record.type === 'episode').map((record) => record.event_id),
    );
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new MemoryError(ErrorCodes.NOT_FOUND, 'cannot delete unknown event ids', { missing });
    }
    // Tombstones for the raw layer are derived from the episode content BEFORE
    // the purge removes it; they are appended only once the delete commits.
    const contentHashes = ids.map((id) => sha256(snapshot.records.find((record) => record.event_id === id)?.content ?? '')).filter(Boolean);
    const graceHours = this.policy.delete?.graceHours ?? 24;
    if (graceHours > 0) {
      // Phase 0: park it. Nothing is tombstoned yet; `restore` just cancels.
      const pending = this.pendingDeletes.request({ eventIds: ids, mode, reason, graceHours });
      return {
        state: 'pending_delete',
        pending,
        dueAt: pending.dueAt,
        graceHours,
        note: 'cancel with restore before dueAt; maintenance purges after the grace period',
      };
    }
    const job = await this.deletePipeline.request({ eventIds: ids, mode, reason });
    if (mode === 'purge') await this.raw.tombstone(contentHashes, { at: this.clock.now() });
    const maintenance = await this.maintenance.run({ reason: `forget:${job.id}` });
    return { state: 'deleted', job: this.publicJob(job), maintenance: this.publicMaintenance(maintenance) };
  }

  /** Undo a tombstone, or cancel a pending delete before its deadline. */
  async restore({ eventIds, reason = 'rollback' }) {
    this.assertOpen();
    const ids = this.normaliseIds(eventIds);
    const cancelled = this.pendingDeletes.cancel(ids);
    if (cancelled.length > 0) return { restored: [], cancelled, note: 'pending delete cancelled before its deadline' };
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
   * Bulk ingest with REAL batching: each chunk is staged first (cheap, no I/O per
   * item except the DLQ), then committed with ONE durable append + ONE index delta.
   * Per-item failures stay isolated; duplicates are counted as skipped, never as
   * written.
   */
  async bulkIngest(items = [], { batchSize = 50 } = {}) {
    this.assertOpen();
    if (!Array.isArray(items)) throw new MemoryError(ErrorCodes.INVALID_INPUT, 'bulk ingest requires an array of memory items');
    const result = { batches: 0, created: 0, skipped: 0, failed: [] };
    for (let start = 0; start < items.length; start += batchSize) {
      const batch = items.slice(start, start + batchSize);
      result.batches += 1;
      const staged = [];
      for (const [offset, item] of batch.entries()) {
        try {
          staged.push({ offset, plan: await this.stage(item) });
        } catch (error) {
          result.failed.push({ index: start + offset, code: error?.code ?? 'MEM_E_UNKNOWN', message: error?.message ?? String(error) });
        }
      }
      if (staged.length === 0) continue;
      const results = await this.commitMany(staged.map((entry) => entry.plan));
      for (const saved of results) {
        if (saved && saved.status === 'appended') result.created += 1;
        else result.skipped += 1;
      }
    }
    return result;
  }

  /**
   * Retrieve. Pure read: no adjudication, no writes, no log scan. The index view is
   * resolved once per call (a lazy fold covers any awaited appends), so a
   * maintenance rebuild in flight cannot tear the result.
   *
   * `targetSpaceId` routes the read to another physical space (same isolation rules
   * as remember). On the default space the behaviour is byte-identical to v1.4.x
   * except for the oversized-tag degradation added in v1.5.0.
   */
  async recall(query = {}) {
    this.assertOpen();
    const { targetSpaceId, ...rest } = query ?? {};
    const spaceId = normaliseSpaceId(targetSpaceId);
    // Same lock discipline as remember(): a child space uses its own public read
    // path (its own lock), so routed reads and transfer-driven writes never
    // interleave on one directory.
    return this.spaces.run(spaceId, (target) => (target === this ? this._recallLocal(rest) : target.recall(rest)));
  }

  /** The space-local read path. */
  async _recallLocal({ text = '', tags = [], topK } = {}) {
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
        ghostHints: [],
        oversizedTagHints: [],
        semantic: [],
        tempSemantic: this.tempStore.list({ status: 'temp', now }),
        scanned: { blocks: 0, candidates: 0, scored: 0, tagHits: 0 },
        candidateTags: [],
        activeTags: 0,
        notes: ['no index generation yet; run memory_admin action=maintain'],
      };
    }
    // "The user insisted": an oversized tag whose hint was already returned by a
    // previous recall is answered with its 3 most recent summaries instead of the
    // oversized list. This is the only stateful part of the degradation, and it is
    // per-process (a fresh session sees the hint first again).
    const aliases = view.aliases ?? {};
    const canonicalTags = [...new Set(tags.map((tag) => normaliseTagToken(tag)).filter(Boolean))]
      .map((token) => aliases[token] ?? token);
    const insist =
      canonicalTags.length > 0 &&
      canonicalTags.every((tag) => this._oversizedHintTags.has(tag)) &&
      this._oversizedHintTags.size > 0;
    const semantic = this.semanticSummaries();
    const tempSemantic = this.tempStore.list({ status: 'temp', now });
    const associations = this.graphAssociations({ tags, text });
    const result = runRecall({
      index: view,
      query: { text, tags, topK, allowOversizedTags: insist },
      policy: this.policy,
      now,
      semantic,
      tempSemantic,
      associations,
    });
    for (const hint of result.oversizedTagHints ?? []) this._oversizedHintTags.add(hint.tag);
    // Anti-hallucination: a hit reached only through a mid inside its grace window
    // loses its body before it can reach the model; the hint points at deep_raw.
    const ghostPass = degradeGhostHits(result.hits ?? [], this.ghostHints(), {
      now,
      queryTags: result.query?.tags ?? [],
    });
    return {
      ...result,
      hits: ghostPass.hits,
      ghostHints: ghostPass.ghostHints,
      oversizedTagHints: result.oversizedTagHints ?? [],
      stale: this._boot ? this._boot.status !== 'ok' : false,
      associations,
      // A count, not the resident list: the online queue may read the active set
      // but never enumerate it into the response (that is offline adjudication's job).
      activeTagCount: view.activeSet?.entries?.length ?? 0,
      notes: [
        ...(result.notes ?? []),
        ...ghostPass.notes,
        ...(associations.length > 0 ? [`graph-associations:${associations.length}`] : []),
        ...(this._boot && this._boot.status !== 'ok' ? [`boot-check:${this._boot.status}`] : []),
      ],
    };
  }

  /**
   * Ghost mids from the cached tag tree, read-only. The cache is best-effort: a
   * missing or unreadable file means "no ghosts to protect against", never a failed
   * recall.
   */
  ghostHints() {
    try {
      const ghosts = this.tagTree.read()?.ghosts;
      return Array.isArray(ghosts) ? ghosts : [];
    } catch {
      return [];
    }
  }

  /**
   * Raw turn capture (forensic layer). Gated and capped by `raw.*` config; a
   * gated turn returns a verdict instead of throwing, an I/O failure throws.
   */
  async captureRaw(turn = {}) {
    this.assertOpen();
    return this.raw.capture(turn);
  }

  /** Bounded deep scan over raw shards; time window and token budget required. */
  async deepRaw(query = {}) {
    this.assertOpen();
    if (typeof query.hash === 'string' && query.hash.trim()) {
      return this.raw.restoreByHash(query.hash);
    }
    if ((this.config?.raw?.captureRatio ?? 1) === 0) {
      const warning = '[系统提示：黑匣子留存已关闭，无法查阅原话]';
      return { mode: 'deep_raw', hits: [], scanned: { turns: 0, bytes: 0, shards: 0, tombstonesSkipped: 0 }, truncated: false, notes: [warning], warning };
    }
    if (!Number.isFinite(query.startTime) || !Number.isFinite(query.endTime)) {
      // v1.5.0: a super tag (>500 associations) is not scannable without a time
      // window — an unbounded deep_raw over it is exactly the context/OOM flood the
      // tag-explosion defence exists to prevent. Narrow queries keep the old
      // MEM_E_INVALID_INPUT contract.
      const superTags = superTagAssociations({
        index: this.indexManager.snapshot(),
        text: query.text,
        tags: query.tags,
      });
      if (superTags.length > 0) {
        throw new MemoryError(
          ErrorCodes.TIME_RANGE_REQUIRED,
          `deep_raw on a super tag (>${SUPER_TAG_THRESHOLD} associations) requires start_time and end_time`,
          {
            startTime: query.startTime ?? null,
            endTime: query.endTime ?? null,
            tags: superTags.map((entry) => entry.tag),
            threshold: SUPER_TAG_THRESHOLD,
          },
        );
      }
      throw new MemoryError(ErrorCodes.INVALID_INPUT, 'deep_raw requires start_time and end_time (epoch ms)', {
        startTime: query.startTime ?? null,
        endTime: query.endTime ?? null,
      });
    }
    return this.raw.scan({
      text: query.text,
      startTime: query.startTime,
      endTime: query.endTime,
      limit: query.limit,
      regex: query.regex,
      maxTokens: query.maxTokens,
    });
  }

  /**
   * Automatic raw capture from the session log (`session/event`). Surface
   * messages are captured verbatim — details must survive even when the episode
   * was distilled — but only while `raw.mode != off` and `raw.autoCapture`, and
   * every write still goes through the turn/day/total budgets and dedupe.
   */
  async captureSessionEvent(session, event) {
    this.assertOpen();
    const turn = turnFromSessionEvent(event);
    if (turn && turn.contextOnly !== true) {
      // v1.5.0: session-size accounting feeds the rollover/handoff decision and is
      // deliberately INDEPENDENT of the raw-retention gates below — the handoff must
      // still work when the black box is disabled or sampled.
      this.observeSessionTurn(session?.id ?? session?.sessionId ?? null, turn.text);
      this._maybeAutoHandoff();
    }
    const raw = this.config?.raw ?? {};
    if (raw.autoCapture !== true) return { skipped: 'auto-capture-off' };
    if ((raw.mode ?? 'salience') === 'off') return { skipped: 'raw-off' };
    const ratio = raw.captureRatio ?? 1;
    if (ratio === 0) return { skipped: 'capture-ratio-0' };
    if (!turn) return { skipped: 'not-a-surface-message' };
    if (turn.contextOnly === true) return { skipped: 'runtime-context-only' };
    // Tool chatter is opt-in, but a FAILED tool call is exactly the detail worth
    // keeping: error results bypass the opt-in (budgets still apply).
    const isError = event?.data?.isError === true || event?.data?.error !== undefined || event?.data?.message?.isError === true;
    if (event?.type === 'tool/result' && raw.captureTools !== true && !isError) return { skipped: 'tool-output-off' };
    if (ratio === 0.5) {
      const turnId = 'turn_' + (event?.seq ?? 'x') + '_' + turn.role;
      const bucket = parseInt(sha256(turnId + ':' + turn.text).slice(0, 8), 16) % 2;
      if (bucket !== 0) return { skipped: 'capture-ratio-sample' };
    }
    return this.raw.capture({
      content: turn.text,
      role: turn.role,
      kind: event?.type === 'tool/result' && isError ? 'error' : turn.kind,
      sessionId: session?.id ?? session?.sessionId ?? null,
      turnId: `turn_${event?.seq ?? 'x'}_${turn.role}`,
      at: Number.isFinite(event?.time) ? event.time : undefined,
      salience: 1,
      force: true,
    });
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

  // ---- session accounting, auto-rollover and handoff (v1.5.0) --------------
  //
  // "Handoff" is the physical half of the philosophy: a session may end, the
  // persona does not. When the estimated session context reaches
  // context.autoRolloverThreshold x context.nativeTokenLimit, the tail is distilled
  // into ONE L1.5 summary, state/handoff.json is marked active and the prompt state
  // advertises the marker. A NEW session consumes the marker. If auto-rollover is
  // disabled, ContextEngine force-evicts at 95% instead (no summary promised).

  /**
   * Feed the CURRENT session size (absolute tokens, not a delta) into the rollover
   * math. Keyed by session id so two concurrent sessions cannot overwrite each
   * other's accounting; the map is bounded (oldest evicted, never persisted — this
   * is live process state, not a durable fact).
   */
  /**
   * Feed the CURRENT session size (absolute tokens, not a delta) into the rollover
   * math. Keyed by session id so two concurrent sessions cannot overwrite each
   * other's accounting; the map is bounded (oldest evicted, never persisted).
   *
   * v1.5.4 state-machine guarantees (anti-deadlock):
   *   - a NEW session id always establishes its own baseline immediately; the
   *     previous session's handoff can never own or block the next one;
   *   - a marker written for a DIFFERENT session is consumed on transition;
   *   - `_handoffInFlight` is released on every transition, so a hung distillation
   *     (timeout, IO error, pathological payload) cannot lock future sessions.
   */
  observeSessionTokens(sessionId, tokens) {
    this.assertOpen();
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw invalidInput('session tokens must be a finite non-negative number', { got: tokens });
    }
    const key = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : DEFAULT_SESSION_KEY;
    const previousSession = this._currentSessionId;
    const previousTokens = this._sessionTokens.get(key) ?? null;
    if (!this._sessionTokens.has(key) && this._sessionTokens.size >= SESSION_TRACK_LIMIT) {
      const oldest = this._sessionTokens.keys().next().value;
      this._sessionTokens.delete(oldest);
    }
    this._sessionTokens.set(key, Math.round(tokens));
    const isNewSession = previousSession === null || previousSession !== key;
    // Same-key restart: the estimate collapsed after a reset/reload. Without this
    // branch the old ratio would re-trigger a handoff immediately on the new turn.
    const isSameKeyRestart =
      previousTokens !== null && tokens < previousTokens / 2 && previousTokens > this.context.nativeTokenLimit / 2;
    this._currentSessionId = key;
    if (isNewSession || isSameKeyRestart) {
      // CORE ANTI-DEADLOCK: the in-flight guard belongs to the OLD session only.
      this._handoffInFlight = false;
      const marker = this.handoffState();
      if (marker.active && (isSameKeyRestart || marker.sessionId !== key)) {
        this.clearHandoff({ reason: isNewSession ? 'new-session' : 'session-restart', consumedBy: key });
      }
    }
    return this.sessionUsage();
  }

  /** Add ONE turn's estimated tokens to its session (surface messages only). */
  observeSessionTurn(sessionId, text) {
    this.assertOpen();
    const key = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : DEFAULT_SESSION_KEY;
    const previous = this._sessionTokens.get(key) ?? 0;
    const tokens = previous + Math.max(1, Math.ceil(String(text ?? '').length / 4));
    return this.observeSessionTokens(key, tokens);
  }

  /** Live session size used by the status bar and the rollover decision. */
  sessionUsage() {
    if (this._currentSessionId === null) return { sessionId: null, tokens: 0 };
    return {
      sessionId: this._currentSessionId,
      tokens: this._sessionTokens.get(this._currentSessionId) ?? 0,
    };
  }

  /**
   * Escape hatch (v1.5.4): force the rollover state machine back to a clean slate.
   * Clears the live session baseline, drops the in-flight guard, consumes any
   * active marker and rewrites state/handoff.json. Durable memories are untouched:
   * this only resets derived session state, so a user who is stuck can recover
   * immediately from the UI/API/admin tool.
   */
  resetSessionState({ reason = 'manual' } = {}) {
    this.assertOpen();
    const before = { sessionId: this._currentSessionId, tokens: this.sessionUsage().tokens, handoff: this.handoffState() };
    this._sessionTokens.clear();
    this._currentSessionId = null;
    this._handoffInFlight = false;
    const marker = this.clearHandoff({ reason, consumedBy: null });
    this._markBriefingDirty();
    return { reset: true, reason, before, marker };
  }

  handoffPath() {
    return path.join(this.paths.state, 'handoff.json');
  }

  /** The durable handoff marker (state/handoff.json). Missing/corrupt = inactive. */
  handoffState() {
    const marker = readJson(this.handoffPath(), null);
    if (!marker || typeof marker !== 'object') {
      return { active: false, at: null, summaryEventId: null, consumedAt: null };
    }
    // Keep provenance even after consumption (consumedBy/consumedAt are how the
    // next boot can tell "handed off" from "never handed off").
    return { ...marker, active: marker.active === true };
  }

  /** Mark a handoff consumed (new session, or an explicit clear). */
  clearHandoff({ reason = 'manual', consumedBy = null } = {}) {
    const current = readJson(this.handoffPath(), null);
    if (!current || current.active !== true) return { active: false, cleared: false };
    const next = { ...current, active: false, state: HANDOFF_STATES.CONSUMED, consumedAt: this.clock.now(), consumedBy, reason };
    ensureDir(this.paths.state);
    writeJsonAtomic(this.handoffPath(), next);
    this._markBriefingDirty();
    return { ...next, active: false, cleared: true };
  }

  /**
   * Evaluate the rollover state and, when due, perform the handoff exactly once.
   *
   * v1.5.4 anti-deadlock contract: this method NEVER rejects and NEVER leaves the
   * caller waiting beyond `timeoutMs`. A stale marker, a distillation error, a
   * timeout or even a marker-write failure degrade into a `failed`/degraded marker
   * (or a non-fatal result) so the host can always start the next session.
   *
   * @returns native state + session + marker (+ `distilled` / `failure`)
   */
  async checkHandoff({ now = this.clock.now(), distill = true, timeoutMs = HANDOFF_TIMEOUT_MS } = {}) {
    this.assertOpen();
    const usage = this.sessionUsage();
    const native = this.context.nativeState({ now, sessionTokens: usage.tokens });
    let marker = this.handoffState();
    // A marker from a PREVIOUS session must not be inherited: consume it before the
    // early returns, or a new session would advertise a handoff forever.
    if (marker.active && marker.sessionId && usage.sessionId && marker.sessionId !== usage.sessionId) {
      this.clearHandoff({ reason: 'stale-marker', consumedBy: usage.sessionId });
      marker = this.handoffState();
    }
    const base = { ...native, session: usage, handoff: marker };
    if (!native.rolloverEnabled) {
      // Rollover off: 95% is the hard ceiling and ContextEngine evicts, no summary.
      const forcedEviction = native.forceEvictionDue ? this.context.enforce({ now }) : null;
      return { ...base, handoff: this.handoffState(), forcedEviction };
    }
    if (!native.rolloverDue) return base;
    if (marker.active) return base;

    let distilled = null;
    let failure = null;
    if (distill) {
      try {
        distilled = await withTimeout(this._distillHandoffTail({ now, native, usage }), timeoutMs);
        if (!distilled || !distilled.eventId) {
          failure = {
            code: ErrorCodes.HANDOFF_FAILED,
            reason: distilled?.reason ?? distilled?.error ?? 'no-summary',
            message: 'handoff summary was not produced',
          };
        }
      } catch (error) {
        failure = {
          code: error?.code ?? ErrorCodes.HANDOFF_FAILED,
          reason: error?.details?.reason ?? error?.reason ?? 'distill-failed',
          message: error?.message ?? String(error),
        };
      }
    } else {
      failure = { code: ErrorCodes.HANDOFF_FAILED, reason: 'distill-disabled', message: 'handoff marker written without a summary' };
    }

    const next = {
      schema: HANDOFF_SCHEMA,
      active: true,
      state: failure ? HANDOFF_STATES.FAILED : HANDOFF_STATES.ACTIVE,
      degraded: Boolean(failure),
      at: now,
      // Provenance matters: a context-window fallback is not a session measurement.
      tokenSource: usage.sessionId === null ? 'context-window' : 'session',
      sessionId: usage.sessionId,
      tokens: native.tokens,
      nativeTokenLimit: native.nativeTokenLimit,
      ratio: native.ratio,
      threshold: native.rolloverThreshold,
      summaryEventId: distilled?.eventId ?? null,
      summaryStatus: distilled?.status ?? null,
      summaryError: failure,
      note: failure
        ? '交接摘要生成失败，状态机已优雅降级：新会话可立即开始（记录见 summaryError）。本插件不能保证一个会话永生不死，只能保证人格不死。'
        : '人格交接点：末尾摘要已存为 L1.5，新会话从该摘要继续。本插件不能保证一个会话永生不死，只能保证人格不死。',
    };
    try {
      ensureDir(this.paths.state);
      writeJsonAtomic(this.handoffPath(), next);
      this._markBriefingDirty();
      return { ...base, handoff: next, distilled, failure };
    } catch (error) {
      // Marker write must never reject the caller. Report a degraded result and let
      // the host proceed; the next session still resets its own baseline.
      return {
        ...base,
        handoff: {
          active: false,
          degraded: true,
          error: { code: ErrorCodes.HANDOFF_FAILED, message: `marker write failed: ${error?.message ?? error}` },
        },
        distilled,
        failure: { code: ErrorCodes.HANDOFF_FAILED, reason: 'marker-write-failed', message: String(error?.message ?? error) },
      };
    }
  }

  /**
   * Distil eligible tail content into ONE durable L1.5 summary.
   *
   * ANTI-RECURSION (v1.5.4): handoff summaries and folded summaries are filtered
   * out by TAG and by the `交接摘要` text prefix, so a summary can never contain a
   * previous summary. The output is hard-capped in length; the idempotency key
   * includes the timestamp so distinct handoff epochs never collide.
   */
  async _distillHandoffTail({ now, native, usage }) {
    const eligibleBlocks = this.context.blocks
      .slice(-FOLD_BATCH)
      .filter((block) => block.text && !HANDOFF_TEXT_RE.test(block.text));
    let sourceTexts = eligibleBlocks.map((block) => block.text);
    if (sourceTexts.length === 0) {
      // Fallback: freshest indexed events, skipping any handoff summary (dirty
      // historical data included) so recursion cannot re-enter through the index.
      const events = (this.indexManager.snapshot()?.events ?? [])
        .filter((event) => {
          const tags = (event.tags ?? []).map((tag) => tag.tag ?? tag);
          return !tags.includes(HANDOFF_TAG) && !HANDOFF_TEXT_RE.test(String(event.content ?? ''));
        })
        .slice(0, FOLD_BATCH);
      sourceTexts = events.map((event) => event.content);
    }
    if (sourceTexts.length === 0) return { folded: 0, reason: 'no-eligible-content' };

    const points = sourceTexts.map((text) => firstSentence(text)).filter(Boolean).slice(-5);
    const names = extractNames(sourceTexts.join('\n'));
    const tasks = extractTasks(sourceTexts.join('\n'));
    const tags = new Set([FOLDED_TAG, 'folded_summary', HANDOFF_TAG]);
    for (const block of eligibleBlocks) if (block.kind && block.kind !== 'recall') tags.add(`kind:${block.kind}`);
    const content = [
      `交接摘要（${new Date(now).toISOString().slice(0, 10)}，tokens≈${native.tokens}/${native.nativeTokenLimit}，ratio=${native.ratio}）`,
      points.length ? `要点：${points.join('；')}` : '要点：无',
      names.length ? `人名：${names.join('、')}` : null,
      tasks.length ? `任务：${tasks.join('、')}` : null,
      `会话：${usage.sessionId ?? '(context-window)'}`,
    ]
      .filter(Boolean)
      .join('；')
      // Hard cap: a handoff summary must stay small; recursion used to grow it.
      .slice(0, 1200);
    try {
      const result = await this._rememberLocal({
        content,
        tags: [...tags],
        salience: 0.9,
        eventTime: now,
        idempotencyKey: `handoff:${usage.sessionId ?? 'ctx'}:${native.tokens}:${now}`.slice(0, 200),
      });
      return { folded: sourceTexts.length, eventId: result.eventId, status: result.status, points };
    } catch (error) {
      return { folded: 0, error: error?.code ?? String(error), reason: 'remember-failed' };
    }
  }

  /**
   * Fire-and-forget handoff trigger used by the session/event listener and by tool
   * calls. It never throws into the host's event bus and has an OUTER watchdog as
   * well as checkHandoff's internal one: even if checkHandoff itself hangs, the
   * in-flight flag is released so the next session/turn can proceed.
   */
  _maybeAutoHandoff() {
    if (this._closed || this._handoffInFlight) return;
    const state = this.context.nativeState({ sessionTokens: this.sessionUsage().tokens });
    if (!state.rolloverDue && !state.forceEvictionDue) return;
    this._handoffInFlight = true;
    const watchdog = new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ watchdog: true, handoff: { active: true, degraded: true, state: HANDOFF_STATES.FAILED, error: { code: ErrorCodes.HANDOFF_FAILED, message: 'handoff watchdog timeout', reason: 'watchdog' } } }),
        HANDOFF_TIMEOUT_MS + 1000,
      );
      timer.unref?.();
    });
    Promise.race([this.checkHandoff(), watchdog])
      .catch(() => {
        /* the next turn retries; a failed handoff must never break session capture */
      })
      .finally(() => {
        // CORE ANTI-DEADLOCK: this flag may never outlive the attempt.
        this._handoffInFlight = false;
      });
  }

  /**
   * Maintenance repair for the recursion incident (v1.5.4): finds handoff summaries
   * that are (a) self-recursive (>=2 `交接摘要` markers) or (b) beyond the newest
   * `keep` generations, and parks them in the TWO-PHASE delete queue (never a
   * physical purge on the spot). Default is a dry run so a human can inspect first.
   */
  async repairHandoffSummaries({ dryRun = true, keep = 1 } = {}) {
    this.assertOpen();
    const events = (this.indexManager.snapshot()?.events ?? [])
      .filter((event) => (event.tags ?? []).some((tag) => (tag.tag ?? tag) === HANDOFF_TAG))
      .slice()
      .sort((a, b) => b.anchorTime - a.anchorTime || a.eventId.localeCompare(b.eventId));
    const recursive = events.filter((event) => (String(event.content ?? '').match(/交接摘要/g) ?? []).length >= 2);
    const excess = events.slice(Math.max(0, keep));
    const candidates = [...new Set([...recursive, ...excess].map((event) => event.eventId))];
    if (dryRun || candidates.length === 0) {
      return { dryRun, totalHandoff: events.length, recursive: recursive.length, candidates, forget: null };
    }
    const forget = await this.forget({ eventIds: candidates, mode: 'purge', reason: 'handoff-recursive-cleanup' });
    return { dryRun: false, totalHandoff: events.length, recursive: recursive.length, candidates, forget };
  }

  // ---- cross-space transfer (v1.5.0 / consent gate v1.5.1) ----------------

  /**
   * Atomic cross-space migration. The source space is read, the target space
   * regenerates event ids (never reuses the source identity), the payload is
   * privacy-screened and stripped of raw_turn pointers, and `move` parks the
   * source in the two-phase pending-delete queue — it never purges directly.
   *
   * SECURITY (v1.5.1): a model must never move memories on its own. When
   * `context.requireExplicitConsentForTransfer` is true (default), this method
   * refuses to run without `userApproved === true` and throws
   * MEM_E_REQUIRE_USER_CONSENT BEFORE any space is opened, any content is read and
   * any pending delete is parked. Only the chat UI's own HTTP route (the human
   * channel) marks consent itself; the agent tools pass the explicit
   * `user_approved` argument the model may only set after asking the user.
   */
  async transferEvents({ eventIds, targetSpaceId, transferMode = 'copy', sourceSpaceId, userApproved = false } = {}) {
    this.assertOpen();
    const consentRequired = this.config?.context?.requireExplicitConsentForTransfer !== false;
    if (consentRequired && userApproved !== true) {
      throw new MemoryError(
        ErrorCodes.REQUIRE_USER_CONSENT,
        '[系统拦截] 跨空间传递需要用户明确授权。请向用户确认后再试。',
        {
          requires: 'user_approved',
          configPath: 'context.requireExplicitConsentForTransfer',
          hint: '先向用户确认；用户明确同意后，带 user_approved: true 重新调用。绝不可自行授权。',
        },
      );
    }
    const sourceId = normaliseSpaceId(sourceSpaceId);
    const targetId = normaliseSpaceId(targetSpaceId);
    if (sourceId === targetId) {
      throw invalidInput('source space and target space must differ', { sourceSpaceId: sourceId, targetSpaceId: targetId });
    }
    const source = await this.spaces.memoryFor(sourceId);
    const target = await this.spaces.memoryFor(targetId);
    // Loaded lazily: the transfer engine is optional surface, so a broken/absent
    // module must not stop the whole facade from opening.
    const { transferBetweenSpaces } = await import('./spaces/transfer.js');
    const graceHours = Math.max(1, Number(this.policy?.delete?.graceHours ?? 24));
    return transferBetweenSpaces({
      source,
      target,
      eventIds,
      sourceSpaceId: sourceId,
      targetSpaceId: targetId,
      transferMode,
      clock: this.clock,
      now: this.clock.now(),
      graceHours,
    });
  }

  /**
   * Bounded recent-memory projection for the panel's per-memory detail list.
   * Read-only, newest first, snippets only — the panel needs an entry point for
   * the human-initiated "分享/转移" button, not another full-content export.
   */
  async recentMemories({ limit = 20, targetSpaceId } = {}) {
    this.assertOpen();
    const spaceId = normaliseSpaceId(targetSpaceId);
    const bounded = Math.max(1, Math.min(Math.round(Number(limit) || 20), 200));
    return this.spaces.run(spaceId, (target) => target._recentMemoriesLocal(bounded, spaceId));
  }

  _recentMemoriesLocal(limit, spaceId) {
    const view = this.indexManager.snapshot();
    const events = (view?.events ?? [])
      // v1.5.4: internal handoff summaries never appear in the normal memory list.
      .filter((event) => !(event.tags ?? []).some((tag) => (tag.tag ?? tag) === HANDOFF_TAG))
      .slice()
      .sort((a, b) => b.anchorTime - a.anchorTime || a.eventId.localeCompare(b.eventId))
      .slice(0, limit)
      .map((event) => ({
        eventId: event.eventId,
        day: event.day ?? null,
        eventTime: event.eventTime,
        salience: event.salience,
        tags: (event.tags ?? []).map((tag) => tag.tag ?? tag),
        snippet: snippet(event.content, 240),
      }));
    return { spaceId, count: events.length, events };
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
    // v1.4.0 offline jobs: raw retention, spaced-repetition due list, and the
    // promotion of expired pending deletes into the 4-phase pipeline.
    try {
      report.rawPrune = await this.raw.prune({ now: this.clock.now() });
    } catch (error) {
      report.rawPruneError = error instanceof Error ? error.message : String(error);
    }
    try {
      const due = this.pendingDeletes.due(this.clock.now());
      const promoted = [];
      for (const item of due) {
        const snapshot = await this.logStore.snapshot();
        const hashes = item.eventIds
          .map((id) => sha256(snapshot.records.find((record) => record.event_id === id)?.content ?? ''))
          .filter(Boolean);
        await this.deletePipeline.request({ eventIds: item.eventIds, mode: item.mode, reason: item.reason });
        if (item.mode === 'purge') await this.raw.tombstone(hashes, { at: this.clock.now() });
        this.pendingDeletes.remove(item.id);
        promoted.push({ id: item.id, events: item.eventIds.length });
      }
      report.pendingDeletes = { promoted };
      if (promoted.length > 0) {
        // Purge rewrites the log, so the index must be rebuilt before anything
        // else in this maintenance pass reads it.
        report.pendingDeletes.maintenance = this.publicMaintenance(await this.maintenance.run({ reason: 'pending-delete' }));
      }
    } catch (error) {
      report.pendingDeletesError = error instanceof Error ? error.message : String(error);
    }
    try {
      report.reviews = this.reviews.tick({ events: this.indexManager.snapshot()?.events ?? [], now: this.clock.now() });
    } catch (error) {
      report.reviewsError = error instanceof Error ? error.message : String(error);
    }
    // L1.5 tag tree: a projection of the NOW-converged index (pending deletes may
    // have forced a nested rebuild above). Published to state/tag-tree.json with the
    // ghost metadata and the persisted prune queue, so a failure here is a side
    // effect — it must never fail the maintenance pass or block recall.
    try {
      const view = this.indexManager.snapshot();
      const record = this.tagTree.rebuild({
        events: eventsFromIndex(view?.events ?? []),
        indexGeneration: this.indexManager.generation,
        now: this.clock.now(),
      });
      report.tagTree = {
        ...this.tagTree.status({ indexGeneration: this.indexManager.generation }),
        prune: record.prune,
      };
    } catch (error) {
      report.tagTreeError = error instanceof Error ? error.message : String(error);
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

  /**
   * Route payload for the graph's history view: the cached ghost metadata only.
   * The full tag hierarchy stays in `state/tag-tree.json`; shipping it per request
   * would put a derived cache on the request path for no benefit.
   */
  tagTreeView(options = {}) {
    this.assertOpen();
    return this.tagTree.view(options);
  }

  /**
   * Multi-space route payloads (UI space selector): the graph/tag-tree of the
   * SELECTED space, never a mix. `default` reads this instance; a named space reads
   * its own child store through the per-space lock, so switching the selector can
   * never leak one space's projection into another's view.
   */
  async graphForSpace({ targetSpaceId, limit } = {}) {
    this.assertOpen();
    const spaceId = normaliseSpaceId(targetSpaceId);
    if (spaceId === DEFAULT_SPACE_ID) {
      return { spaceId, graph: this.graphView(limit), tagTree: this.tagTreeView() };
    }
    return this.spaces.run(spaceId, (target) => ({
      spaceId,
      graph: target.graphView(limit),
      tagTree: target.tagTreeView(),
    }));
  }

  /** Ensure a named space exists (creates its store lazily) and list all spaces. */
  async ensureSpace(spaceId) {
    this.assertOpen();
    const id = normaliseSpaceId(spaceId);
    await this.spaces.memoryFor(id);
    return { spaceId: id, spaces: this.spaces.status() };
  }

  /**
   * CREATE a named space (the UI's ＋ 新建空间). Unlike `ensureSpace` this is NOT
   * idempotent: an existing space is a conflict. Fail-Fast happens BEFORE any
   * write:
   *   - malformed/reserved id           -> MEM_E_SPACE_INVALID
   *   - `default`                       -> MEM_E_SPACE_INVALID (always exists)
   *   - spaces/<id> already exists      -> MEM_E_SPACE_INVALID (conflict)
   *   - spaces/<id> exists as a FILE    -> MEM_E_SPACE_INVALID (path conflict)
   * so a typo can never create a directory, and dirty data never reaches JSONL.
   */
  async createSpace(spaceId) {
    this.assertOpen();
    const id = validateNewSpaceId(spaceId);
    const dir = this.spaces.spaceDir(id);
    let existing = null;
    try {
      existing = fs.statSync(dir);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new MemoryError(ErrorCodes.SPACE_INVALID, `space path cannot be inspected: ${error.code}`, { spaceId: id });
      }
    }
    if (existing) {
      throw new MemoryError(
        ErrorCodes.SPACE_INVALID,
        existing.isDirectory() ? `space already exists: ${id}` : `space path conflicts with a file: ${id}`,
        { spaceId: id, reason: 'conflict' },
      );
    }
    // Only now create the store. Any IO failure is surfaced as SPACE_INVALID so
    // the UI always gets a 400 with a stable, user-presentable code.
    try {
      await this.spaces.memoryFor(id);
    } catch (error) {
      throw new MemoryError(ErrorCodes.SPACE_INVALID, `failed to create space ${id}: ${error?.code ?? 'IO'}`, {
        spaceId: id,
        reason: 'create-failed',
        cause: error?.code ?? null,
      });
    }
    return { spaceId: id, created: true, spaces: this.spaces.status() };
  }

  // ---- L2.5 trend quarantine ---------------------------------------------

  /**
   * Folding ("推币机"): blocks evicted from the context window are not thrown
   * away. A light rule folds the most recent batch into ONE `folded_summary`
   * episode and writes it back to L1, tagged `status:folded`, so the transition
   * from context to long-term memory is smooth and observable.
   *
   * v1.5.0 native fidelity (Qwen mode): while the memory volume that would be
   * folded plus the live window stays BELOW `context.nativeTokenLimit`, nothing is
   * folded — verbatim is the point of a native window. Above it, the normal L1.5
   * layered fold runs. The check uses the pre-eviction volume (live blocks + the
   * evicted records' own tokens) because `enforce()` has already shrunk the live
   * window by the time the caller folds its report.
   */
  async foldEvicted(records = []) {
    return this.spaces.run(DEFAULT_SPACE_ID, () => this._foldEvictedLocal(records));
  }

  async _foldEvictedLocal(records = []) {
    this.assertOpen();
    const fresh = (records ?? []).filter((record) => record?.text && !this._foldedIds.has(record.id));
    if (fresh.length === 0) return null;
    const batch = fresh.slice(-FOLD_BATCH);
    const evictedTokens = batch.reduce((sum, record) => sum + (Number(record.tokens) || 0), 0);
    const native = this.context.nativeState({ sessionTokens: this.sessionUsage().tokens });
    if (native.tokens + evictedTokens < native.nativeTokenLimit) {
      return {
        folded: 0,
        mode: 'native',
        reason: 'native-mode',
        nativeTokenLimit: native.nativeTokenLimit,
        tokens: native.tokens + evictedTokens,
        note: 'token volume is below the native window; verbatim blocks are kept, no L1.5 fold',
      };
    }
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
      const result = await this._rememberLocal({
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
    this._markBriefingDirty();
    return result;
  }

  trends({ status } = {}) {
    this.assertOpen();
    return this.tempStore.list({ status, now: this.clock.now() });
  }

  /**
   * Status for one space. `targetSpaceId` is the UI space selector's routing hook:
   * a named space reports ITS OWN log/index/semantic/tag-tree counts, so the panel
   * and the L1/L2/L3 cards can never show a blended view. `spaceIds` is the root
   * router's id list (a child store does not know its siblings).
   */
  async status({ targetSpaceId, spaceIds = null } = {}) {
    this.assertOpen();
    const spaceId = normaliseSpaceId(targetSpaceId);
    if (spaceId === DEFAULT_SPACE_ID) return this._statusLocal(DEFAULT_SPACE_ID, spaceIds);
    return this.spaces.run(spaceId, (target) => target._statusLocal(spaceId, spaceIds));
  }

  async _statusLocal(spaceId = DEFAULT_SPACE_ID, spaceIds = null) {
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
    // v1.5.0 session/handoff surface: read-only projection for the status bar.
    const sessionUsage = this.sessionUsage();
    const native = this.context.nativeState({ now, sessionTokens: sessionUsage.tokens });
    const handoff = this.handoffState();
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
          // The ring includes raw: diskBytes walks the whole dataDir.
          diskBytes: diskUsage(this.dataDir),
          rawBytes: this.raw.stats().bytes,
          budgetMb: this.config?.storageBudgetMb ?? 50,
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
        // L1.5 tag-tree summary: node/ghost counts only. The full hierarchy is read
        // from state/tag-tree.json by the graph route, never assembled per request.
        tagTree: this.tagTree.status({ indexGeneration: index.generation ?? null }),
        // v1.4.0 surfaces: raw shards, review queue, pending deletes.
        raw: { ...this.raw.stats(), mode: this.config?.raw?.mode ?? 'salience' },
        reviews: this.reviews.status({ now }),
        pendingDeletes: this.pendingDeletes.status(now),
        // v1.5.0: the status bar and the space panel read exactly these fields.
        // `mode` is the Qwen native/layered decision (native below nativeTokenLimit);
        // `remainingTokens` is what the UI renders as "剩余 X Tokens 触发交接".
        session: {
          mode: native.mode,
          tokens: native.tokens,
          nativeTokenLimit: native.nativeTokenLimit,
          threshold: native.rolloverThreshold,
          ratio: native.ratio,
          remainingTokens: native.remainingTokens,
          rolloverEnabled: native.rolloverEnabled,
          rolloverDue: native.rolloverDue,
          sessionId: sessionUsage.sessionId,
          handoffActive: handoff.active === true,
          handoffAt: handoff.at ?? null,
          handoffSummaryEventId: handoff.summaryEventId ?? null,
          // v1.5.4: a degraded/failed handoff is VISIBLE, never a silent lock.
          handoffState: handoff.state ?? null,
          handoffDegraded: handoff.degraded === true,
          handoffErrorCode: handoff.summaryError?.code ?? handoff.error?.code ?? null,
        },
        spaces: {
          // The SELECTED space is the routing key for every card above: a status
          // read for `alpha` reports alpha's log/index and marks current=alpha.
          current: spaceId,
          ids: Array.isArray(spaceIds) ? spaceIds : this.spaces.status().ids,
          open: this.spaces.status().open,
        },
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
   * Written only when dirty: a write burst invalidates it once, the next prompt /
   * panel poll rebuilds it once, instead of every append rebuilding it.
   */
  briefing() {
    if (!this._briefing || this._briefingDirty) this.refreshBriefing();
    return this._briefing.text;
  }

  /** Invalidate the derived prompt-state line without recomputing it. */
  _markBriefingDirty() {
    this._briefingDirty = true;
  }

  refreshBriefing() {
    this._briefingDirty = false;
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

  /**
   * Project a validated config onto this facade AND every open child space.
   * Live values are read through `this.config` on every pass, so an operator edit
   * must not wait for a reload; the context engine's overrides are updated here
   * because it caches them at construction.
   */
  applyLiveConfig(config) {
    this.config = config ?? {};
    const engine = this.context;
    if (engine) {
      engine.maxTokensOverride = this.config.context?.maxTokens ?? null;
      engine.thresholdOverride = this.config.context?.threshold ?? null;
      engine.targetOverride = this.config.context?.target ?? null;
      engine.nativeTokenLimitOverride = this.config.context?.nativeTokenLimit ?? null;
      engine.rolloverThresholdOverride = this.config.context?.autoRolloverThreshold ?? null;
      engine.rolloverEnabledOverride = this.config.context?.autoRolloverEnabled ?? null;
    }
    for (const child of this._childMemories) {
      try {
        child.applyLiveConfig(this.config);
      } catch {
        // A closing/failed child must never block the live config update.
      }
    }
    return this.config;
  }

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

  /**
   * Sync shutdown: checkpoint the buffers we deliberately keep open on the hot path
   * (log append handle + manifest, identity-ledger hint). Both are recoverable, but
   * flushing here keeps a clean restart cheap and a test's temp dir complete.
   */
  close() {
    if (this._closed) return;
    this._closed = true;
    // Child spaces own their own append handles/timers: close them first, then the
    // default space. Idempotent, and a child failure must not leak the rest.
    for (const child of this._childMemories) {
      try {
        child.close();
      } catch {
        /* best effort */
      }
    }
    this._childMemories.clear();
    try {
      this.logStore.close();
    } catch {
      /* already closed */
    }
    try {
      this.ledger.persist();
    } catch {
      /* the log remains the truth source */
    }
  }
}
