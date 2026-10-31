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
import { resolveConfig, toMemoryOptions, DEFAULT_CONFIG } from './src/config.js';
import { migrateDataDir } from './src/migration.js';
import { MigrationRunner } from './src/migrationRunner.js';
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

/** Must match package.json — the Loader row and the client module id use it too. */
const PACKAGE_NAME = 'dsh-layers-hippocampus';

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
    toolCalls: 0,
    reflectionActive: false,
    started: false,
    stopped: false,
    retrying: false,
    /** Last UI-triggered migration snapshot (state/migration.json), if any. */
    migration: null,
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

  /** UI cards read exactly this: one source of truth (no panel-specific math). */
  runtime.uiPayload = async () => {
    const view = runtime.phaseView();
    if (runtime.phase !== 'ready') {
      // Migration is a first-class state: the panel needs its progress even
      // though the store is offline for writes.
      return { ok: false, ...view, migration: runtime.migrationStatus() };
    }
    try {
      const status = await memory.status();
      return {
        ok: true,
        ...view,
        panel: { ...status.panel, migration: runtime.migrationStatus() },
        briefing: memory.briefing(),
        config: uiConfig(runtime.config),
      };
    } catch (error) {
      return { ok: false, ...view, error: asMemoryError(error).toJSON(), migration: runtime.migrationStatus() };
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
      return { ok: true, phase: runtime.phase, state: runtime.phase, graph: runtime.memory.graphView(runtime.config.graphMaxEdges) };
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
    const engine = runtime.memory?.context;
    if (engine) {
      engine.maxTokensOverride = next.context.maxTokens;
      engine.thresholdOverride = next.context.threshold;
      engine.targetOverride = next.context.target;
    }
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
    memory = new Memory({ dataDir: next.dataDir, policy: nextOptions.policy, config: nextOptions.config, clock });
    runtime.memory = memory;
    runtime.config = next;
    runtime.rawConfig = merged;
    await memory.init();
    if (runtime.scheduler) memory.attachScheduler(runtime.scheduler);
    runtime.migration = job;
    runtime.phase = 'ready';
    runtime.readyAt = memory.clock.now();
    emit({ type: 'migration', migration: job });
    emit({ type: 'ready', at: runtime.readyAt, migratedTo: job.to });
    return job;
  };

  runtime.migrationStatus = () => {
    const latest = migrationRunner.read();
    if (latest) runtime.migration = latest;
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
    context: config.context,
    temp: config.temp,
    decay: config.decay,
    activeSet: config.activeSet,
    raw: config.raw,
    delete: config.delete,
    review: config.review,
    migration: config.migration,
    identity: { eventTimePolicy: config.identity.eventTimePolicy },
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

    const register = (definition) => {
      disposers.push(ctx.tools.register(definition));
    };

    // ---- automatic raw capture: every surface message, verbatim ------------
    // `dsh-session` publishes `session/event` as (session, event). Subscribing at
    // the root context is what reaches sessions created by the agent's fiber; the
    // raw store's own gating/budgets still decide what lands on disk.
    const captureListener = (session, event) => {
      if (!runtime.memory || runtime.phase !== 'ready') return;
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
          'Use mode="deep_raw" to search the bounded raw-turn shards when episode-level detail is not enough; that ' +
          'scan has a byte/turn budget and reports truncated=true when it stops early.',
        parameters: {
          text: { type: 'string', description: 'What to search for' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tag filters; empty means no tag filter' },
          top_k: { type: 'number', description: `Max hits, default ${config.retrieval.topK}, max ${config.maxRecallTopK}` },
          verbose: { type: 'boolean', description: 'Include full content instead of snippets' },
          mode: {
            type: 'string',
            enum: ['auto', 'deep_raw'],
            description: 'auto (default) = indexed recall; deep_raw = bounded scan over raw turn shards',
          },
          start_time: { type: 'string', description: 'deep_raw ONLY (required): ISO 8601 / epoch ms lower bound' },
          end_time: { type: 'string', description: 'deep_raw ONLY (required): ISO 8601 / epoch ms upper bound' },
          max_tokens: { type: 'number', description: 'deep_raw only: result token budget, default from raw.maxResultTokens' },
          regex: { type: 'boolean', description: 'deep_raw only: treat text as a restricted regular expression' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => toolResult(value) },
        execute: async (args = {}) =>
          stillStarting('recall', async () => {
            if (args.mode === 'deep_raw') {
              if (runtime.phase !== 'ready') return errorJson(runtime.notReady('deep_raw'));
              if (args.start_time === undefined || args.end_time === undefined) {
                return errorJson(
                  new MemoryError(
                    ErrorCodes.INVALID_INPUT,
                    'deep_raw requires start_time and end_time (fail-fast: an unbounded raw scan is not allowed)',
                    { missing: ['start_time', 'end_time'].filter((key) => args[key] === undefined) },
                  ),
                );
              }
              const limit = Math.max(1, Math.min(Number(args.top_k) || 20, config.maxRecallTopK));
              const result = await runtime.memory.deepRaw({
                text: args.text ?? '',
                startTime: toEpoch(args.start_time),
                endTime: toEpoch(args.end_time),
                limit,
                regex: args.regex === true,
                maxTokens: args.max_tokens,
              });
              runtime.touch();
              runtime.recordToolCall({ landed: (result.hits ?? []).length > 0 });
              return JSON.stringify({ ok: true, ...result });
            }
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
        name: `${config.toolPrefix}_admin`,
        description:
          'Maintenance and observability. status = dashboard panel; maintain = run the offline job now; ' +
          'active_tags = resident active set; semantic = L3 summaries; active_task = current checkpoint ' +
          '(read straight from the index, never filtered by the active set).',
        parameters: {
          action: {
            type: 'string',
            enum: ['status', 'maintain', 'active_tags', 'semantic', 'active_task', 'reviews', 'pending_deletes'],
            description: 'What to do',
            required: true,
          },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => toolResult(value) },
        execute: async (args = {}) => {
          try {
            const action = args.action;
            if (!['status', 'maintain', 'active_tags', 'semantic', 'active_task', 'reviews', 'pending_deletes'].includes(action)) {
              return errorJson(
                new MemoryError(ErrorCodes.INVALID_INPUT, `unknown admin action: ${JSON.stringify(action)}`, {
                  allowed: ['status', 'maintain', 'active_tags', 'semantic', 'active_task', 'reviews', 'pending_deletes'],
                }),
              );
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
              `- ${config.toolPrefix}_remember: store a durable fact with tags, salience and (when known) happened_at.`,
              `- ${config.toolPrefix}_recall: search memory before asking the user to repeat themselves; mode="deep_raw" scans the bounded raw-turn shards.`,
              `- ${config.toolPrefix}_capture: keep one verbatim turn for forensics (gated; not indexed).`,
              `- ${config.toolPrefix}_reinforce: reward a memory that proved useful (moves its decay anchor and advances the review schedule).`,
              `- ${config.toolPrefix}_forget: two-phase delete — pending_delete countdown, then tombstone -> archive -> consolidation -> purge.`,
              `- ${config.toolPrefix}_checkpoint: record the one active heavy task (task_id, progress, updated_at).`,
              `- ${config.toolPrefix}_admin: status / maintain / active_tags / semantic / active_task / reviews / pending_deletes.`,
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
    mediaUrl: media.mediaUrl ?? null,
    mediaType: media.mediaType ?? null,
  });
}
