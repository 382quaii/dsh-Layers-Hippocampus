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

import { resolveConfig, toMemoryOptions, DEFAULT_CONFIG } from './src/config.js';
import { migrateDataDir } from './src/migration.js';
import { CronScheduler } from './src/scheduler.js';
import { asMemoryError, ErrorCodes, MemoryError } from './src/errors.js';
import { Memory } from './src/memory.js';
import { MEMORY_API, registerMemoryRoutes } from './src/webRoutes.js';

export const name = 'memory';
export const inject = ['tools', 'systemPrompt'];

/** Re-exported so the client bundle and tests share one route table. */
export { MEMORY_API };
/** Re-exported so tests and the README point at one schema. */
export { resolveConfig, DEFAULT_CONFIG };

/**
 * Runtime handles by context. Deliberately a WeakMap instead of `ctx.memory`:
 * naming that property collides with the `memory` service provided by another
 * plugin in this profile, and cordis rejects the bare assignment. Nothing outside
 * this module may depend on the handle — it exists for tests and the `apply` scope.
 */
const RUNTIMES = new WeakMap();

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
export function defineTool(definition) {
  return { ...definition, parameters: compileParameters(definition.parameters) };
}

/**
 * The startup state machine + the single maintenance gate. Kept in this file
 * because it owns the plugin's lifecycle contracts; the store itself is src/.
 */
