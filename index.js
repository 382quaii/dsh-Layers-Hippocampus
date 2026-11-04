/**
 * DSH host plugin entry: @local/dsh-memory.
 *
 * Lifecycle (m02189, P0-informed):
 *   apply()
 *     -> resolveConfig()      strict, fail-fast; a bad value aborts activation
 *     -> register tools NOW   the tool surface must exist immediately, even while
 *                             the store is still loading (it answers MEM_E_NOT_READY)
 *     -> bootstrap() async    migrate (P1) -> Memory.init() -> scheduler/dream
 *     -> tick loop            ONE 60s loop drives cron AND the dream idle trigger
 *
 * Startup state machine (phases): 'pending' -> 'in_progress' -> 'ready' | 'failed'.
 *   - reads before 'ready' throw MEM_E_NOT_READY, EXCEPT while a migration is
 *     running: then reads are served from the legacy directory and tagged
 *     `readFrom: 'legacy'`. Writes are always refused before 'ready'.
 *   - the UI must never block on the store: `ctx.memory.phase` is readable at once.
 *
 * Scheduling: there is exactly ONE entry point, `runtime.runMaintenance(source)`.
 *   Cron ticks and the dream idle trigger both go through it, so a dream run and a
 *   cron run can never overlap; the loser returns {ran:false, skipped:true}.
 *
 * Memory tokens are injected ON DEMAND: the `memory-state` section is a function
 * that reads the live window at assemble time; nothing about memory history is
 * baked into the prompt at boot.
 *
 * No `@deepseek-ai/*` imports on purpose: the bundle has no dependencies, so it
 * must resolve standalone under pnpm's strict node_modules layout.
 */

import path from 'node:path';
import { resolveConfig, toMemoryOptions, DEFAULT_CONFIG, multiSpaceActive } from './src/config.js';
import { extractEntities } from './src/utils/RegexExtractor.js';
import { migrateDataDir } from './src/migration.js';
import { MigrationRunner } from './src/migrationRunner.js';
import { CronScheduler } from './src/scheduler.js';
import { asMemoryError, ErrorCodes, MemoryError } from './src/errors.js';
import { Memory, turnFromSessionEvent } from './src/memory.js';
import { composePrompt, renderActiveTask } from './src/utils/promptLayout.js';
import { renderMemoryHints, selectRelevantTags } from './src/utils/memoryHints.js';
import { HostBridge } from './src/hostBridge.js';
import { isLowValley, nextLowValleyStart, windowInfo } from './src/priceWindow.js';
import { DreamTimer } from './src/dreamTimer.js';
import { MEMORY_API, registerMemoryRoutes } from './src/webRoutes.js';

export const name = 'memory';
export const inject = ['tools', 'systemPrompt'];

/** Re-exported so the client bundle and tests share one route table. */
export { MEMORY_API };
/** Re-exported so tests and the README point at one schema. */
export { resolveConfig, DEFAULT_CONFIG };

/**
 * Capability handshake for the UI (v1.5.3). A newer client bundle may talk to an
 * OLDER host process after a hot reload (exactly the situation that produced
 * `MEM_E_SPACES: HTTP 404`): it can now check these flags BEFORE calling a route
 * that the old host does not serve, and degrade with human-readable copy instead
 * of letting a raw 404 reach the user.
 */
export const CAPABILITIES = Object.freeze({
  version: '1.5.6',
  spaces: true,
  memories: true,
  transferConsent: true,
  multiSpace: true,
});

/**
 * Runtime handles by context. Deliberately a WeakMap instead of `ctx.memory`:
 * naming that property collides with the `memory` service provided by another
 * plugin in this profile, and cordis rejects the bare assignment. Nothing outside
 * this module may depend on the handle — it exists for tests and the `apply` scope.
 */
const RUNTIMES = new WeakMap();

/** Must match package.json — the Loader row and the client module id use it too. */
const PACKAGE_NAME = 'dsh-layers-hippocampus';
/**
 * Soft-interception slim: the model already asked OUR tool, so this is the one
 * place we can shrink a response before it reaches the prompt. The full payload is
 * written to raw first, so the [Slimmed] recovery hash is always resolvable.
 */
export async function slimToolPayload(runtime, payload, { budgetTokens = 2000, capture = null } = {}) {
  const full = JSON.stringify(payload);
  const budgetChars = Math.max(500, budgetTokens * 4);
  if (full.length <= budgetChars) return full;
  const sink = capture ?? ((text) => runtime.memory.captureRaw({ content: text, role: 'tool', kind: 'tool_output', force: true, salience: 1, turnId: 'tool:' + Date.now() }));
  const captured = await sink(full);
  const hash = captured && captured.sha256 ? captured.sha256 : null;
  const entities = extractEntities(full).entities.slice(0, 8).map((entity) => entity.value);
  const hits = Array.isArray(payload.hits) ? payload.hits : [];
  const summary = hits.length > 0 ? hits.slice(0, 3).map((hit) => hit.snippet || hit.content || '').join(' ').slice(0, 800) : full.slice(0, 400);
  return JSON.stringify({
    ok: payload.ok !== false,
    slimmed: true,
    summary,
    topics: payload.candidateTags || payload.activeTags || [],
    key_entities: entities,
    recovery_hash: hash ? 'hash_' + hash.slice(0, 12) : null,
    hint: '[Slimmed] 内容过长已裁剪。恢复原话请调用 memory_recall(mode="deep_raw", hash="' + (hash ? hash.slice(0, 12) : '') + '")',
  });
}


/** The runtime created by `apply()` for this context, or null before activation. */
export function getRuntime(ctx) {
  return RUNTIMES.get(ctx) ?? null;
}

/** One minute: cron granularity, and the dream idleness check rides the same tick. */
const TICK_MS = 60_000;
/** Consecutive memory tool calls without a landing recall before reflection kicks in. */
export const REFLECTION_THRESHOLD = 12;

export const REFLECTION_TEXT = [
  'Reflection: several memory calls in a row have not produced a landing recall.',
  'Before calling more tools, ask: (1) is this fact durable, or turn narration?',
  '(2) should it be stored under an existing tag instead of a new one?',
  '(3) is the query a keyword the stored text actually contains?',
].join(' ');

/**
 * STABLE head of the `memory-state` prompt context. Prefix-cache discipline: this
 * text must not change for a given config, so it carries no counts and no timestamps.
 * The (slow-moving) memory map follows it; only the `[Memory Blocks]` tail is
 * per-turn volatile — that is the whole point of `composePrompt`.
 */
export const PROMPT_STATE_RULES = [
  'Memory state (live). The engine measures and pages this window; never trim it yourself.',
  'Only the memory blocks listed below are remembered facts for this turn - do not invent memories, tags or details.',
  'When a detail is missing, call the memory tools instead of guessing.',
].join('\n');

function errorJson(error) {
  // Failures are values, never thrown across the tool boundary: {ok:false,error}
  // mirrors the {ok:true,...} success shape.
  return JSON.stringify({ ok: false, error: asMemoryError(error).toJSON() });
}

function toolResult(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** ISO 8601 or epoch ms -> epoch ms; anything else is an input error, never NaN. */
function toEpoch(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{10,}$/.test(trimmed)) return Number(trimmed);
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new MemoryError(ErrorCodes.INVALID_INPUT, 'timestamp must be ISO 8601 or epoch ms', { got: String(value).slice(0, 60) });
}

/**
 * DSH tools take a JSON Schema with an OBJECT root. The author-facing shorthand in
 * this file is a map of `field -> schema` plus `required: true`, which is what
 * every definition below is written in. Compiling it here is the single place that
 * turns shorthand into schema — the previous inline `parameters: {action: ...}`
 * reached the provider as `type: null` and the tool was rejected.
 */
export function compileParameters(parameters = {}) {
  const properties = {};
  const required = [];
  for (const [field, rawSpec] of Object.entries(parameters)) {
    const { required: isRequired, ...schema } = rawSpec ?? {};
    properties[field] = schema;
    if (isRequired) required.push(field);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/** ToolDefinition with a schema that is valid by construction. */
export 

function defineTool(definition) {
  return { ...definition, parameters: compileParameters(definition.parameters) };
}

/**
 * The startup state machine + the single maintenance gate. Kept in this file
 * because it owns the plugin's lifecycle contracts; the store itself is src/.
 */
export function createRuntime({ ctx = null, config, options, clock, raw = null, orchestrator = null, timers = null }) {
  // v1.5.6 physical split: multi-space lives in dsh-orchestrator. `orchestrator` is a
  // test/embedding override; the Host supplies the real service through `ctx.get`.
  const orchestratorService = () => orchestrator ?? ctx?.get?.('orchestrator') ?? null;
  const multiSpaceExtras = () => {
    const orchestrator = orchestratorService();
    if (typeof orchestrator?.createSpaceAdapter !== 'function') return {};
    return {
      spacesFactory: (owner) =>
        orchestrator.createSpaceAdapter({
          owner,
          dataDir: owner.dataDir,
          openChild: async (childDir) =>
            Memory.open({
              dataDir: childDir,
              clock: owner.clock,
              policy: options.policy,
              config: owner.config,
              spaceId: path.basename(childDir),
              ...multiSpaceExtras(),
            }),
        }),
      transfer: typeof orchestrator.transfer === 'function' ? orchestrator.transfer : null,
      // v1.5.6: wire the Orchestrator's federation/dedupe services into the engine.
      federation: orchestrator.federation ?? null,
      dedupe: orchestrator.dedupe ?? null,
    };
  };
  // `let` (not const): a failed bootstrap can be retried by rebuilding the facade.
  let memory = new Memory({ dataDir: config.dataDir, policy: options.policy, config: options.config, clock, ...multiSpaceExtras() });
  // v1.5.6: engine warnings (currently MEM_E_AUTO_TAG_MISS) go to the Host log.
  memory.setWarnHook?.((code, message, details) => {
    ctx?.logger?.warn?.(`hippocampus: ${code} ${message}`, details);
  });

  const listeners = new Set();
  const runtime = {
    config,
    memory,
    logger: ctx?.logger ?? null,
    /** Raw (unresolved) config: re-merging a patch must not bake in defaults. */
    rawConfig: cloneRaw(raw ?? config),
    phase: 'pending',
    phaseError: null,
    readyAt: null,
    legacy: null,
    maintenanceInFlight: false,
    maintenanceSource: null,
    lastActiveAt: clock ? clock.now() : Date.now(),
    /** Last completed Dream (idle or compensating); null until one runs. */
    lastDreamAt: null,
    /** v1.5.6: the current Host agent preset ("工作模式"), tracked for handoff. */
    agentPreset: null,
    agentPresetSessionId: null,
    /** Result of the last handoff preset inheritance (observability). */
    lastPresetInherit: null,
    toolCalls: 0,
    reflectionActive: false,
    started: false,
    stopped: false,
    retrying: false,
    /** Last UI-triggered migration snapshot (state/migration.json), if any. */
    migration: null,
    /** Last observed user turn: the relevance input for `[Memory Hints]`. */
    lastUserText: '',
    /** Set by apply(): persists config patches through configEditor. */
    persist: null,
  };

  const migrationRunner = new MigrationRunner({
    stateFile: path.join(config.dataDir, 'state', 'migration.json'),
    clock: clock ?? { now: () => Date.now() },
    logger: ctx?.logger ?? null,
  });
  runtime.migrationRunner = migrationRunner;
  runtime.migration = migrationRunner.read();
  // Reconciliation: a successful migration leaves a "running" snapshot inside the
  // copied state/ file (the copy snapshots the runner's own record). If the live
  // dataDir already equals that snapshot's target, the job is done — mark it so
  // the UI never shows a phantom in-flight migration.
  if (
    runtime.migration &&
    runtime.migration.status === 'running' &&
    runtime.migration.to &&
    path.resolve(config.dataDir) === path.resolve(runtime.migration.to)
  ) {
    runtime.migration = { ...runtime.migration, status: 'ready', phase: 'done', finishedAt: clock ? clock.now() : Date.now() };
    try {
      migrationRunner.write(runtime.migration);
    } catch {
      /* best effort: the in-memory value is what the UI reads */
    }
  }

  let resolveReady;
  let rejectReady;
  runtime.ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // The promise is consumed by tests and the UI; an early failure must not become
  // an unhandled rejection just because nobody awaited it yet.
  runtime.ready.catch(() => {});

  runtime.subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const emit = (event) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        ctx?.logger?.warn?.(`hippocampus: ui listener failed: ${error?.message ?? error}`);
      }
    }
  };
  runtime.emit = emit;

  runtime.notReady = (operation) =>
    new MemoryError(ErrorCodes.NOT_READY, `memory is not ready yet (phase=${runtime.phase}); ${operation} unavailable`, {
      phase: runtime.phase,
      state: runtime.phase,
      retryable: true,
      error: runtime.phaseError ? asMemoryError(runtime.phaseError).toJSON() : null,
      hint: 'retry once startup completes; memory_admin/status reports phase during startup',
    });

  runtime.touch = () => {
    runtime.lastActiveAt = runtime.memory.clock.now();
  };

  /**
   * v1.5.6: learn the live agent's working mode (Host preset) and backfill it into
   * an active handoff marker. `agents.currentInitiator()` only answers inside an
   * agent turn, so this runs opportunistically (tool boundary / prompt assembly) and
   * never throws; the value is what the NEXT conversation will re-apply.
   */
  runtime.syncAgentPreset = () => {
    try {
      const presets = ctx?.get?.('agentPresets') ?? null;
      const agent = ctx?.get?.('agents')?.currentInitiator?.() ?? null;
      if (!presets || !agent) return null;
      const composed = presets.composedPreset?.(agent.ctx);
      if (typeof composed !== 'string' || composed.length === 0) return null;
      runtime.agentPreset = composed;
      runtime.agentPresetSessionId = agent.id ?? null;
      try {
        memory.patchHandoffPreset?.(composed);
      } catch {
        /* the marker patch is best-effort */
      }
      return composed;
    } catch {
      return null;
    }
  };

  /** Called by every tool: keeps the dream idle clock honest. */
  runtime.recordToolCall = ({ landed = false } = {}) => {
    runtime.syncAgentPreset();
    runtime.touch();
    runtime.toolCalls += 1;
    if (landed) runtime.toolCalls = 0;
    const active = config.enableReflection && runtime.toolCalls >= REFLECTION_THRESHOLD;
    if (active !== runtime.reflectionActive) {
      runtime.reflectionActive = active;
      emit({ type: 'reflection', active });
    }
    // v1.5.0: every tool boundary is a natural pseudo-turn. Evaluate the rollover
    // costlessly; only a due handoff performs I/O, and it must never surface as a
    // tool failure (fire-and-forget).
    if (runtime.phase === 'ready') {
      try {
        const usage = memory.sessionUsage();
        const native = memory.context.nativeState({ sessionTokens: usage.tokens });
        if (native.rolloverDue || native.forceEvictionDue) {
          memory
            .checkHandoff()
            .catch((error) => ctx?.logger?.warn?.(`hippocampus: handoff failed: ${asMemoryError(error).code}`));
        }
      } catch {
        /* accounting failure must never break a tool result */
      }
    }
  };

  runtime.reflectionText = () => (runtime.reflectionActive ? REFLECTION_TEXT : '');

  /**
   * Prompt text for the `memory-state` context, built on demand from the live
   * window. Layout is the cache-stable contract from `promptLayout`:
   *
   *   [stable rules]      constant for a given config  -> cacheable prefix
   *   [Memory Map]        active tags + counts         -> slow-moving prefix
   *   [Memory Blocks]     surviving window blocks      -> the only volatile tail
   *
   * Before READY it states the phase instead of pretending memory is empty. The old
   * one-line `briefing()` is still available for the panel/status surfaces but is no
   * longer the prompt body: a changing state line at the head would break the prefix
   * cache on every write.
   */
  /**
   * v1.5.6: session-scoped injection dedup. A tag / recall block / active-task
   * event already injected in THIS session is never injected again on a later turn:
   * repeating byte-identical content is what inflated the context cache hit rate and
   * made the model look like it was rereading the same page.
   */
  runtime.injection = { sessionId: null, ids: new Set(), tags: new Set(), handoffAt: null };
  runtime.lastHintTags = [];
  runtime.resetInjection = (sessionId = runtime.injection.sessionId) => {
    runtime.injection = { sessionId, ids: new Set(), tags: new Set(), handoffAt: null };
  };

  runtime.promptState = () => {
    // Opportunistic mode tracking: prompt assembly is inside the agent turn, so the
    // current preset is readable here even when no change event ever fired.
    runtime.syncAgentPreset();
    if (runtime.phase === 'ready') {
      const handoff = memory.handoffState();
      const usage = memory.sessionUsage();
      const sessionId = usage?.sessionId ?? 'anonymous';
      // SessionStart OR rollover resets the dedup pool: the new session may receive
      // the same handoff summary / tags that the old one already saw.
      if (runtime.injection.sessionId !== sessionId || (handoff.active && runtime.injection.handoffAt !== handoff.at)) {
        runtime.resetInjection(sessionId);
        runtime.injection.handoffAt = handoff.active ? handoff.at : null;
      }

      const view = memory.indexManager.snapshot();
      const entries = view?.activeSet?.entries ?? [];
      const activeTags = entries.map((entry) => ({ tag: entry.tag, count: entry.eventCount ?? 0 }));
      // v1.5.6: relevance-first hints; short inputs ("继续"/"在吗") fall back to the
      // previous turn's matched tags so the model still gets a thread to pull.
      const selected = selectRelevantTags({
        text: runtime.lastUserText,
        activeTags,
        fallbackTags: runtime.lastHintTags,
      });
      const freshTags = selected.filter((tag) => !runtime.injection.tags.has(tag));
      for (const tag of freshTags) runtime.injection.tags.add(tag);
      if (selected.length > 0) runtime.lastHintTags = selected;
      const hints = renderMemoryHints(freshTags, { toolName: `${config.toolPrefix}_recall` });

      // v1.5.6: [Active Task] is unconditional when a handoff summary or a `task:`
      // event exists — injected once per session.
      const activeTask = memory.promptActiveTask();
      let activeTaskBlock = '';
      if (activeTask?.text && !runtime.injection.ids.has(`active:${activeTask.eventId}`)) {
        runtime.injection.ids.add(`active:${activeTask.eventId}`);
        activeTaskBlock = renderActiveTask(activeTask);
      }

      // Recall blocks: the block id IS the event id. Render only blocks that this
      // session has not injected yet, then remember every non-briefing block id.
      const blocks = memory.context.render({ excludeIds: runtime.injection.ids });
      for (const block of memory.context.blocks ?? []) {
        if (block.kind !== 'briefing') runtime.injection.ids.add(block.id);
      }

      // v1.5.0 handoff marker: appended to the volatile tail on purpose — the
      // stable prefix above must stay byte-identical for the prompt cache.
      const marker = handoff.active
        ? [
            '',
            '[交接标记] 上下文已接近原生窗口上限，末尾摘要已存为 L1.5。',
            '新会话从该摘要继续即可；本插件不能保证一个会话永生不死，只能保证人格不死。',
            handoff.summaryEventId ? `摘要事件：${handoff.summaryEventId}` : null,
          ]
            .filter(Boolean)
            .join('\n')
        : '';
      return composePrompt({ rules: PROMPT_STATE_RULES, activeTask: activeTaskBlock, blocks, hints }) + marker;
    }
    const error = runtime.phaseError ? ` — ${asMemoryError(runtime.phaseError).code}` : '';
    return `Memory state: ${runtime.phase}${error} (not ready: memory tools answer MEM_E_NOT_READY).`;
  };

  /**
   * The ONE maintenance entry point. Concurrency is refused, not queued: two
   * rebuilds racing would publish out of order, and a queue would silently run a
   * stale job later.
   */
  runtime.runMaintenance = async (source = 'cron') => {
    if (runtime.stopped) return { ran: false, skipped: true, reason: 'stopped', source };
    if (runtime.phase !== 'ready') return { ran: false, skipped: true, reason: 'not-ready', source };
    if (runtime.maintenanceInFlight) {
      return { ran: false, skipped: true, reason: 'maintenance-in-flight', source };
    }
    runtime.maintenanceInFlight = true;
    runtime.maintenanceSource = source;
    runtime.touch();
    try {
      const report = await memory.maintain({ reason: source });
      // v1.5.5: the offline Dream leg runs AFTER the read model has converged and
      // NEVER on the online path. It can never fail the maintenance pass: any LLM
      // failure already degraded to the local merge inside executeDream().
      if (source === 'dream' || source === 'compensate') {
        try {
          report.dream = await memory.executeDream({ now: memory.clock.now(), logger: runtime.logger });
        } catch (error) {
          report.dreamError = asMemoryError(error).toJSON();
          runtime.logger?.warn?.(`hippocampus: dream distillation failed: ${asMemoryError(error).code}`);
        }
        runtime.lastDreamAt = memory.clock.now();
      }
      emit({ type: 'maintenance', source, report });
      return { ran: true, source, report };
    } finally {
      runtime.maintenanceInFlight = false;
      runtime.maintenanceSource = null;
    }
  };

  /**
   * One tick: cron first (it owns lastSuccessAt), then the dream idle check.
   * Both share runMaintenance, so at most one maintenance runs per process.
   */
  runtime.tick = async ({ now = memory.clock.now() } = {}) => {
    const results = [];
    if (runtime.scheduler) {
      results.push(await runtime.scheduler.tick({ now }));
    }
    if (!config.enableDream || runtime.phase !== 'ready' || runtime.maintenanceInFlight) return results;

    // v1.5.6 local scheduler: a queued (peak-deferred) Dream runs as soon as the
    // valley opens, even if the idle threshold was only just crossed.
    const queue = memory.dreamQueue();
    if (queue.pending && now >= (queue.dueAt ?? 0) && isLowValley(now)) {
      const result = await runtime.runMaintenance('dream');
      memory.clearDreamQueue(result.ran ? 'completed' : 'retry-later');
      runtime.dreamTimer?.cancel();
      results.push({ ...result, fromQueue: true });
      return results;
    }

    const idleMs = runtime.lastActiveAt === null ? Infinity : now - runtime.lastActiveAt;
    if (idleMs < config.dreamIdleMinutes * 60_000) return results;

    const llmDream = config.dream?.useLlm !== false;
    if (config.dream?.onlyLowValley !== false && llmDream && !isLowValley(now)) {
      const dueAt = nextLowValleyStart(now);
      memory.setDreamQueue({ pending: true, dueAt, reason: 'peak-hour', deferredAt: now });
      runtime.dreamTimer?.schedule(now);
      results.push({ ran: false, skipped: true, reason: 'peak-hour', dueAt, source: 'dream' });
      emit({ type: 'dream-deferred', dueAt, window: windowInfo(now) });
      return results;
    }
    results.push(await runtime.runMaintenance('dream'));
    return results;
  };

  /**
   * Reads during startup. A migration has a source of truth that is still valid:
   * the legacy directory. Serving from it beats both an empty answer and a stall.
   */
  runtime.recall = async (query) => {
    if (runtime.phase === 'ready') {
      runtime.recordToolCall();
      // v1.5.6: with the Orchestrator dedupe service installed, a recall spans every
      // open space (monthly memos and the events they own may live in different
      // spaces). A caller that explicitly targets one space stays single-space.
      const wantsSingle = query && typeof query === 'object' && typeof query.targetSpaceId === 'string';
      if (
        !wantsSingle &&
        memory.dedupe &&
        runtime.config.features.crossSpaceRecall === true &&
        runtime.multiSpaceAvailable?.() &&
        memory.spaces.status().ids.length > 1
      ) {
        return memory.recallAcrossSpaces(query ?? {});
      }
      return memory.recall(query);
    }
    if (runtime.legacy) {
      runtime.recordToolCall();
      const result = await runtime.legacy.recall(query);
      return { ...result, readFrom: 'legacy', note: `startup phase=${runtime.phase}; served from ${config.migrateFrom}` };
    }
    throw runtime.notReady('recall');
  };

  /**
   * Cross-space atomic transfer (v1.5.0). The runtime owns the READY gate; the
   * engine owns validation, privacy screening and the move->pending_delete handoff.
   */
  runtime.transferEvents = async (payload = {}) => {
    if (runtime.phase !== 'ready') throw runtime.notReady('space_transfer');
    runtime.recordToolCall({ landed: true });
    return memory.transferEvents(payload);
  };

  /** Recent-memory projection for the panel's per-memory 分享/转移 entry point. */
  runtime.recentMemories = async ({ limit = 20, targetSpaceId } = {}) => {
    if (runtime.phase !== 'ready') throw runtime.notReady('memories');
    return memory.recentMemories({ limit, targetSpaceId });
  };

  runtime.status = async () => {
    if (runtime.phase === 'ready') return memory.status();
    throw runtime.notReady('status');
  };

  runtime.start = () => {
    if (runtime.started) return runtime.ready;
    runtime.started = true;
    runtime.phase = 'in_progress';
    // Bootstrap is deliberately detached from apply(): activation must not block
    // on a large store or a copy.
    queueMicrotask(() => {
      runtime.bootstrap().catch(() => {
        /* recorded in phase/phaseError; the ready promise carries it to waiters */
      });
    });
    return runtime.ready;
  };

  runtime.bootstrap = async () => {
    try {
      await runtime.migrationStep();
      await memory.init();
      runtime.phase = 'ready';
      runtime.readyAt = memory.clock.now();
      runtime.scheduler = new CronScheduler({
        clock: memory.clock,
        // Read through runtime.config: applyConfig() swaps that object, the
        // capture below must never pin the boot-time cron.
        getCronExpression: () => runtime.config.maintenanceCron,
        run: () => runtime.runMaintenance('cron'),
        logger: {
          info: (message) => ctx?.logger?.info?.(message),
          warn: (message) => ctx?.logger?.warn?.(message),
          error: (message) => ctx?.logger?.error?.(message),
        },
      });
      memory.attachScheduler(runtime.scheduler);
      emit({ type: 'ready', at: runtime.readyAt });
      resolveReady(runtime);
      // Phase 2 self-heal: a queue persisted by a previous run may be due now.
      runtime.dreamTimer?.schedule();
      return runtime;
    } catch (error) {
      runtime.phase = 'failed';
      runtime.phaseError = error;
      ctx?.logger?.error?.(`hippocampus: startup failed: ${asMemoryError(error).code}: ${error?.message ?? error}`);
      rejectReady(error);
      throw error;
    }
  };

  /**
   * Migration, made safe to run in the background:
   *   - `migrateFrom` unset          -> probe the legacy folder names (rename-safe)
   *   - target already has data      -> refuse (no second blind full copy)
   *   - migration running            -> reads are redirected to the legacy dir
   */
  runtime.migrationStep = async () => {
    const { existsSync } = await import('node:fs');
    const { default: nodePath } = await import('node:path');
    const source = config.migrateFrom ?? (await discoverLegacyDataDir({ existsSync, dataDir: config.dataDir }));
    if (!source) return { status: 'disabled' };
    const canReadLegacy = existsSync(nodePath.join(source, 'log', 'CURRENT'));
    if (canReadLegacy) {
      try {
        runtime.legacy = new Memory({ dataDir: source, clock: memory.clock });
        await runtime.legacy.init();
      } catch (error) {
        ctx?.logger?.warn?.(`hippocampus: legacy read path unavailable: ${asMemoryError(error).code}`);
        runtime.legacy = null;
      }
    }
    const result = await migrateDataDir({ from: source, to: config.dataDir, clock: memory.clock });
    if (result.status === 'migrated') {
      ctx?.logger?.info?.(`hippocampus: migrated ${result.recordCount} records from ${result.from}`);
    }
    // The target is now authoritative; stop serving the old directory.
    runtime.legacy = null;
    return { ...result, discovered: config.migrateFrom ? false : true };
  };

  runtime.stop = () => {
    runtime.stopped = true;
    runtime.dreamTimer?.cancel();
    try {
      memory.close();
    } catch {
      /* the store is read-mostly; a close error must not break teardown */
    }
    try {
      runtime.legacy?.close();
    } catch {
      /* best effort */
    }
    listeners.clear();
  };

  /** Phase snapshot the UI polls; never throws, unlike the tools. */
  runtime.phaseView = () => ({
    phase: runtime.phase,
    // The protocol field the UI branches on. `state` and `phase` are the same
    // value on purpose: the handshake uses one name, logs keep the other.
    state: runtime.phase,
    ready: runtime.phase === 'ready',
    migrating: runtime.phase === 'migrating',
    readyAt: runtime.readyAt,
    error: runtime.phaseError ? asMemoryError(runtime.phaseError).toJSON() : null,
    maintenanceInFlight: runtime.maintenanceInFlight,
    maintenanceSource: runtime.maintenanceSource,
  });

  /**
   * UI cards read exactly this: one source of truth (no panel-specific math).
   * `spaceId` is the SELECTED space from the global SpaceSelector: every card in
   * the payload (log/index/semantic/L1.5 counts, session) belongs to that space.
   */
  runtime.uiPayload = async (spaceId = null) => {
    const view = runtime.phaseView();
    if (runtime.phase !== 'ready') {
      // Migration is a first-class state: the panel needs its progress even
      // though the store is offline for writes.
      // capabilities are advertised even before READY: the client must be able to
      // tell "old host" from "temporarily booting" without probing missing routes.
      return { ok: false, ...view, capabilities: runtime.capabilities(), host: runtime.hostStatus?.() ?? null, migration: runtime.migrationStatus() };
    }
    try {
      const spaceIds = memory.spaces.status().ids;
      const status = await memory.status({ targetSpaceId: spaceId ?? undefined, spaceIds });
      return {
        ok: true,
        ...view,
        spaceId: status.panel.spaces.current,
        // v1.5.6: the working mode in force, plus the last handoff inheritance result.
        agentPreset: runtime.agentPreset,
        presetInherit: runtime.lastPresetInherit,
        capabilities: runtime.capabilities(),
        host: runtime.hostStatus?.() ?? null,
        // v1.5.6 local low-valley scheduler observability.
        dreamWindow: runtime.dreamWindow?.() ?? null,
        dreamQueue: memory.dreamQueue(),
        dreamTimer: runtime.dreamTimer?.status() ?? null,
        panel: { ...status.panel, migration: runtime.migrationStatus() },
        briefing: memory.briefing(),
        config: uiConfig(runtime.config),
      };
    } catch (error) {
      return { ok: false, ...view, spaceId, agentPreset: runtime.agentPreset, capabilities: runtime.capabilities(), host: runtime.hostStatus?.() ?? null, error: asMemoryError(error).toJSON(), migration: runtime.migrationStatus() };
    }
  };

  /**
   * Graph route payload for the selected space. The cache is rebuilt by
   * maintenance, so this is a slice plus the phase: no sorting, no disk walk, no
   * log scan on the request path. A named space answers from ITS own cached
   * projection, so switching the selector cannot blend two spaces.
   */
  runtime.graphPayload = async (spaceId = null) => {
    const view = runtime.phaseView();
    if (runtime.phase !== 'ready') {
      return {
        ok: false,
        ...view,
        graph: { available: false, nodes: [], edges: [], totalEdges: 0, limit: runtime.config.graphMaxEdges },
        tagTree: { available: false, ghosts: [] },
      };
    }
    try {
      const { spaceId: selected, graph, tagTree } = await memory.graphForSpace({
        targetSpaceId: spaceId ?? undefined,
        limit: runtime.config.graphMaxEdges,
      });
      return { ok: true, phase: runtime.phase, state: runtime.phase, spaceId: selected, graph, tagTree };
    } catch (error) {
      return {
        ok: false,
        ...view,
        spaceId,
        error: asMemoryError(error).toJSON(),
        graph: { available: false, nodes: [], edges: [], limit: runtime.config.graphMaxEdges },
        tagTree: { available: false, ghosts: [] },
      };
    }
  };

  /** Global SpaceSelector data source (root router: every physical space). */
  runtime.spaceList = () =>
    runtime.phase === 'ready'
      ? runtime.multiSpaceAvailable()
        ? memory.spaces.status().ids
        : ['default']
      : [];

  /**
   * True only when a multi-space adapter (dsh-orchestrator) is present AND the
   * profile has not turned the capability off. The core alone is single-space.
   */
  runtime.multiSpaceAvailable = () => {
    const orchestrator = orchestratorService();
    return multiSpaceActive(runtime.config, typeof orchestrator?.createSpaceAdapter === 'function');
  };

  /**
   * Capability handshake read by the client bundle (old host → new UI safety).
   * v1.5.6: function, not a constant — the feature flags can change live and the
   * client must see `spaces:false` / `multiSpace:false` instead of a dead route.
   */
  runtime.capabilities = () => ({
    ...CAPABILITIES,
    spaces: runtime.multiSpaceAvailable(),
    multiSpace: runtime.multiSpaceAvailable(),
    crossSpaceTransfer: runtime.multiSpaceAvailable() && runtime.config.features.crossSpaceTransfer !== false,
    // v1.5.6: opt-in cross-space recall aggregation (default false).
    crossSpaceRecall: runtime.multiSpaceAvailable() && runtime.config.features.crossSpaceRecall === true,
    // v1.5.6: a versioned sub-capability. An OLD host (pre-delete) reports spaces:true
    // but no spacesDelete, so the client hides the delete button instead of sending an
    // action the old server would misread as CREATE ("空间已存在").
    spacesDelete: runtime.multiSpaceAvailable() && typeof memory.spaces?.deleteSpace === 'function',
  });

  /** "＋ 新建空间": creates the child store lazily, then returns the updated list. */
  runtime.ensureSpace = async (spaceId) => {
    if (runtime.phase !== 'ready') throw runtime.notReady('spaces');
    const result = await memory.ensureSpace(spaceId);
    emit({ type: 'spaces', spaces: result.spaces });
    return result;
  };

  /**
   * "＋ 新建空间" (strict): idempotency is NOT allowed here — an invalid/reserved/
   * existing id answers MEM_E_SPACE_INVALID (400), so the UI never gets a raw IO
   * error and JSONL is never touched by a bad name.
   */
  runtime.createSpace = async (spaceId) => {
    if (runtime.phase !== 'ready') throw runtime.notReady('spaces');
    const result = await memory.createSpace(spaceId);
    emit({ type: 'spaces', spaces: result.spaces });
    return result;
  };

  /**
   * v1.5.6: "🗑 删除空间". Destructive, so `confirm:true` is mandatory and the
   * default space is always refused. Emits the updated list for the client.
   */
  runtime.deleteSpace = async (spaceId, { confirm = false } = {}) => {
    if (runtime.phase !== 'ready') throw runtime.notReady('spaces');
    const result = await memory.deleteSpace(spaceId, { confirm });
    emit({ type: 'spaces', spaces: result.spaces });
    return result;
  };

  /**
   * ESCAPE HATCH (v1.5.4): force the rollover state machine back to a clean slate.
   * This is the user-facing recovery path when a handoff wedged the session; it
   * clears the live token baseline, the in-flight guard and any active marker.
   */
  runtime.resetSessionState = async ({ reason = 'manual' } = {}) => {
    if (runtime.phase !== 'ready') throw runtime.notReady('reset_session');
    const result = memory.resetSessionState({ reason });
    emit({ type: 'handoff-reset', result });
    return result;
  };

  /** What the UI may read AND write (never exposes policy or paths it cannot set). */
  runtime.uiConfig = () => uiConfig(runtime.config);

  /**
   * Swap in an already-validated config. Live fields take effect immediately;
   * the cron expression is re-read by the scheduler on every tick, and the
   * context engine reads its overrides on every enforce(), so nothing here
   * needs a restart.
   */
  runtime.applyConfig = (next) => {
    runtime.config = next;
    // Retrieval reads `memory.policy` on every call. The resolved policy is
    // deep-frozen, so replace it with a shallow copy carrying the new topK
    // instead of mutating a frozen object (which throws in strict mode).
    const liveMemory = runtime.memory;
    if (liveMemory?.policy?.candidates) {
      liveMemory.policy = {
        ...liveMemory.policy,
        candidates: { ...liveMemory.policy.candidates, topK: next.retrieval.topK },
      };
    }
    // Live config groups (context budgets/rollover, raw limits, retrieval
    // confidence, tagTree lifetimes, index cap, …) are read through
    // `memory.config` on every pass. Project the validated config onto the running
    // facade (and every open child space) instead of waiting for a reload: the
    // settings page promises "保存后立即生效".
    if (liveMemory) liveMemory.applyLiveConfig(toMemoryOptions(next).config);
    emit({ type: 'config', config: uiConfig(next) });
    return next;
  };

  /**
   * Validate-then-apply. resolveConfig() is the ONLY validator: a bad patch
   * throws MEM_E_CONFIG_* and leaves the running config untouched.
   */
  runtime.updateConfig = async (patch) => {
    const merged = mergeRaw(cloneRaw(runtime.rawConfig), patch);
    const next = resolveConfig(merged);
    runtime.applyConfig(next);
    runtime.rawConfig = merged;
    return next;
  };

  /**
   * UI-triggered data-dir migration. Returns as soon as the background job is
   * accepted (HTTP 202); the copy/verify/reload continues out of band and the
   * caller polls `state` until it is `ready` again.
   *
   * ISOLATION (validation point 1): this is the PHYSICAL storage state machine
   * only (A/B copy of <dataDir>, state=migrating, verified swap). It shares no
   * state, no queue and no UI flow with business-data transfer
   * (`Memory.transferEvents`, which moves event ids between spaces and is gated by
   * requireExplicitConsentForTransfer). The only common trait is "migration" in
   * the name; a failure here never parks a memory pending-delete and a refused
   * transfer never touches the data directory.
   *
   * FAIL-FAST (validation point 2): `migrationRunner.start` validates the target
   * synchronously (absolute, not equal/inside the current dir, not a root, empty or
   * absent) and throws MEM_E_MIGRATION_PATH / MEM_E_MIGRATION_TARGET_BUSY BEFORE a
   * 202 is returned and before any copy starts; the old direction remains
   * authoritative and untouched.
   */
  runtime.startMigration = (targetDir) => {
    if (runtime.phase === 'migrating') {
      throw new MemoryError(ErrorCodes.MIGRATION_LOCKED, 'a migration is already running', { to: runtime.migration?.to ?? null });
    }
    if (runtime.phase !== 'ready') {
      throw runtime.notReady('migrate');
    }
    const from = runtime.config.dataDir;
    const descriptor = migrationRunner.start({
      from,
      to: targetDir,
      timeoutMs: runtime.config.migration.timeoutMs,
      onSuccess: async (job) => {
        try {
          await runtime.completeMigration(job);
        } catch (error) {
          runtime.migration = { ...job, status: 'failed', error: { code: asMemoryError(error).code, message: error.message } };
          runtime.phase = 'ready';
          emit({ type: 'migration', migration: runtime.migration });
          ctx?.logger?.error?.(`hippocampus: migration reload failed: ${error?.message ?? error}`);
        }
      },
      onFailure: async (job) => {
        // The old store is still authoritative; keep serving it.
        runtime.migration = job;
        runtime.phase = 'ready';
        emit({ type: 'migration', migration: job });
      },
    });
    runtime.phase = 'migrating';
    runtime.migration = descriptor;
    emit({ type: 'migration', migration: descriptor });
    return descriptor;
  };

  /** Verify + switch: only called after the runner counted both logs. */
  runtime.completeMigration = async (job) => {
    const merged = mergeRaw(cloneRaw(runtime.rawConfig), { dataDir: job.to });
    const next = resolveConfig(merged);
    const nextOptions = toMemoryOptions(next);
    try {
      if (typeof runtime.persist === 'function') await runtime.persist({ dataDir: job.to });
    } catch (error) {
      // Persistence failing must not leave two authoritative stores: report it.
      ctx?.logger?.warn?.(`hippocampus: migration persisted=false: ${error?.message ?? error}`);
    }
    try {
      memory.close();
    } catch {
      /* the old store is read-mostly */
    }
    memory = new Memory({ dataDir: next.dataDir, policy: nextOptions.policy, config: nextOptions.config, clock, ...multiSpaceExtras() });
    runtime.memory = memory;
    runtime.config = next;
    runtime.rawConfig = merged;
    await memory.init();
    if (runtime.scheduler) memory.attachScheduler(runtime.scheduler);
    // The runner still points at the OLD state file; rebase it on the new dataDir
    // and record the victory there, so the next boot does not read a stale copy.
    migrationRunner.stateFile = path.join(next.dataDir, 'state', 'migration.json');
    const finished = { ...job, status: 'ready', phase: 'done', finishedAt: memory.clock.now(), error: null };
    migrationRunner.write(finished);
    runtime.migration = finished;
    runtime.phase = 'ready';
    runtime.readyAt = memory.clock.now();
    emit({ type: 'migration', migration: job });
    emit({ type: 'ready', at: runtime.readyAt, migratedTo: job.to });
    return job;
  };

  runtime.migrationStatus = () => {
    const latest = migrationRunner.read();
    if (latest) {
      // Same reconciliation as boot, for the window before the reload completes.
      if (
        latest.status === 'running' &&
        runtime.phase === 'ready' &&
        latest.to &&
        path.resolve(runtime.config.dataDir) === path.resolve(latest.to)
      ) {
        runtime.migration = { ...latest, status: 'ready', phase: 'done', finishedAt: memory.clock.now(), error: null };
        try {
          migrationRunner.stateFile = path.join(runtime.config.dataDir, 'state', 'migration.json');
          migrationRunner.write(runtime.migration);
        } catch {
          /* the in-memory value is authoritative for this call */
        }
        return runtime.migration;
      }
      runtime.migration = latest;
    }
    return runtime.migration;
  };

  /**
   * Retry a failed bootstrap. Only valid in the `failed` phase: a store that
   * opened fine must never be torn down by a stray click, and two retries must
   * not race (the `retrying` flag is checked synchronously).
   */
  runtime.retry = async () => {
    if (runtime.phase !== 'failed') {
      return { ok: false, code: 'MEM_E_NOT_FAILED', phase: runtime.phase, message: 'retry is only available while phase=failed' };
    }
    if (runtime.retrying) {
      return { ok: false, code: 'MEM_E_RETRY_IN_FLIGHT', phase: runtime.phase, message: 'a retry is already running' };
    }
    runtime.retrying = true;
    runtime.phase = 'pending';
    runtime.phaseError = null;
    runtime.started = false;
    runtime.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    runtime.ready.catch(() => {});
    try {
      memory.close();
    } catch {
      /* a half-open store must not block the rebuild */
    }
    memory = new Memory({ dataDir: config.dataDir, policy: options.policy, config: options.config, clock, ...multiSpaceExtras() });
    runtime.memory = memory;
    memory.setHandoffPresetProvider?.(() => runtime.agentPreset);
    emit({ type: 'retry', phase: runtime.phase });
    queueMicrotask(() => {
      runtime.bootstrap()
        .then(() => {
          runtime.retrying = false;
        })
        .catch(() => {
          runtime.retrying = false;
        });
    });
    return { ok: true, phase: runtime.phase, retrying: true };
  };

  /**
   * v1.5.6: carry the working mode across a handoff. `agent/created` is SERIAL, so
   * this hook can `agentPresets.select()` before the new session's first turn. It
   * only fires for a brand-new conversation (`source === 'startup'`), only when the
   * pending marker belongs to a DIFFERENT session, and it never throws (a failed
   * inheritance must not fail agent creation).
   */
  runtime.inheritHandoffPreset = async ({ agent, source } = {}) => {
    if (!agent || source !== 'startup') return { inherited: false, reason: 'not-a-new-conversation' };
    const marker = memory.handoffState();
    if (!marker?.active) return { inherited: false, reason: 'no-handoff' };
    if (marker.sessionId && agent.id === marker.sessionId) return { inherited: false, reason: 'same-session' };
    const preset = typeof marker.agentPreset === 'string' && marker.agentPreset.length > 0 ? marker.agentPreset : null;
    if (!preset) {
      runtime.lastPresetInherit = { inherited: false, reason: 'marker-without-preset', at: memory.clock.now() };
      return runtime.lastPresetInherit;
    }
    const presets = ctx?.get?.('agentPresets') ?? null;
    if (!presets || typeof presets.select !== 'function') {
      runtime.lastPresetInherit = { inherited: false, reason: 'agentPresets-unavailable', preset };
      return runtime.lastPresetInherit;
    }
    try {
      const committed = await presets.select(agent, preset);
      runtime.agentPreset = typeof committed === 'string' ? committed : preset;
      runtime.agentPresetSessionId = agent.id ?? null;
      runtime.lastPresetInherit = { inherited: true, preset: runtime.agentPreset, at: memory.clock.now() };
      ctx?.logger?.info?.(`hippocampus: new conversation restored working mode "${runtime.agentPreset}" from the handoff marker`);
      return runtime.lastPresetInherit;
    } catch (error) {
      runtime.lastPresetInherit = { inherited: false, reason: error?.code ?? 'select-failed', message: error?.message ?? String(error), preset };
      ctx?.logger?.warn?.(`hippocampus: handoff preset inheritance failed: ${error?.message ?? error}`);
      return runtime.lastPresetInherit;
    }
  };

  /**
   * Host lifecycle bridge (P1-7): a session start may trigger ONE compensating
   * Dream, gated by `dream.compensateAfterHours`, the injected price window and the
   * shared maintenance gate. `ctx.root` is the process-local event bus; the bridge
   * only needs a plain `{on, off}` seam, so tests inject a MockHostEnvironment.
   */
  runtime.hostBridge = new HostBridge({
    bus: ctx?.root ?? ctx ?? null,
    clock: () => memory.clock.now(),
    logger: ctx?.logger ?? null,
    getConfig: () => runtime.config,
    getLastDreamAt: () => runtime.lastDreamAt,
    onDream: () => runtime.runMaintenance('compensate'),
    onAgentPresetSelected: (sessionId, agentPreset) => {
      runtime.agentPreset = agentPreset;
      runtime.agentPresetSessionId = sessionId ?? null;
    },
    onAgentCreated: async (payload) => {
      // Track the mode this session actually runs in (a session may be created with
      // a preset without emitting a change event).
      try {
        const presets = ctx?.get?.('agentPresets');
        const composed = presets?.composedPreset?.(payload?.agent?.ctx);
        if (typeof composed === 'string' && composed.length > 0) {
          runtime.agentPreset = composed;
          runtime.agentPresetSessionId = payload?.agent?.id ?? null;
        }
      } catch {
        /* preset tracking is best-effort */
      }
      await runtime.inheritHandoffPreset(payload);
    },
  });
  runtime.hostBridge.attach();
  runtime.hostStatus = () => runtime.hostBridge.status();
  // v1.5.6 local scheduler: the price window is computed from the clock, so a
  // compensating Dream obeys peak hours without any external price plugin. An
  // explicit DSH_DREAM_PRICE override wins (hostBridge reads it when no probe).
  if (!process.env.DSH_DREAM_PRICE) {
    runtime.hostBridge.setPriceProbe((now) => isLowValley(now ?? memory.clock.now()));
  }
  runtime.dreamWindow = () => windowInfo(memory.clock.now());
  // Phase 2: one injectable wake-up timer, armed from the durable queue. A late
  // wake re-reads the window; a peak wake re-arms instead of spending.
  runtime.dreamTimer = new DreamTimer({
    clock: () => memory.clock.now(),
    getQueue: () => memory.dreamQueue(),
    isLow: (now) => isLowValley(now),
    nextLow: (now) => nextLowValleyStart(now),
    logger: ctx?.logger ?? null,
    ...(timers && typeof timers === 'object' ? timers : {}),
    onDue: async ({ now, lateMs, catchUp }) => {
      if (runtime.phase !== 'ready' || runtime.maintenanceInFlight) return;
      const result = await runtime.runMaintenance('dream');
      memory.clearDreamQueue(result.ran ? 'completed' : 'retry-later');
      emit({ type: 'dream-wake', now, lateMs, catchUp, ran: result.ran === true });
    },
  });
  // The handoff marker records the mode in force at rollover time.
  memory.setHandoffPresetProvider?.(() => runtime.agentPreset);
  // Explicit, loud degradation: a profile that asks for multi-space while the
  // Orchestrator is not installed runs strict single-space (never silent).
  if (runtime.config.features.multiSpace !== false && !runtime.multiSpaceAvailable()) {
    ctx?.logger?.warn?.(
      'hippocampus: features.multiSpace requested but dsh-orchestrator is not installed; running the strict single-space core (space tools/routes disabled)',
    );
  }

  return runtime;
}