export function createRuntime({ ctx = null, config, options, clock, raw = null }) {
  // `let` (not const): a failed bootstrap can be retried by rebuilding the facade.
  let memory = new Memory({ dataDir: config.dataDir, policy: options.policy, config: options.config, clock });

  const listeners = new Set();
  const runtime = {
    config,
    memory,
    /** Raw (unresolved) config: re-merging a patch must not bake in defaults. */
    rawConfig: cloneRaw(raw ?? config),
    phase: 'pending',
    phaseError: null,
    readyAt: null,
    legacy: null,
    maintenanceInFlight: false,
    maintenanceSource: null,
    lastActiveAt: clock ? clock.now() : Date.now(),
    toolCalls: 0,
    reflectionActive: false,
    started: false,
    stopped: false,
    retrying: false,
  };

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
      error: runtime.phaseError ? asMemoryError(runtime.phaseError).toJSON() : null,
      hint: 'retry once startup completes; memory_admin/status reports phase during startup',
    });

  runtime.touch = () => {
    runtime.lastActiveAt = runtime.memory.clock.now();
  };

  /** Called by every tool: keeps the dream idle clock honest. */
  runtime.recordToolCall = ({ landed = false } = {}) => {
    runtime.touch();
    runtime.toolCalls += 1;
    if (landed) runtime.toolCalls = 0;
    const active = config.enableReflection && runtime.toolCalls >= REFLECTION_THRESHOLD;
    if (active !== runtime.reflectionActive) {
      runtime.reflectionActive = active;
      emit({ type: 'reflection', active });
    }
  };

  runtime.reflectionText = () => (runtime.reflectionActive ? REFLECTION_TEXT : '');

  /**
   * Prompt text, built on demand from the live window. Before READY it states the
   * phase instead of pretending memory is empty.
   */
  runtime.promptState = () => {
    if (runtime.phase === 'ready') return memory.briefing();
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
    if (config.enableDream && runtime.phase === 'ready' && !runtime.maintenanceInFlight) {
      const idleMs = runtime.lastActiveAt === null ? Infinity : now - runtime.lastActiveAt;
      if (idleMs >= config.dreamIdleMinutes * 60_000) {
        results.push(await runtime.runMaintenance('dream'));
      }
    }
    return results;
  };

  /**
   * Reads during startup. A migration has a source of truth that is still valid:
   * the legacy directory. Serving from it beats both an empty answer and a stall.
   */
  runtime.recall = async (query) => {
    if (runtime.phase === 'ready') {
      runtime.recordToolCall();
      return memory.recall(query);
    }
    if (runtime.legacy) {
      runtime.recordToolCall();
      const result = await runtime.legacy.recall(query);
      return { ...result, readFrom: 'legacy', note: `startup phase=${runtime.phase}; served from ${config.migrateFrom}` };
    }
    throw runtime.notReady('recall');
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
        getCronExpression: () => config.maintenanceCron,
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
    ready: runtime.phase === 'ready',
    readyAt: runtime.readyAt,
    error: runtime.phaseError ? asMemoryError(runtime.phaseError).toJSON() : null,
    maintenanceInFlight: runtime.maintenanceInFlight,
    maintenanceSource: runtime.maintenanceSource,
  });

  /** UI cards read exactly this: one source of truth (no panel-specific math). */
  runtime.uiPayload = async () => {
    const view = runtime.phaseView();
    if (runtime.phase !== 'ready') return { ok: false, ...view };
    try {
      const status = await memory.status();
      return { ok: true, ...view, panel: status.panel, briefing: memory.briefing(), config: uiConfig(config) };
    } catch (error) {
      return { ok: false, ...view, error: asMemoryError(error).toJSON() };
    }
  };

  /**
   * Graph route payload. The cache is rebuilt by maintenance, so this is a slice
   * plus the phase: no sorting, no disk walk, no log scan on the request path.
   */
  runtime.graphPayload = async () => {
    const view = runtime.phaseView();
    if (runtime.phase !== 'ready') {
      return { ok: false, ...view, graph: { available: false, nodes: [], edges: [], totalEdges: 0, limit: runtime.config.graphMaxEdges } };
    }
    try {
      return { ok: true, phase: runtime.phase, graph: runtime.memory.graphView(runtime.config.graphMaxEdges) };
    } catch (error) {
      return { ok: false, ...view, error: asMemoryError(error).toJSON(), graph: { available: false, nodes: [], edges: [], limit: runtime.config.graphMaxEdges } };
    }
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
    const engine = runtime.memory.context;
    if (engine) {
      engine.maxTokensOverride = next.context.maxTokens;
      engine.thresholdOverride = next.context.threshold;
      engine.targetOverride = next.context.target;
    }
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
    memory = new Memory({ dataDir: config.dataDir, policy: options.policy, config: options.config, clock });
    runtime.memory = memory;
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

function uiConfig(config) {
  return {
    dataDir: config.dataDir,
    maintenanceCron: config.maintenanceCron,
    eventTimePolicy: config.identity.eventTimePolicy,
    retrievalTopK: config.retrieval.topK,
    context: config.context,
    temp: config.temp,
    enableDream: config.enableDream,
    dreamIdleMinutes: config.dreamIdleMinutes,
    enableReflection: config.enableReflection,
    graphMaxEdges: config.graphMaxEdges,
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
    const register = (definition) => {
      disposers.push(ctx.tools.register(definition));
    };
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
        },
        output: { schema: { type: 'string' }, render: (_args, value) => toolResult(value) },
        execute: async (args = {}) =>
          stillStarting('remember', async () => {
            runtime.touch();
            const result = await memory_remember(runtime, args);
            runtime.recordToolCall({ landed: result.status === 'appended' });
            return JSON.stringify({ ok: true, ...result, eventTimeIso: iso(result.eventTime) });
          }),
      }),
    );

    register(
      defineTool({
        name: `${config.toolPrefix}_recall`,
        description:
          'Retrieve memories: diary blocks coarsely filter, then events are ranked by tag match, lexical overlap and ' +
          'decay x salience. Read-only — no adjudication, no writes. An empty active set degrades to the most recent ' +
          'diary blocks and reports mode="degraded" with a reason.',
        parameters: {
          text: { type: 'string', description: 'What to search for' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tag filters; empty means no tag filter' },
          top_k: { type: 'number', description: `Max hits, default ${config.retrieval.topK}, max ${config.maxRecallTopK}` },
          verbose: { type: 'boolean', description: 'Include full content instead of snippets' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => toolResult(value) },
        execute: async (args = {}) =>
          stillStarting('recall', async () => {
            const result = await runtime.recall({
              text: args.text ?? '',
              tags: args.tags ?? [],
              topK: Math.min(args.top_k ?? config.retrieval.topK, config.maxRecallTopK),
            });
            runtime.recordToolCall({ landed: (result.hits ?? []).length > 0 });
            if (runtime.phase === 'ready' && config.context.injectPrompt) {
              injectRecall(runtime, result);
            }
            return JSON.stringify({ ok: true, ...result });
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
          'Delete memories through the 4-phase pipeline (tombstone -> archive -> consolidation -> purge). ' +
          'High-salience facts are distilled into a semantic summary before their bytes are removed; ' +
          'the pattern outlives the episode.',
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
        name: `${config.toolPrefix}_admin`,
        description:
          'Maintenance and observability. status = dashboard panel; maintain = run the offline job now; ' +
          'active_tags = resident active set; semantic = L3 summaries.',
        parameters: {
          action: {
            type: 'string',
            enum: ['status', 'maintain', 'active_tags', 'semantic'],
            description: 'What to do',
            required: true,
          },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => toolResult(value) },
        execute: async (args = {}) => {
          try {
            const action = args.action;
            if (!['status', 'maintain', 'active_tags', 'semantic'].includes(action)) {
              return errorJson(
                new MemoryError(ErrorCodes.INVALID_INPUT, `unknown admin action: ${JSON.stringify(action)}`, {
                  allowed: ['status', 'maintain', 'active_tags', 'semantic'],
                }),
              );
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
              `- ${config.toolPrefix}_remember: store a durable fact with tags, salience and (when known) happened_at.`,
              `- ${config.toolPrefix}_recall: search memory before asking the user to repeat themselves.`,
              `- ${config.toolPrefix}_reinforce: reward a memory that proved useful (moves its decay anchor).`,
              `- ${config.toolPrefix}_forget: delete through tombstone -> archive -> consolidation -> purge.`,
              `- ${config.toolPrefix}_admin: status / maintain / active_tags / semantic.`,
              'Memory is NOT the session transcript: store durable facts, not turn-by-turn narration.',
              'If a memory call fails, report the error code instead of inventing a result.',
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
    // data from the HTTP routes below. The Host half renders nothing — no markup,
    // no DOM access, no second React tree.

    // ---- HTTP surface for the client half (ui/client.js) --------------------
    // The browser cannot call agent tools, so the panel reads/writes through
    // these two routes. Persistence goes through configEditor (the Loader's own
    // write path); when it is unavailable the change is live-only and reported.
    const editor = ctx.get?.('configEditor') ?? null;
    const persistConfig = async (patch) => {
      if (!editor || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
        return { persisted: false, note: 'configEditor unavailable: the change applies until restart' };
      }
      const entries = editor.entries() ?? [];
      const entry =
        entries.find((candidate) => (candidate?.options?.name ?? candidate?.name) === '@local/dsh-memory') ??
        entries.find((candidate) => (candidate?.options?.id ?? candidate?.id) === 'memory');
      if (!entry) {
        return { persisted: false, note: 'profile row not found: the change applies until restart' };
      }
      await editor.edit(entry, (current) => mergeRaw(cloneRaw(current), patch));
      return { persisted: true };
    };

    const routes = registerMemoryRoutes(ctx, { runtime, persist: persistConfig, logger: ctx.logger });
    if (routes.registered) {
      disposers.push(routes.dispose);
      ctx.logger?.info?.(`hippocampus: http routes ${routes.paths.join(', ')}`);
    } else {
      ctx.logger?.warn?.(`hippocampus: http routes not registered (${routes.reason})`);
    }

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
    };
  });
}

/** Recall window injection: only the top blocks, only after READY. */
function injectRecall(runtime, result) {
  const { memory, config } = runtime;
  const now = memory.clock.now();
  for (const hit of (result.hits ?? []).slice(0, memory.policy.context.blockTopK)) {
    memory.context.inject({
      id: hit.eventId,
      kind: 'recall',
      text: `${hit.day ?? ''} ${hit.snippet ?? ''}`.trim(),
      salience: hit.salience,
      at: hit.eventTime,
      now,
    });
  }
  for (const summary of (result.semantic ?? []).slice(0, 2)) {
    memory.context.inject({
      id: summary.id,
      kind: 'semantic',
      text: summary.text,
      salience: summary.confidence,
      at: summary.updatedAt,
      now,
    });
  }
  memory.context.enforce({ now });
  return config;
}

async function memory_remember(runtime, args) {
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
  });
}