/** Deep clone for plain JSON-ish configs (freezes are not needed: resolveConfig re-freezes). */
function cloneRaw(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneRaw);
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = cloneRaw(entry);
  return out;
}

/** Merge a validated nested patch onto the raw config. */
function mergeRaw(target, patch) {
  const out = cloneRaw(target);
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeRaw(out[key] ?? {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The UI config contract: exactly the fields the settings form renders and the
 * panel reads. `identity`/`retrieval` stay nested so the form's dotted keys map
 * 1:1 onto the patch it sends back.
 */
function uiConfig(config) {
  return {
    dataDir: config.dataDir,
    maintenanceCron: config.maintenanceCron,
    briefing: config.briefing,
    promptSection: config.promptSection,
    autoMaintainOnBoot: config.autoMaintainOnBoot,
    enableDream: config.enableDream,
    dreamIdleMinutes: config.dreamIdleMinutes,
    enableReflection: config.enableReflection,
    graphMaxEdges: config.graphMaxEdges,
    storageBudgetMb: config.storageBudgetMb,
    maxRecallTopK: config.maxRecallTopK,
    retrieval: { topK: config.retrieval.topK },
    // v1.5.0 index cap: the settings form edits index.maxPostingsPerTag.
    index: config.index,
    context: config.context,
    temp: config.temp,
    decay: config.decay,
    activeSet: config.activeSet,
    raw: config.raw,
    delete: config.delete,
    review: config.review,
    migration: config.migration,
    identity: { eventTimePolicy: config.identity.eventTimePolicy },
    // L1.5: the four editable knobs are nested so the form's dotted keys map 1:1.
    tagTree: config.tagTree,
    // Tool schema pruning: the settings page renders a checkbox catalog from this.
    tools: config.tools,
    // Pre-ingest tagging (v1.5.6): toggle + maxTags.
    tagging: config.tagging,
    // v1.5.6 capability flags (microkernel boundary).
    features: config.features,
    // v1.5.6 L2 multi-merge tunables.
    l2Merge: config.l2Merge,
    // v1.5.6: offline Dream tunables — SAFE SUBSET ONLY. `dream.llm` is deliberately
    // absent: the endpoint/credential live in the profile or DSH_DREAM_LLM_* env and
    // must never round-trip through the browser.
    dream: {
      useLlm: config.dream.useLlm,
      minGroupSize: config.dream.minGroupSize,
      maxGroupsPerRun: config.dream.maxGroupsPerRun,
      maxSummaryChars: config.dream.maxSummaryChars,
      maxSourceChars: config.dream.maxSourceChars,
      maxEventsPerGroup: config.dream.maxEventsPerGroup,
      llmTimeoutMs: config.dream.llmTimeoutMs,
      failureThreshold: config.dream.failureThreshold,
      cooldownMinutes: config.dream.cooldownMinutes,
      compensateAfterHours: config.dream.compensateAfterHours,
      onlyLowValley: config.dream.onlyLowValley,
    },
    // Convenience mirrors kept for older clients; the form uses the nested form.
    eventTimePolicy: config.identity.eventTimePolicy,
    retrievalTopK: config.retrieval.topK,
  };
}

/**
 * Folder names this plugin has used for its store. The package was renamed, and a
 * rename must never look like data loss: when `migrateFrom` is unset and the
 * target has no data of its own, the first legacy directory that exists wins.
 */
export const LEGACY_DATA_DIR_NAMES = Object.freeze([
  'memory',
  'dsh-memory',
  'hippocampus',
  'Layers-Hippocampus',
  'dsh-Layers-Hippocampus',
]);

export async function discoverLegacyDataDir({ existsSync, dataDir }) {
  const { default: nodePath } = await import('node:path');
  const target = nodePath.resolve(dataDir);
  // Never migrate INTO a store that already has data: that would be a second
  // blind copy over live state.
  if (existsSync(nodePath.join(target, 'log', 'CURRENT'))) return null;
  const root = nodePath.dirname(target);
  for (const name of LEGACY_DATA_DIR_NAMES) {
    const candidate = nodePath.join(root, name);
    if (candidate === target) continue;
    if (existsSync(nodePath.join(candidate, 'log', 'CURRENT'))) return candidate;
  }
  return null;
}

/**
 * @param {object} ctx Cordis context (tools + systemPrompt services)
 * @param {object} [rawConfig] plugin config from cordis.patch.yml / Config panel
 */
export async function apply(ctx, rawConfig = {}) {
  // Fail-fast: an invalid config must abort activation, never fall back to defaults.
  const config = resolveConfig(rawConfig);
  const options = toMemoryOptions(config);

  const runtime = createRuntime({ ctx, config, options, raw: rawConfig });
  // Internal handle, kept OFF the context: `ctx.memory` is a provided service name
  // in this profile (another memory plugin owns it), and assigning it directly
  // throws "cannot set property without provide". Tests reach the runtime through
  // getRuntime() instead of a context property.
  RUNTIMES.set(ctx, runtime);

  ctx.effect(() => {
    const disposers = [];

    // ---- HTTP surface: WAIT for the webServer service ----------------------
    // ROOT CAUSE of the cold-start 404: `webServer` is provided by a LATER row
    // (the web app), so `ctx.get('webServer')` is undefined while this plugin's
    // `apply()` runs at boot. Registering only "if available" skipped the routes
    // on every cold start — warm reloads worked because the service already
    // existed. `ctx.inject` is the ordering fix: this child fiber is created now
    // and activates the moment `webServer` is provided.
    //
    // ASSUMPTION (explicit): the Host serves registered `webServer` routes once
    // the providing row is active. This plugin's `apply()` awaits nothing, and
    // bootstrap stays detached (`runtime.start()` schedules it on a microtask).
    ctx.inject(['webServer'], (webCtx) => {
      const editor = ctx.get?.('configEditor') ?? null;
      const persistConfig = async (patch) => {
        if (!editor || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
          return { persisted: false, note: 'configEditor unavailable: the change applies until restart' };
        }
        const entries = editor.entries() ?? [];
        // Match by the package name this build declares, then by any of the row
        // ids it has shipped under. A row renamed by a profile patch must still be
        // found: the previous hard-coded '@local/dsh-memory' made every save
        // live-only after the rename.
        const rowNameOf = (candidate) => candidate?.options?.name ?? candidate?.name ?? '';
        const rowIdOf = (candidate) => candidate?.options?.id ?? candidate?.id ?? '';
        const entry =
          entries.find((candidate) => rowNameOf(candidate) === PACKAGE_NAME) ??
          entries.find((candidate) => ['hippocampus', 'memory'].includes(rowIdOf(candidate))) ??
          entries.find((candidate) => String(rowNameOf(candidate)).includes('dsh-memory')) ??
          entries.find((candidate) => String(rowNameOf(candidate)).includes('hippocampus'));
        if (!entry) {
          return { persisted: false, note: 'profile row not found: the change applies until restart' };
        }
        await editor.edit(entry, (current) => mergeRaw(cloneRaw(current), patch));
        return { persisted: true };
      };

      // A successful UI migration persists the new dataDir through the same seam.
      runtime.persist = persistConfig;
      const routes = registerMemoryRoutes(webCtx, { runtime, persist: persistConfig, logger: ctx.logger });
      if (routes.registered) {
        disposers.push(routes.dispose);
        // Proof line: cold start reached the serving state.
        console.log(
          `[Hippocampus] Route registered at ${new Date().toISOString()} (${routes.paths.join(', ')}) phase=${runtime.phase}`,
        );
        ctx.logger?.info?.(`hippocampus: http routes ${routes.paths.join(', ')}`);
      } else {
        console.error(`[Hippocampus] Route registration FAILED: ${routes.reason}`);
        ctx.logger?.warn?.(`hippocampus: http routes not registered (${routes.reason})`);
      }
    });

    /**
     * Tool schema pruning (v1.5.3): every registered definition costs its JSON
     * schema in prompt tokens on EVERY turn. `tools.disabled` is validated
     * fail-fast in resolveConfig (unknown/core/duplicate names abort activation),
     * so this filter can be a pure set lookup. Disabled tools are not registered
     * AND are not advertised in the `memory` prompt section below — pruning the
     * schema without pruning the instructions would lie to the model.
     */
    const disabledToolSuffixes = new Set(config.tools?.disabled ?? []);
    const toolSuffixOf = (definition) => {
      const prefix = `${config.toolPrefix}_`;
      return definition.name.startsWith(prefix) ? definition.name.slice(prefix.length) : definition.name;
    };
    // v1.5.6 microkernel boundary: a disabled capability removes its tools from the
    // registry AND from the prompt section, so the model is never told about a
    // facility the profile turned off.
    const featureDisabledSuffix = (suffix) =>
      (suffix === 'space_transfer' || suffix === 'transfer_to_global') &&
      !runtime.capabilities().crossSpaceTransfer;
    const register = (definition) => {
      const suffix = toolSuffixOf(definition);
      if (disabledToolSuffixes.has(suffix)) {
        ctx.logger?.info?.(`hippocampus: tool ${definition.name} skipped by config.tools.disabled`);
        return;
      }
      if (featureDisabledSuffix(suffix)) {
        ctx.logger?.info?.(`hippocampus: tool ${definition.name} skipped by disabled feature flags`);
        return;
      }
      disposers.push(ctx.tools.register(definition));
    };
    const toolLine = (suffix, text) =>
      disabledToolSuffixes.has(suffix) || featureDisabledSuffix(suffix) ? null : `- ${config.toolPrefix}_${suffix}: ${text}`;

    // ---- automatic raw capture: every surface message, verbatim ------------
    // `dsh-session` publishes `session/event` as (session, event). Subscribing at
    // the root context is what reaches sessions created by the agent's fiber; the
    // raw store's own gating/budgets still decide what lands on disk.
    const captureListener = (session, event) => {
      if (!runtime.memory || runtime.phase !== 'ready') return;
      // v1.5.6: remember the latest USER turn as the relevance input for
      // `[Memory Hints]`. This is the only place the current input is available:
      // prompt assembly receives no message text.
      try {
        const turn = turnFromSessionEvent(event);
        if (turn && turn.role === 'user' && turn.text && turn.contextOnly !== true) runtime.lastUserText = turn.text;
      } catch {
        /* hint relevance must never affect capture */
      }
      runtime.memory
        .captureSessionEvent(session, event)
        .then((result) => {
          if (result?.stored) runtime.logger?.debug?.(`hippocampus: raw ${result.role ?? 'turn'} stored (${result.bytes}B)`);
        })
        .catch((error) => {
          runtime.logger?.warn?.(`hippocampus: raw capture failed: ${asMemoryError(error).code}: ${error?.message ?? error}`);
        });
    };
    const bus = ctx.root ?? ctx;
    if (typeof bus.on === 'function') {
      bus.on('session/event', captureListener);
      disposers.push(() => bus.off?.('session/event', captureListener));
    }

    const guard = (operation) => {
      if (runtime.phase === 'ready') return null;
      if (operation === 'recall' && runtime.legacy) return null; // served from legacy
      return errorJson(runtime.notReady(operation));
    };

    const stillStarting = async (operation, fn) => {
      const blocked = guard(operation);
      if (blocked) return blocked;
      try {
        return await fn();
      } catch (error) {
        return errorJson(error);
      }
    };

    register(
      defineTool({
        name: `${config.toolPrefix}_remember`,
        description:
          'Store one durable memory in the append-only log. Identity is content-addressed ' +
          '(content_hash + event_time + occurrence_index). Idempotent by default: replaying the same payload at the ' +
          'same event_time returns the existing event id instead of writing twice. Invalid payloads (empty content) ' +
          'are routed to the DLQ and never overwrite a stored event.',
        parameters: {
          content: {
            type: 'string',
            description: 'The memory text. Canonicalised (whitespace, full/half-width, key order) before hashing.',
            required: true,
          },
          tags: { type: 'array', items: { type: 'string' }, description: 'Topic tags, e.g. ["project:dsh","preference"]' },
          salience: { type: 'number', description: 'Importance 0..1 (default 0.5)' },
          happened_at: {
            type: 'string',
            description:
              'When it happened: ISO 8601 or epoch ms. A value WITHOUT an offset is interpreted as UTC. ' +
              (config.identity.eventTimePolicy === 'explicit'
                ? 'Required by identity.eventTimePolicy="explicit".'
                : 'Optional; when omitted the time is derived from the content (see eventTimePolicy).'),
            ...(config.identity.eventTimePolicy === 'explicit' ? { required: true } : {}),
          },
          entity: { type: 'string', description: 'Stable subject key; records about it share an entity_id across revisions' },
          meta: { type: 'object', description: 'Structured payload merged into content_hash' },
          idempotency_key: { type: 'string', description: 'Client idempotency key; a repeat returns the existing event id' },
          dedupe: { type: 'boolean', description: 'Default true. false records a genuine second occurrence' },
          is_transient_trend: { type: 'boolean', description: 'Mark as a trend: isolated in L2.5, never promoted directly' },
          pinned: {
            type: 'boolean',
            description:
              'Pin a lesson/experience that must never decay and is ranked FIRST when its tag matches (v1.5.6). ' +
              'Requires at least one explicit tag; a pinned write without tags is refused with MEM_E_PINNED_TAG_REQUIRED.',
          },
          target_space_id: {
            type: 'string',
            description:
              'Optional physical space id (v1.5.0). Omit for the default space; each space has its own isolated log/index and file lock.',
          },
          media_url: {
            type: 'string',
            description:
              'Pointer to an attachment: an absolute file path or an http(s) URL. ' +
              'Inline base64 in content is rejected (MEM_E_INVALID_MEDIA) past 256 consecutive characters.',
          },
          media_type: {
            type: 'string',
            enum: ['image', 'video', 'document', 'audio'],
            description: 'Required when media_url is set.',
          },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => toolResult(value) },
        execute: async (args = {}) =>
          stillStarting('remember', async () => {
            runtime.touch();
            const result = await memory_remember(runtime, args, { mediaUrl: args.media_url, mediaType: args.media_type });
            runtime.recordToolCall({ landed: result.status === 'appended' });
            return JSON.stringify({ ok: true, ...result, eventTimeIso: iso(result.eventTime) });
          }),
      }),
    );

    register(
      defineTool({
        name: `${config.toolPrefix}_checkpoint`,
        description:
          'Record the single active heavy task (snapshot). Exactly one checkpoint is active: writing a new one ' +
          'demotes the previous, and one not refreshed for 7 days is demoted by maintenance. Read it back with ' +
          'memory_admin action="active_task", which queries the index directly and ignores the active-set cap.',
        parameters: {
          task_id: { type: 'string', description: 'Stable task identifier', required: true },
          progress: { type: 'number', description: 'Percent complete, 0..100', required: true },
          updated_at: { type: 'string', description: 'ISO 8601 or epoch ms; defaults to now' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => toolResult(value) },
        execute: async (args = {}) =>
          stillStarting('checkpoint', async () => {
            runtime.touch();
            const updatedAt = args.updated_at === undefined ? undefined : toEpoch(args.updated_at);
            const result = await runtime.memory.checkpoint({
              taskId: args.task_id,
              progress: Number(args.progress),
              updatedAt,
            });
            runtime.recordToolCall({ landed: false });
            return JSON.stringify({ ok: true, ...result, updatedAtIso: iso(result.updatedAt) });
          }),
      }),
    );

    register(
      defineTool({
        name: `${config.toolPrefix}_recall`,
        description:
          'Retrieve memories: diary blocks coarsely filter, then events are ranked by tag match, lexical overlap and ' +
          'decay x salience, with graph-neighbour association (0.5 penalty). Read-only — no adjudication, no writes. ' +
          'A hit reached only through a fading (ghost) mid returns metadata in ghostHints instead of its body — ' +
          'do not reconstruct its detail from memory; use mode="deep_raw" with the hinted time window for the verbatim ' +
          'turns. A tag holding more than 50 memories is degraded to a metadata hint (oversizedTagHints): narrow it with ' +
          'a time window / deep_raw, or repeat the recall to receive only its 3 most recent summaries. Use mode="deep_raw" ' +
          'to search the bounded raw-turn shards when episode-level detail is not enough; that ' +
          'scan has a byte/turn budget and reports truncated=true when it stops early. deep_raw on a super tag ' +
          '(>500 associations) REQUIRES start_time and end_time (MEM_E_TIME_RANGE_REQUIRED).',
        parameters: {
          text: { type: 'string', description: 'What to search for' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tag filters; empty means no tag filter' },
          top_k: { type: 'number', description: `Max hits, default ${config.retrieval.topK}, max ${config.maxRecallTopK}` },
          verbose: { type: 'boolean', description: 'Include full content instead of snippets' },
          target_space_id: {
            type: 'string',
            description: 'Optional physical space id (v1.5.0). Omit for the default space; reads never cross spaces.',
          },
          mode: {
            type: 'string',
            enum: ['auto', 'deep_raw'],
            description: 'auto (default) = indexed recall; deep_raw = bounded scan over raw turn shards',
          },
          start_time: { type: 'string', description: 'deep_raw ONLY (required): ISO 8601 / epoch ms lower bound' },
          end_time: { type: 'string', description: 'deep_raw ONLY (required): ISO 8601 / epoch ms upper bound' },
          max_tokens: { type: 'number', description: 'deep_raw only: result token budget, default from raw.maxResultTokens' },
          hash: { type: 'string', description: 'deep_raw only: restore one raw turn verbatim by sha256 (from [Slimmed] hash_…)' },
          regex: { type: 'boolean', description: 'deep_raw only: treat text as a restricted regular expression' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => toolResult(value) },
        execute: async (args = {}) =>
          stillStarting('recall', async () => {
            if (args.mode === 'deep_raw') {
              if (runtime.phase !== 'ready') return errorJson(runtime.notReady('deep_raw'));
              if (typeof args.hash === 'string' && args.hash.trim()) {
                const restored = await runtime.memory.deepRaw({ hash: args.hash.trim() });
                return JSON.stringify({ ok: true, ...restored });
              }
              // A missing window is NOT pre-validated here: the engine decides. A
              // narrow query keeps MEM_E_INVALID_INPUT, while a super tag answers
              // MEM_E_TIME_RANGE_REQUIRED (v1.5.0) — one authority, no duplicate rule.
              const limit = Math.max(1, Math.min(Number(args.top_k) || 20, config.maxRecallTopK));
              const result = await runtime.memory.deepRaw({
                text: args.text ?? '',
                startTime: args.start_time === undefined ? undefined : toEpoch(args.start_time),
                endTime: args.end_time === undefined ? undefined : toEpoch(args.end_time),
                limit,
                regex: args.regex === true,
                maxTokens: args.max_tokens,
              });
              runtime.touch();
              runtime.recordToolCall({ landed: (result.hits ?? []).length > 0 });
              return slimToolPayload(runtime, { ok: true, ...result });
            }
            const result = await runtime.recall({
              text: args.text ?? '',
              tags: args.tags ?? [],
              topK: Math.min(args.top_k ?? config.retrieval.topK, config.maxRecallTopK),
              targetSpaceId: args.target_space_id,
            });
            runtime.recordToolCall({
              landed: (result.hits ?? []).length > 0 || (result.ghostHints ?? []).length > 0,
            });
            if (runtime.phase === 'ready' && config.context.injectPrompt) {
              injectRecall(runtime, result);
            }
            return slimToolPayload(runtime, { ok: true, ...result });
          }),
      }),
    );

    register(
      defineTool({
        name: `${config.toolPrefix}_capture`,
        description:
          'Capture ONE raw turn into the forensic layer (day-sharded JSONL, never indexed). Gated by raw.mode: ' +
          'in "salience" mode only high-salience turns, code, stack traces, tool output, or force=true are kept; ' +
          'everything else returns stored=false with a reason. Size, daily, and total budgets are enforced; ' +
          'oversized turns are truncated (head+tail) rather than dropped.',
        parameters: {
          content: { type: 'string', description: 'The verbatim turn text (input or output)', required: true },
          role: { type: 'string', enum: ['user', 'assistant', 'tool'], description: 'Who produced this turn' },
          kind: { type: 'string', enum: ['chat', 'code', 'error', 'tool_output'], description: 'Content kind (drives gating)' },
          session_id: { type: 'string', description: 'Session id, for forensic grouping' },
          turn_id: { type: 'string', description: 'Stable turn id; defaults to a content hash' },
          salience: { type: 'number', description: 'Importance 0..1 (drives the salience gate)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
          ref_event_id: { type: 'string', description: 'Episode id this turn backs, if any' },
          force: { type: 'boolean', description: 'Bypass the gate (still subject to budgets)' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => toolResult(value) },
        execute: async (args = {}) =>
          stillStarting('capture', async () => {
            runtime.touch();
            const result = await runtime.memory.captureRaw({
              content: args.content,
              role: args.role,
              kind: args.kind,
              sessionId: args.session_id,
              turnId: args.turn_id,
              salience: args.salience,
              tags: args.tags,
              refEventId: args.ref_event_id,
              force: args.force === true,
            });
            runtime.recordToolCall({ landed: result.stored === true });
            return JSON.stringify({ ok: true, ...result });
          }),
      }),
    );

    register(
      defineTool({
        name: `${config.toolPrefix}_bulk_ingest`,
        description: 'Batch-ingest memories in chunks of 50 with sequential awaits (prevents OOM). Returns per-item failures instead of aborting the whole batch.',
        parameters: {
          items: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Array of remember() payloads', required: true },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => toolResult(value) },
        execute: async (args = {}) =>
          stillStarting('bulk_ingest', async () => {
            runtime.touch();
            const result = await runtime.memory.bulkIngest(args.items ?? []);
            return JSON.stringify({ ok: result.failed.length === 0, ...result });
          }),
      }),
    );

    register(
      defineTool({
        name: `${config.toolPrefix}_reinforce`,
        description:
          'Reinforce memories that proved useful. Appends a reinforce event; the decay anchor becomes its log_time ' +
          '(no stored field is mutated).',
        parameters: {
          event_ids: { type: 'array', items: { type: 'string' }, description: 'Event ids to reinforce', required: true },
          weight: { type: 'number', description: 'Positive weight, default 1' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => toolResult(value) },
        execute: async (args = {}) =>
          stillStarting('reinforce', async () => {
            runtime.touch();
            return JSON.stringify({
              ok: true,
              ...(await runtime.memory.reinforce({ eventIds: args.event_ids, weight: args.weight })),
            });
          }),
      }),
    );

    register(
      defineTool({
        name: `${config.toolPrefix}_forget`,
        description:
          'Delete memories. Two-phase by default: the event is parked in pending_delete for delete.graceHours ' +
          '(default 24h) and can be cancelled with restore; maintenance then runs the 4-phase pipeline ' +
          '(tombstone -> archive -> consolidation -> purge). High-salience facts are distilled into a semantic ' +
          'summary before their bytes are removed.',
        parameters: {
          event_ids: { type: 'array', items: { type: 'string' }, description: 'Event ids to delete', required: true },
          mode: { type: 'string', enum: ['purge', 'archive'], description: 'purge (default) or archive' },
          reason: { type: 'string', description: 'Why (kept in the tombstone and the job journal)' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => toolResult(value) },
        execute: async (args = {}) =>
          stillStarting('forget', async () => {
            runtime.touch();
            return JSON.stringify({
              ok: true,
              ...(await runtime.memory.forget({ eventIds: args.event_ids, mode: args.mode, reason: args.reason })),
            });
          }),
      }),
    );

    register(
      defineTool({
        name: `${config.toolPrefix}_space_transfer`,
        description:
          'Move or copy memories between physical spaces (v1.5.0). Safety rails are enforced by the engine, not by the ' +
          'caller: privacy-sensitive payloads (ID cards, phones, bank cards, credentials, private keys) abort the whole ' +
          'batch with MEM_E_PRIVACY_BLOCKED; raw_turn pointers are stripped; the TARGET space regenerates event ids ' +
          '(never reuses the source identity) and tags the copies transferred:from:<source>. transferMode="copy" ' +
          '(default) leaves the source untouched; transferMode="move" parks the source ids in the two-phase ' +
          'pending_delete queue AFTER every target write succeeds (cancellable with restore, never a direct physical ' +
          'delete).',
        parameters: {
          event_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Source event ids to transfer',
            required: true,
          },
          target_space_id: {
            type: 'string',
            description: 'Destination space id (created on first use); must differ from the source space',
            required: true,
          },
          transfer_mode: {
            type: 'string',
            enum: ['copy', 'move'],
            description: 'copy (default) keeps the source; move parks the source in pending_delete after success',
          },
          source_space_id: { type: 'string', description: 'Source space id; omit for the default space' },
          user_approved: {
            type: 'boolean',
            description:
              'SECURITY: only set true AFTER the user explicitly asked for this transfer in the current conversation. ' +
              'Without it the engine refuses with MEM_E_REQUIRE_USER_CONSENT. Never self-approve.',
          },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => toolResult(value) },
        execute: async (args = {}) =>
          stillStarting('space_transfer', async () => {
            runtime.touch();
            const result = await runtime.transferEvents({
              eventIds: args.event_ids,
              targetSpaceId: args.target_space_id,
              transferMode: args.transfer_mode ?? 'copy',
              sourceSpaceId: args.source_space_id,
              userApproved: args.user_approved === true,
            });
            return JSON.stringify({ ok: true, ...result });
          }),
      }),
    );

    register(
      defineTool({
        name: `${config.toolPrefix}_transfer_to_global`,
        description:
          'SECURITY-SENSITIVE (v1.5.1): copy/move memories from a space into the canonical "global" space. ' +
          'NEVER call this on your own initiative or from a "reasonable inference" — the engine refuses with ' +
          'MEM_E_REQUIRE_USER_CONSENT unless the call carries user_approved=true, which you may only set after the ' +
          'user explicitly commanded the transfer in this conversation. Same safety rails as memory_space_transfer: ' +
          'privacy screen (MEM_E_PRIVACY_BLOCKED), raw_turn stripping, fresh target event ids + transfer tags, and ' +
          'move parks the source in the two-phase pending_delete queue (never a direct physical delete).',
        parameters: {
          event_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Source event ids to send to the global space',
            required: true,
          },
          transfer_mode: {
            type: 'string',
            enum: ['copy', 'move'],
            description: 'copy (default) keeps the source; move parks the source in pending_delete after success',
          },
          source_space_id: { type: 'string', description: 'Source space id; omit for the default space' },
          user_approved: {
            type: 'boolean',
            description:
              'SECURITY: only true after explicit user instruction in this conversation; otherwise the engine blocks the call.',
          },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => toolResult(value) },
        execute: async (args = {}) =>
          stillStarting('transfer_to_global', async () => {
            runtime.touch();
            const result = await runtime.transferEvents({
              eventIds: args.event_ids,
              targetSpaceId: 'global',
              transferMode: args.transfer_mode ?? 'copy',
              sourceSpaceId: args.source_space_id,
              userApproved: args.user_approved === true,
            });
            return JSON.stringify({ ok: true, ...result });
          }),
      }),
    );

    register(
      defineTool({
        name: `${config.toolPrefix}_admin`,
        description:
          'Maintenance and observability. status = dashboard panel; maintain = run the offline job now; ' +
          'active_tags = resident active set; semantic = L3 summaries; active_task = current checkpoint ' +
          '(read straight from the index, never filtered by the active set); reset_session = escape hatch that ' +
          'clears the rollover token baseline and consumes the handoff marker when a session is wedged.',
        parameters: {
          action: {
            type: 'string',
            enum: ['status', 'maintain', 'active_tags', 'semantic', 'active_task', 'reviews', 'pending_deletes', 'reset_session'],
            description: 'What to do',
            required: true,
          },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => toolResult(value) },
        execute: async (args = {}) => {
          try {
            const action = args.action;
            if (!['status', 'maintain', 'active_tags', 'semantic', 'active_task', 'reviews', 'pending_deletes', 'reset_session'].includes(action)) {
              return errorJson(
                new MemoryError(ErrorCodes.INVALID_INPUT, `unknown admin action: ${JSON.stringify(action)}`, {
                  allowed: ['status', 'maintain', 'active_tags', 'semantic', 'active_task', 'reviews', 'pending_deletes', 'reset_session'],
                }),
              );
            }
            if (action === 'reset_session') {
              if (runtime.phase !== 'ready') return errorJson(runtime.notReady('reset_session'));
              return JSON.stringify({ ok: true, ...(await runtime.resetSessionState({ reason: 'admin_tool' })) });
            }
            if (action === 'reviews') {
              if (runtime.phase !== 'ready') return errorJson(runtime.notReady('reviews'));
              return JSON.stringify({ ok: true, reviews: runtime.memory.reviews.status({ now: runtime.memory.clock.now() }) });
            }
            if (action === 'pending_deletes') {
              if (runtime.phase !== 'ready') return errorJson(runtime.notReady('pending_deletes'));
              return JSON.stringify({ ok: true, pendingDeletes: runtime.memory.pendingDeletes.status(runtime.memory.clock.now()) });
            }
            if (action === 'active_task') {
              if (runtime.phase !== 'ready') return errorJson(runtime.notReady('active_task'));
              return JSON.stringify({ ok: true, activeTask: runtime.memory.activeTask() });
            }
            if (action === 'maintain') {
              if (runtime.phase !== 'ready') return errorJson(runtime.notReady('maintain'));
              const outcome = await runtime.runMaintenance('manual');
              if (outcome.ran === false) {
                return JSON.stringify({ ok: false, skipped: true, reason: outcome.reason, phase: runtime.phase });
              }
              const status = await runtime.memory.status();
              return JSON.stringify({
                ok: true,
                maintenance: runtime.memory.publicMaintenance(outcome.report),
                panel: status.panel,
                briefing: runtime.memory.briefing(),
              });
            }
            if (action === 'active_tags') {
              if (runtime.phase !== 'ready') return errorJson(runtime.notReady('active_tags'));
              const view = runtime.memory.indexManager.snapshot();
              const entries = (view?.activeSet?.entries ?? []).map((entry) => ({
                tag: entry.tag,
                priority: entry.priority,
                budget: entry.budget,
                events: entry.eventCount,
                decay: entry.decayScore,
              }));
              return JSON.stringify({
                ok: true,
                cap: runtime.memory.policy.activeSet.cap,
                activeTags: entries.length,
                entries,
                evicted: view?.activeSet?.evicted ?? [],
                archivedTags: view?.tags?.archived ?? [],
                pending: view?.activeSet?.pending ?? [],
              });
            }
            if (action === 'semantic') {
              if (runtime.phase !== 'ready') return errorJson(runtime.notReady('semantic'));
              const summaries = runtime.memory.semanticSummaries().map((summary) => ({
                id: summary.id,
                title: summary.title,
                confidence: summary.confidence,
                updatedAt: summary.updatedAt,
                sourceEvents: summary.sourceEvents,
              }));
              return JSON.stringify({ ok: true, summaries });
            }
            const status = await runtime.status();
            return JSON.stringify({
              ok: true,
              panel: status.panel,
              boot: status.boot,
              briefing: runtime.memory.briefing(),
              policyHash: status.policyHash,
              phase: runtime.phaseView(),
              config: uiConfig(config),
            });
          } catch (error) {
            return errorJson(error);
          }
        },
      }),
    );

    // ---- prompt surface ----------------------------------------------------
    if (config.promptSection) {
      disposers.push(
        ctx.systemPrompt.section({
          name: 'memory',
          order: 2450,
          text: () =>
            [
              `Long-term memory (tool prefix: ${config.toolPrefix}):`,
              toolLine('remember', 'store a durable fact with tags, salience and (when known) happened_at. pinned=true (needs tags) never decays and ranks first on its tag.'),
              toolLine(
                'recall',
                'search memory before asking the user to repeat themselves; mode="deep_raw" scans the bounded raw-turn shards.',
              ),
              toolLine('capture', 'keep one verbatim turn for forensics (gated; not indexed).'),
              toolLine('bulk_ingest', 'batch-ingest memories in chunks of 50 with per-item failure isolation.'),
              toolLine(
                'reinforce',
                'reward a memory that proved useful (moves its decay anchor and advances the review schedule).',
              ),
              toolLine('forget', 'two-phase delete — pending_delete countdown, then tombstone -> archive -> consolidation -> purge.'),
              toolLine('checkpoint', 'record the one active heavy task (task_id, progress, updated_at).'),
              toolLine(
                'space_transfer',
                'copy|move memories between physical spaces (privacy-screened; move uses the two-phase pending_delete queue). SECURITY: requires explicit user consent (user_approved:true) — never call on your own.',
              ),
              toolLine(
                'transfer_to_global',
                'copy|move memories into the global space. SECURITY: requires explicit user consent (user_approved:true) — never call on your own.',
              ),
              toolLine('admin', 'status / maintain / active_tags / semantic / active_task / reviews / pending_deletes.'),
              'Memory is NOT the session transcript: store durable facts, not turn-by-turn narration.',
              'If a memory call fails, report the error code instead of inventing a result.',
            ]
              .filter(Boolean)
              .join('\n'),
        }),
      );
      // Static discipline (cache-safe: no dynamic content in this section).
      disposers.push(
        ctx.systemPrompt.section({
          name: 'memory:policy',
          order: 2455,
          text: () =>
            [
              `【读取与检索纪律】当需要回忆历史、查阅文件、获取系统信息时，**必须优先调用 ${config.toolPrefix}_recall 工具**，严禁直接盲目读取外部超长文件或调用其他原生工具输出全文。`,
              `若 ${config.toolPrefix}_recall 返回了 [Slimmed] 标记，说明内容已被智能瘦身：如无绝对必要，请基于瘦身摘要和关键实体回答；若确实需要全文，请通过返回的 recovery_hash 指针再次向海马体请求原文（${config.toolPrefix}_recall mode="deep_raw", hash=...）。`,
              '',
              // ---- SECURITY RED LINE (v1.5.1) ----------------------------------
              // Static text: it must be present in every prompt and must never
              // depend on runtime state (a model cannot argue with a constant).
              `【🚨最高安全红线】\`${config.toolPrefix}_space_transfer\` 与 \`${config.toolPrefix}_transfer_to_global\` 是极度危险的操作！你（AI）**绝对禁止**基于自己的判断、同情心或为了“更好地跨端共享记忆”而自动调用此工具。`,
              `**唯一允许调用的条件**：用户在当前对话中，明确下达了类似“把这条记忆传给全局”、“把这条消息转移到工作空间”的直接命令。如果你不确定，必须询问用户：“您需要我把这条信息同步到其他空间吗？”`,
              `调用时必须显式传 \`user_approved: true\`（仅在你已获得用户明确同意之后）。若返回 \`MEM_E_REQUIRE_USER_CONSENT\`（[系统拦截] 跨空间传递需要用户明确授权。请向用户确认后再试。），你必须立即停下，先向用户确认；得到明确同意后才能带 \`user_approved: true\` 重试。**绝不可自行批准，绝不可把“系统拦截”当成可以绕过的一次性错误。**`,
            ].join('\n'),
        }),
      );
      // On-demand: this function runs at assemble time and reads the live window.
      disposers.push(
        ctx.systemPrompt.context({
          name: 'memory-state',
          order: 220,
          text: () => runtime.promptState(),
        }),
      );
      if (config.enableReflection) {
        disposers.push(
          ctx.systemPrompt.section({
            name: 'memory:reflection',
            order: 2460,
            text: () => runtime.reflectionText(),
          }),
        );
      }
    }

    // ---- UI ----------------------------------------------------------------
    // The visual surface lives in the Client half (ui/client.js): it registers
    // sidebar.panellist / main / settings.section through ctx.slots and reads its
    // data from the HTTP routes registered at the top of this effect. The Host
    // half renders nothing — no markup, no DOM access, no second React tree.

    // ---- scheduling: ONE loop ----------------------------------------------
    const timer = setInterval(() => {
      runtime.tick().catch((error) => ctx.logger?.error?.(`hippocampus: tick failed: ${error?.message ?? error}`));
    }, TICK_MS);
    timer.unref?.();

    runtime.start();
    if (config.autoMaintainOnBoot) {
      // Not awaited: boot maintenance must not delay READY, and runMaintenance
      // refuses until the phase is ready anyway.
      runtime.ready
        .then(() => runtime.runMaintenance('boot'))
        .then((outcome) => {
          if (outcome.ran) ctx.logger?.info?.('hippocampus: boot maintenance complete');
        })
        .catch((error) => ctx.logger?.warn?.(`hippocampus: boot maintenance failed: ${error?.message ?? error}`));
    }

    return () => {
      clearInterval(timer);
      for (const dispose of disposers) {
        try {
          dispose();
        } catch (error) {
          ctx.logger?.warn?.(`hippocampus: dispose failed: ${error?.message ?? error}`);
        }
      }
      runtime.stop();
      // P1-7: unsubscribe the lifecycle bridge BEFORE the bus goes away.
      try {
        runtime.hostBridge?.detach();
      } catch {
        /* already detached */
      }
    };
  });
}

/** Recall window injection: only the top blocks, only after READY. */
function injectRecall(runtime, result) {
  const { memory, config } = runtime;
  const now = memory.clock.now();
  for (const hit of (result.hits ?? []).slice(0, memory.policy.context.blockTopK)) {
    if (!hit?.eventId) continue;
    memory.context.inject({
      id: hit.eventId,
      kind: 'recall',
      text: `${hit.day ?? ''} ${hit.snippet ?? ''}`.trim(),
      salience: hit.salience,
      at: hit.eventTime,
      now,
    });
  }
  // Semantic hits are ranked summaries (`summaryId`); the older `id` alias is kept
  // for callers that normalise them. A summary without any id must be skipped, not
  // crash the whole recall: inject() refuses an undefined id.
  for (const summary of (result.semantic ?? []).slice(0, 2)) {
    const id = summary?.summaryId ?? summary?.id;
    if (!id || !summary.text) continue;
    memory.context.inject({
      id,
      kind: 'semantic',
      text: summary.text,
      salience: summary.confidence,
      at: summary.updatedAt,
      now,
    });
  }
  // Folding: what left the window is not lost. Fire-and-forget so a recall never
  // waits on a write; a failure is reported through the logger, never through the
  // recall result.
  const report = memory.context.enforce({ now });
  if (report.evicted.length > 0) {
    memory.foldEvicted(report.evicted).catch((error) => {
      runtime.logger?.warn?.(`hippocampus: fold failed: ${error?.message ?? error}`);
    });
  }
  return config;
}

async function memory_remember(runtime, args, media = {}) {
  return runtime.memory.remember({
    content: args.content,
    happenedAt: args.happened_at,
    tags: args.tags,
    salience: args.salience,
    entity: args.entity,
    meta: args.meta,
    idempotencyKey: args.idempotency_key,
    dedupe: args.dedupe,
    isTransientTrend: args.is_transient_trend,
    pinned: args.pinned === true,
    targetSpaceId: args.target_space_id,
    mediaUrl: media.mediaUrl ?? null,
    mediaType: media.mediaType ?? null,
  });
}
