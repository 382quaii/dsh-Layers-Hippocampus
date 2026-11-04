/**
 * Configuration: one schema, strict validation, fail-fast.
 *
 * Rules enforced here (and nowhere else — a second, laxer validator is how
 * "silently clamped" bugs get in):
 *
 *   - Unknown keys are rejected. A typo must not be ignored.
 *   - Deprecated keys are rejected with a migration hint, never mapped silently.
 *   - Enumerations accept only their listed values (`CONFIG_UNKNOWN_ENUM`).
 *   - Numbers are range-checked (`CONFIG_OUT_OF_RANGE`); nothing is clamped.
 *   - `maintenanceCron` must parse AND be able to fire (`CONFIG_INVALID_CRON`).
 *
 * Canonical shape is nested (`retrieval.topK`, `context.maxTokens`, `temp.ttlDays`,
 * `identity.eventTimePolicy`). Flat aliases (`retrievalTopK`, `contextMaxTokens`, …)
 * are accepted for convenience, but supplying both forms is a conflict, not a
 * precedence puzzle.
 */

import { MemoryError, ErrorCodes } from './errors.js';
import os from 'node:os';
import { validateCron } from './cron.js';

/** Deprecated key -> what replaces it. Anything here fails fast with a hint. */
export const DEPRECATED_KEYS = Object.freeze({
  maintenanceIntervalMinutes: {
    replacement: 'maintenanceCron',
    hint: 'express the interval as a 5-field cron expression, e.g. "0 */6 * * *" for every 6 hours',
  },
});

/** Flat alias -> canonical dotted path. */
export const FLAT_ALIASES = Object.freeze({
  retrievalTopK: 'retrieval.topK',
  contextMaxTokens: 'context.maxTokens',
  contextThreshold: 'context.threshold',
  contextTarget: 'context.target',
  contextInjectPrompt: 'context.injectPrompt',
  tempTtlDays: 'temp.ttlDays',
  tempPromotionWindowDays: 'temp.promotionWindowDays',
  eventTimePolicy: 'identity.eventTimePolicy',
});

export const EVENT_TIME_POLICIES = Object.freeze(['content', 'explicit', 'ingest']);
/** Raw-turn retention modes: off / gated by value / everything. */
export const RAW_MODES = Object.freeze(['off', 'salience', 'all']);

/**
 * Tool suffixes this plugin registers (`${toolPrefix}_<suffix>`). This is the
 * closed vocabulary of `tools.disabled`: a typo must fail config resolution, not
 * silently leave a tool enabled.
 */
export const TOOL_SUFFIXES = Object.freeze([
  'remember',
  'checkpoint',
  'recall',
  'capture',
  'bulk_ingest',
  'reinforce',
  'forget',
  'space_transfer',
  'transfer_to_global',
  'admin',
]);

/**
 * Tools that may NEVER be disabled: without them the memory system cannot be
 * written to, read from, or observed, so an operator could brick the plugin from
 * a config file. The UI renders them as checked+disabled with a tooltip.
 */
export const CORE_TOOL_SUFFIXES = Object.freeze(['remember', 'recall', 'admin']);

/** Every accepted top-level key (nested groups are validated separately). */
export const CONFIG_KEYS = Object.freeze([
  'dataDir',
  'migrateFrom',
  'maintenanceCron',
  'toolPrefix',
  'briefing',
  'briefingTags',
  'promptSection',
  'contactTag',
  'autoMaintainOnBoot',
  'enableDream',
  'dreamIdleMinutes',
  // Offline LLM distillation (v1.5.5). The endpoint/model/key are injected here or
  // through DSH_DREAM_LLM_* env; the plugin itself never hard-codes a credential.
  'dream',
  'enableReflection',
  'graphMaxEdges',
  'storageBudgetMb',
  'maxRecallTopK',
  'retrieval',
  'context',
  // Inverted-index physical limits (v1.5.0). Kept as their own group because they
  // bound the read model's memory footprint, not retrieval semantics.
  'index',
  'temp',
  'decay',
  'activeSet',
  'raw',
  'delete',
  'review',
  'migration',
  'tagTree',
  'identity',
  // Tool schema pruning (v1.5.3): every registered tool costs prompt tokens on
  // every turn through its JSON schema, so low-frequency tools are opt-out.
  'tools',
  // Pre-ingest tagging (v1.5.6): engine-side tag extraction for untagged writes.
  'tagging',
  // Optional capabilities (v1.5.6): the microkernel boundary. Turning these off
  // removes the space tools and makes the space/transfer routes answer
  // MEM_E_FEATURE_DISABLED instead of silently doing nothing.
  'features',
  // L2 multi-merge (v1.5.6): offline condensation of duplicate same-tag episodes.
  'l2Merge',
  'policy',
]);

export function defaultDataDir(env = process.env) {
  const home = env.DSH_HOME && String(env.DSH_HOME).trim();
  if (home) return `${home.replace(/[\\/]+$/, '')}/memory`;
  // Never return a RELATIVE path: the host's cwd is the profile directory, so
  // ".dsh/memory" silently lands inside the profile and drifts per launch. Fall
  // back to the user's home directory, which is absolute on every platform.
  return `${os.homedir().replace(/[\\/]+$/, '')}/.dsh/memory`;
}

export const DEFAULT_CONFIG = Object.freeze({
  dataDir: null, // resolved below: <DSH_HOME>/memory
  migrateFrom: null,
  maintenanceCron: '0 */6 * * *',
  toolPrefix: 'memory',
  briefing: true,
  briefingTags: [],
  promptSection: true,
  contactTag: 'context:conversation',
  autoMaintainOnBoot: true,
  enableDream: true,
  dreamIdleMinutes: 180,
  // v1.5.5: offline semantic distillation. The LLM leg is optional — when
  // `dream.llm` is not configured the engine silently uses the deterministic local
  // merge (and logs MEM_E_DREAM_LLM_FALLBACK), so Dream always completes.
  dream: Object.freeze({
    useLlm: true,
    minGroupSize: 3,
    maxGroupsPerRun: 5,
    maxSummaryChars: 200,
    maxSourceChars: 400,
    maxEventsPerGroup: 8,
    llmTimeoutMs: 15_000,
    failureThreshold: 3,
    cooldownMinutes: 60,
    // Host lifecycle compensation (P1-7): on a session start, if no Dream ran for
    // this many hours AND the price window permits, run one compensating Dream.
    compensateAfterHours: 24,
    // v1.5.6 local scheduler: LLM Dream waits for the DeepSeek low-valley window
    // (Beijing 09–12 / 14–18 are peak) instead of requiring an external price plugin.
    onlyLowValley: true,
    llm: Object.freeze({ baseUrl: null, model: null, apiKey: null }),
  }),
  enableReflection: true,
  // Edges returned by /api/memory/graph. The offline cache may hold up to
  // GRAPH_HARD_CAP; this is the read-time ceiling, so changing it is cheap.
  graphMaxEdges: 500,
  // Display threshold for the storage ring (MB). Never evicts anything.
  storageBudgetMb: 50,
  maxRecallTopK: 100,
  retrieval: Object.freeze({ topK: 20 }),
  // Tag-explosion defence (v1.5.0): a single tag may keep at most this many
  // postings in the in-memory inverted index. Older/lower-salience events are
  // dropped from the index only — the JSONL log itself is never touched.
  index: Object.freeze({ maxPostingsPerTag: 500 }),
  context: Object.freeze({
    maxTokens: 4000,
    // v1.5.6: hard ceiling on the JSON payload ONE recall may hand back. Distinct
    // from the window budget: this bounds the response itself, so a broad query
    // cannot flood the caller's context before the window engine ever sees it.
    maxInjectTokens: 4000,
    threshold: 0.85,
    target: 0.7,
    injectPrompt: true,
    // REMOVED in v1.5.3: `minInjectConfidence`. It never demonstrably saved tokens
    // (0.6 vs 0 produced byte-identical payloads) and every hit-shaping pass is a
    // permanent token tax; keeping a misleading knob is worse than having none.
    // Supplying it now fails fast (CONFIG_UNKNOWN_KEY) so no profile believes it
    // still does something.
    // Multi-space routing + session handoff (v1.5.0). Pure physical layer: no
    // permission rules here, only routing and context-window bookkeeping.
    autoSpaceFollow: false,
    autoRolloverEnabled: true,
    autoRolloverThreshold: 0.85,
    nativeTokenLimit: 8000,
    // Security (v1.5.1): moving memories across spaces is NEVER an autonomous
    // decision. While true, the engine refuses a model-initiated transfer unless
    // the tool call carries `user_approved: true`; the UI route is the human
    // channel and marks consent itself.
    requireExplicitConsentForTransfer: true,
  }),
  temp: Object.freeze({ ttlDays: 30, promotionWindowDays: 20 }),
  // Decay curve and active-set size are policy knobs, but they are also first-class
  // config: the UI edits them, so they must be declared and validated here.
  decay: Object.freeze({ halfLifeDays: 30 }),
  activeSet: Object.freeze({ cap: 200 }),
  // Raw-turn retention: gated, capped, pruned by maintenance. Off by default
  // would lose the forensic trail, so the default keeps high-value turns only.
  raw: Object.freeze({
    mode: 'salience',
    autoCapture: true,
    captureTools: false,
    // 0 = never, 0.5 = deterministic half sampling, 1 = every surface turn.
    captureRatio: 1,
    minSalience: 0.6,
    maxTurnKb: 64,
    maxBytesPerDay: 8,
    maxTotalMb: 256,
    retentionDays: 30,
    maxScanMb: 16,
    // Deep-scan turn budget. The scanner walks each shard NEWEST-FIRST, so this is
    // "how far back from the tail a single deep_raw may look" — a knob, not a
    // hard-coded constant (the old hidden 5000 made the newest turns unreachable).
    maxScanTurns: 5000,
    // Result token budget: deep_raw truncates and says so instead of flooding
    // the model's context with raw records.
    maxResultTokens: 1000,
  }),
  // Two-phase delete: forget parks the event for this long before the pipeline runs.
  delete: Object.freeze({ graceHours: 24 }),
  // Spaced repetition schedule (days between reviews).
  review: Object.freeze({ enabled: true, intervals: [1, 2, 4, 7, 15, 30] }),
  migration: Object.freeze({ timeoutMs: 600_000 }),
  // L1.5 lifecycle knobs are user-facing on purpose (charter v3.0): no silent
  // hard-coded half-lives. leafDecayFloor 0 keeps the strict forget-driven mode.
  tagTree: Object.freeze({ midHalfLifeMultiplier: 3.0, midGracePeriodDays: 30, pruneBatchSize: 100, leafDecayFloor: 0 }),
  identity: Object.freeze({ eventTimePolicy: 'content' }),
  // Tool schema pruning: each registered tool's JSON schema is paid on EVERY turn.
  // Default is "everything on" so behaviour is unchanged unless an operator opts
  // out; core tools (remember/recall/admin) can never be listed here.
  tools: Object.freeze({ disabled: [] }),
  // Pre-ingest tagging (v1.5.6): model tags win; when a write carries none, the
  // engine derives up to `maxTags` anchors from content shape (error type, errno,
  // code fence, HTTP status, file path, task statement). `autoTag:false` disables
  // the heuristic entirely (manual behaviour stays unchanged either way).
  tagging: Object.freeze({ autoTag: true, maxTags: 2 }),
  // v1.5.6 microkernel boundary. Default ON so behaviour is unchanged; turning
  // multiSpace off makes the engine a strict single-space core (targetSpaceId must
  // be "default"), and crossSpaceTransfer requires multiSpace.
  features: Object.freeze({ multiSpace: true, crossSpaceTransfer: true, crossSpaceRecall: false }),
  // v1.5.6 L2 multi-merge: condense duplicate same-tag episodes into one record,
  // pinned and ordinary groups strictly separated. Offline (maintain) only.
  l2Merge: Object.freeze({ enabled: true, minGroupSize: 2, maxGroupsPerRun: 5, maxSummaryChars: 400 }),
  policy: Object.freeze({}),
});

function configError(code, message, details) {
  return new MemoryError(code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Spaced-repetition intervals: a non-empty, strictly ascending list of whole days.
 * Sortedness is validated rather than repaired — a descending schedule is a bug.
 */
function requireIntervals(value, key) {
  if (!Array.isArray(value) || value.length === 0) {
    throw configError(ErrorCodes.CONFIG_INVALID_TYPE, `config.${key} must be a non-empty array of day counts`, {
      key,
      got: Array.isArray(value) ? 'array' : typeof value,
    });
  }
  if (value.length > 12) {
    throw configError(ErrorCodes.CONFIG_OUT_OF_RANGE, `config.${key} accepts at most 12 intervals`, { key, got: value.length });
  }
  const out = value.map((entry, index) => requireInteger(entry, `${key}[${index}]`, { min: 1, max: 365 }));
  for (let index = 1; index < out.length; index += 1) {
    if (out[index] <= out[index - 1]) {
      throw configError(ErrorCodes.CONFIG_OUT_OF_RANGE, `config.${key} must be strictly ascending`, {
        key,
        got: out,
        at: index,
      });
    }
  }
  return out;
}

function getPath(object, dotted) {
  let cursor = object;
  for (const part of dotted.split('.')) {
    if (!isPlainObject(cursor) || !(part in cursor)) return { found: false, value: undefined };
    cursor = cursor[part];
  }
  return { found: true, value: cursor };
}

function setPath(object, dotted, value) {
  const parts = dotted.split('.');
  let cursor = object;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

function requireString(value, key, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw configError(ErrorCodes.CONFIG_INVALID_TYPE, `config.${key} must be a string, got ${typeof value}`, {
      key,
      expected: 'string',
      got: typeof value,
    });
  }
  if (!allowEmpty && !value.trim()) {
    throw configError(ErrorCodes.CONFIG_OUT_OF_RANGE, `config.${key} must not be empty`, { key });
  }
  return value;
}

function requireBoolean(value, key) {
  if (typeof value !== 'boolean') {
    throw configError(ErrorCodes.CONFIG_INVALID_TYPE, `config.${key} must be a boolean, got ${typeof value}`, {
      key,
      expected: 'boolean',
      got: typeof value,
    });
  }
  return value;
}

function requireInteger(value, key, { min, max }) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw configError(ErrorCodes.CONFIG_INVALID_TYPE, `config.${key} must be an integer, got ${typeof value}`, {
      key,
      expected: 'integer',
      got: typeof value,
    });
  }
  if (value < min || value > max) {
    throw configError(ErrorCodes.CONFIG_OUT_OF_RANGE, `config.${key} must be within [${min}, ${max}], got ${value}`, {
      key,
      min,
      max,
      got: value,
    });
  }
  return value;
}

function requireNumberInRange(value, key, { min, max, exclusiveMin = false }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw configError(ErrorCodes.CONFIG_INVALID_TYPE, `config.${key} must be a finite number, got ${typeof value}`, {
      key,
      expected: 'number',
      got: typeof value,
    });
  }
  const belowMin = exclusiveMin ? value <= min : value < min;
  if (belowMin || value > max) {
    throw configError(
      ErrorCodes.CONFIG_OUT_OF_RANGE,
      `config.${key} must be within ${exclusiveMin ? '(' : '['}${min}, ${max}], got ${value}`,
      { key, min, max, got: value },
    );
  }
  return value;
}

function requireEnum(value, key, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw configError(
      ErrorCodes.CONFIG_UNKNOWN_ENUM,
      `config.${key} must be one of ${allowed.join('|')}, got ${JSON.stringify(value)}`,
      { key, allowed: [...allowed], got: value },
    );
  }
  return value;
}

function requireStringArray(value, key) {
  if (!Array.isArray(value)) {
    throw configError(ErrorCodes.CONFIG_INVALID_TYPE, `config.${key} must be an array of strings`, {
      key,
      expected: 'string[]',
    });
  }
  value.forEach((item, index) => requireString(item, `${key}[${index}]`));
  return [...value];
}

/**
 * Normalise raw config: alias expansion, unknown-key rejection, deprecated-key
 * rejection. Returns a plain object in canonical nested shape (no validation of
 * value semantics yet — that is `validateConfig`).
 */
function normaliseRaw(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isPlainObject(raw)) {
    throw configError(ErrorCodes.CONFIG_INVALID_TYPE, 'config must be an object', { got: typeof raw });
  }

  for (const key of Object.keys(raw)) {
    if (DEPRECATED_KEYS[key]) {
      const dep = DEPRECATED_KEYS[key];
      throw configError(
        ErrorCodes.CONFIG_DEPRECATED,
        `config.${key} is deprecated; use config.${dep.replacement} — ${dep.hint}`,
        { key, replacement: dep.replacement, hint: dep.hint },
      );
    }
  }

  const nested = {};
  const flat = {};
  for (const [key, value] of Object.entries(raw)) {
    if (FLAT_ALIASES[key]) flat[key] = value;
    else if (CONFIG_KEYS.includes(key)) nested[key] = value;
    else if (!key.startsWith('_')) {
      throw configError(ErrorCodes.CONFIG_UNKNOWN_KEY, `config.${key} is not a recognised key`, {
        key,
        known: [...CONFIG_KEYS, ...Object.keys(FLAT_ALIASES)],
      });
    }
  }

  const out = { ...nested };
  for (const group of ['retrieval', 'context', 'index', 'temp', 'decay', 'activeSet', 'raw', 'delete', 'review', 'migration', 'identity', 'tools', 'dream', 'tagging', 'features', 'l2Merge']) {
    if (isPlainObject(nested[group])) out[group] = { ...nested[group] };
  }
  for (const [alias, path] of Object.entries(FLAT_ALIASES)) {
    if (!(alias in flat)) continue;
    const current = getPath(out, path);
    if (current.found) {
      throw configError(
        ErrorCodes.CONFIG_CONFLICT,
        `config.${alias} and config.${path} are the same setting; keep only one`,
        { alias, canonical: path },
      );
    }
    setPath(out, path, flat[alias]);
  }
  return out;
}

/**
 * v1.5.6: multi-space is a CAPABILITY, not a config promise. It is active only when
 * the Host provides the Orchestrator service AND the profile has not turned
 * `features.multiSpace` off; otherwise the engine runs the strict single-space core.
 */
export function multiSpaceActive(config, hasOrchestrator) {
  return hasOrchestrator === true && config?.features?.multiSpace !== false;
}

/**
 * Validate and resolve. Throws `MemoryError` with a `MEM_E_CONFIG_*` code; never
 * clamps, never defaults a bad value.
 *
 * @param {object} [raw] caller/config-file values
 * @param {{env?: object}} [opts]
 */
export function resolveConfig(raw = {}, { env = process.env } = {}) {
  const input = normaliseRaw(raw);

  for (const group of ['retrieval', 'context', 'index', 'temp', 'decay', 'activeSet', 'raw', 'delete', 'review', 'migration', 'identity', 'tools', 'dream', 'tagging', 'features', 'l2Merge']) {
    if (group in input && input[group] !== undefined && !isPlainObject(input[group])) {
      throw configError(ErrorCodes.CONFIG_INVALID_TYPE, `config.${group} must be an object`, { key: group });
    }
  }

  const defaults = DEFAULT_CONFIG;
  const dataDir = input.dataDir === undefined ? defaultDataDir(env) : requireString(input.dataDir, 'dataDir');
  const migrateFrom =
    input.migrateFrom === undefined || input.migrateFrom === null
      ? null
      : requireString(input.migrateFrom, 'migrateFrom');

  const maintenanceCron = requireString(
    input.maintenanceCron === undefined ? defaults.maintenanceCron : input.maintenanceCron,
    'maintenanceCron',
  );
  // Parse + prove it can fire. The error carries MEM_E_CONFIG_INVALID_CRON.
  validateCron(maintenanceCron);

  const toolPrefix = requireString(input.toolPrefix === undefined ? defaults.toolPrefix : input.toolPrefix, 'toolPrefix');
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(toolPrefix)) {
    throw configError(
      ErrorCodes.CONFIG_OUT_OF_RANGE,
      'config.toolPrefix must match /^[a-z][a-z0-9_]{0,31}$/ (it becomes a tool-name prefix)',
      { key: 'toolPrefix', got: toolPrefix },
    );
  }

  const maxRecallTopK = requireInteger(
    input.maxRecallTopK === undefined ? defaults.maxRecallTopK : input.maxRecallTopK,
    'maxRecallTopK',
    { min: 1, max: 1000 },
  );

  const retrievalIn = input.retrieval ?? {};
  const retrievalTopK = requireInteger(
    retrievalIn.topK === undefined ? defaults.retrieval.topK : retrievalIn.topK,
    'retrieval.topK',
    { min: 1, max: 1000 },
  );
  if (retrievalTopK > maxRecallTopK) {
    throw configError(
      ErrorCodes.CONFIG_OUT_OF_RANGE,
      `config.retrieval.topK (${retrievalTopK}) must not exceed config.maxRecallTopK (${maxRecallTopK})`,
      { key: 'retrieval.topK', got: retrievalTopK, max: maxRecallTopK },
    );
  }

  const contextIn = input.context ?? {};
  const contextMaxTokens = requireInteger(
    contextIn.maxTokens === undefined ? defaults.context.maxTokens : contextIn.maxTokens,
    'context.maxTokens',
    { min: 256, max: 1_000_000 },
  );
  const contextThreshold = requireNumberInRange(
    contextIn.threshold === undefined ? defaults.context.threshold : contextIn.threshold,
    'context.threshold',
    { min: 0, max: 1, exclusiveMin: true },
  );
  // One recall's response cap (v1.5.6). Fail-fast, never clamped: a sub-256-token
  // budget would make every recall a single hit, and a >100k budget is a bug.
  const contextMaxInjectTokens = requireInteger(
    contextIn.maxInjectTokens === undefined ? defaults.context.maxInjectTokens : contextIn.maxInjectTokens,
    'context.maxInjectTokens',
    { min: 256, max: 100_000 },
  );
  const contextTarget = requireNumberInRange(
    contextIn.target === undefined ? defaults.context.target : contextIn.target,
    'context.target',
    { min: 0, max: 1 },
  );
  if (contextTarget >= contextThreshold) {
    throw configError(
      ErrorCodes.CONFIG_OUT_OF_RANGE,
      `config.context.target (${contextTarget}) must be strictly below config.context.threshold (${contextThreshold})`,
      { key: 'context.target', got: contextTarget, threshold: contextThreshold },
    );
  }
  const contextInjectPrompt =
    contextIn.injectPrompt === undefined ? defaults.context.injectPrompt : requireBoolean(contextIn.injectPrompt, 'context.injectPrompt');
  // REMOVED KEY (v1.5.3), loud on purpose: nested groups normally ignore unknown
  // keys, but silently ignoring a removed confidence knob would let a profile run
  // with a false belief about token behaviour. Fail fast with the exact path.
  if (contextIn.minInjectConfidence !== undefined) {
    throw configError(
      ErrorCodes.CONFIG_UNKNOWN_KEY,
      'config.context.minInjectConfidence was removed in v1.5.3 (it never demonstrably saved tokens); delete the key from the profile',
      { key: 'context.minInjectConfidence', removedIn: '1.5.3', replacement: null },
    );
  }
  // ---- multi-space routing + session handoff (v1.5.0) ----------------------
  const contextAutoSpaceFollow = requireBoolean(
    contextIn.autoSpaceFollow === undefined ? defaults.context.autoSpaceFollow : contextIn.autoSpaceFollow,
    'context.autoSpaceFollow',
  );
  const contextAutoRolloverEnabled = requireBoolean(
    contextIn.autoRolloverEnabled === undefined ? defaults.context.autoRolloverEnabled : contextIn.autoRolloverEnabled,
    'context.autoRolloverEnabled',
  );
  // 0.85 by default. Below 0.5 a handoff would fire on every short session; at 1.0
  // it could never fire (the native window is already exhausted), so both ends are
  // rejected instead of silently clamped.
  const contextAutoRolloverThreshold = requireNumberInRange(
    contextIn.autoRolloverThreshold === undefined ? defaults.context.autoRolloverThreshold : contextIn.autoRolloverThreshold,
    'context.autoRolloverThreshold',
    { min: 0.5, max: 0.99 },
  );
  const contextNativeTokenLimit = requireInteger(
    contextIn.nativeTokenLimit === undefined ? defaults.context.nativeTokenLimit : contextIn.nativeTokenLimit,
    'context.nativeTokenLimit',
    { min: 512, max: 1_000_000 },
  );
  // Security red line (v1.5.1): default TRUE. Only an explicit operator choice may
  // disable the consent gate; a malformed value is a config error, never "false".
  const contextRequireExplicitConsentForTransfer = requireBoolean(
    contextIn.requireExplicitConsentForTransfer === undefined
      ? defaults.context.requireExplicitConsentForTransfer
      : contextIn.requireExplicitConsentForTransfer,
    'context.requireExplicitConsentForTransfer',
  );

  // ---- inverted-index physical limits (v1.5.0) -----------------------------
  const indexIn = input.index ?? {};
  const indexMaxPostingsPerTag = requireInteger(
    indexIn.maxPostingsPerTag === undefined ? defaults.index.maxPostingsPerTag : indexIn.maxPostingsPerTag,
    'index.maxPostingsPerTag',
    { min: 1, max: 100_000 },
  );

  const tempIn = input.temp ?? {};
  const tempTtlDays = requireInteger(
    tempIn.ttlDays === undefined ? defaults.temp.ttlDays : tempIn.ttlDays,
    'temp.ttlDays',
    { min: 1, max: 3650 },
  );
  const tempPromotionWindowDays = requireInteger(
    tempIn.promotionWindowDays === undefined ? defaults.temp.promotionWindowDays : tempIn.promotionWindowDays,
    'temp.promotionWindowDays',
    { min: 0, max: 3650 },
  );
  if (tempPromotionWindowDays > tempTtlDays) {
    throw configError(
      ErrorCodes.CONFIG_OUT_OF_RANGE,
      `config.temp.promotionWindowDays (${tempPromotionWindowDays}) must not exceed config.temp.ttlDays (${tempTtlDays})`,
      { key: 'temp.promotionWindowDays', got: tempPromotionWindowDays, ttlDays: tempTtlDays },
    );
  }

  // Decay half-life and the active-set ceiling are policy values with config
  // names: one declaration, one validator, and they land in `policy` below.
  const decayIn = input.decay ?? {};
  const decayHalfLifeDays = requireInteger(
    decayIn.halfLifeDays === undefined ? defaults.decay.halfLifeDays : decayIn.halfLifeDays,
    'decay.halfLifeDays',
    { min: 7, max: 365 },
  );
  const activeSetIn = input.activeSet ?? {};
  const activeSetCap = requireInteger(
    activeSetIn.cap === undefined ? defaults.activeSet.cap : activeSetIn.cap,
    'activeSet.cap',
    { min: 100, max: 1000 },
  );

  // ---- raw-turn retention (forensic trail, gated + capped) ------------------
  const rawIn = input.raw ?? {};
  const rawMode = requireEnum(rawIn.mode ?? defaults.raw.mode, 'raw.mode', RAW_MODES);
  const rawCaptureRatio = (() => {
    const value = rawIn.captureRatio === undefined ? defaults.raw.captureRatio : Number(rawIn.captureRatio);
    if (value !== 0 && value !== 0.5 && value !== 1) {
      throw configError(ErrorCodes.CONFIG_OUT_OF_RANGE, 'config.raw.captureRatio must be 0, 0.5 or 1', {
        key: 'raw.captureRatio',
        got: rawIn.captureRatio,
      });
    }
    return value;
  })();
  const rawMinSalience = requireNumberInRange(
    rawIn.minSalience === undefined ? defaults.raw.minSalience : rawIn.minSalience,
    'raw.minSalience',
    { min: 0, max: 1 },
  );
  const rawMaxTurnKb = requireInteger(
    rawIn.maxTurnKb === undefined ? defaults.raw.maxTurnKb : rawIn.maxTurnKb,
    'raw.maxTurnKb',
    { min: 8, max: 1024 },
  );
  const rawMaxBytesPerDay = requireInteger(
    rawIn.maxBytesPerDay === undefined ? defaults.raw.maxBytesPerDay : rawIn.maxBytesPerDay,
    'raw.maxBytesPerDay',
    { min: 1, max: 128 },
  );
  const rawMaxTotalMb = requireInteger(
    rawIn.maxTotalMb === undefined ? defaults.raw.maxTotalMb : rawIn.maxTotalMb,
    'raw.maxTotalMb',
    { min: 16, max: 4096 },
  );
  const rawRetentionDays = requireInteger(
    rawIn.retentionDays === undefined ? defaults.raw.retentionDays : rawIn.retentionDays,
    'raw.retentionDays',
    { min: 1, max: 365 },
  );
  const rawMaxScanMb = requireInteger(
    rawIn.maxScanMb === undefined ? defaults.raw.maxScanMb : rawIn.maxScanMb,
    'raw.maxScanMb',
    { min: 1, max: 256 },
  );
  const rawMaxScanTurns = requireInteger(
    rawIn.maxScanTurns === undefined ? defaults.raw.maxScanTurns : rawIn.maxScanTurns,
    'raw.maxScanTurns',
    { min: 500, max: 50_000 },
  );
  const rawMaxResultTokens = requireInteger(
    rawIn.maxResultTokens === undefined ? defaults.raw.maxResultTokens : rawIn.maxResultTokens,
    'raw.maxResultTokens',
    { min: 50, max: 20_000 },
  );
  // Automatic capture: subscribe to `session/event` so every surface message is
  // offered to the raw store (still gated and budgeted per turn).
  const rawAutoCapture = requireBoolean(
    rawIn.autoCapture === undefined ? defaults.raw.autoCapture : rawIn.autoCapture,
    'raw.autoCapture',
  );
  // Tool output is the noisiest stream: off by default, opt-in per deployment.
  const rawCaptureTools = requireBoolean(
    rawIn.captureTools === undefined ? defaults.raw.captureTools : rawIn.captureTools,
    'raw.captureTools',
  );
  // ---- two-phase delete ----------------------------------------------------
  const deleteIn = input.delete ?? {};
  const deleteGraceHours = requireInteger(
    deleteIn.graceHours === undefined ? defaults.delete.graceHours : deleteIn.graceHours,
    'delete.graceHours',
    { min: 0, max: 168 },
  );

  // ---- spaced repetition ---------------------------------------------------
  const reviewIn = input.review ?? {};
  const reviewEnabled = requireBoolean(
    reviewIn.enabled === undefined ? defaults.review.enabled : reviewIn.enabled,
    'review.enabled',
  );
  const reviewIntervals = requireIntervals(
    reviewIn.intervals === undefined ? defaults.review.intervals : reviewIn.intervals,
    'review.intervals',
  );

  // ---- migration -----------------------------------------------------------
  const migrationIn = input.migration ?? {};
  const migrationTimeoutMs = requireInteger(
    migrationIn.timeoutMs === undefined ? defaults.migration.timeoutMs : migrationIn.timeoutMs,
    'migration.timeoutMs',
    { min: 10_000, max: 3_600_000 },
  );

  const treeIn = input.tagTree ?? {};
  const treeNumber = (key, fallback, min, max) => {
    const value = treeIn[key] === undefined ? fallback : Number(treeIn[key]);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw configError(ErrorCodes.CONFIG_OUT_OF_RANGE, `config.tagTree.${key} must be in [${min}, ${max}]`, {
        key: `tagTree.${key}`,
        got: treeIn[key],
        min,
        max,
      });
    }
    return value;
  };
  const tagTreeConfig = {
    midHalfLifeMultiplier: treeNumber('midHalfLifeMultiplier', defaults.tagTree.midHalfLifeMultiplier, 1, 10),
    midGracePeriodDays: treeNumber('midGracePeriodDays', defaults.tagTree.midGracePeriodDays, 7, 180),
    pruneBatchSize: treeNumber('pruneBatchSize', defaults.tagTree.pruneBatchSize, 10, 500),
    leafDecayFloor: treeNumber('leafDecayFloor', defaults.tagTree.leafDecayFloor, 0, 1),
  };

  // ---- tool schema pruning (v1.5.3) ---------------------------------------
  // Fail-fast, with NO clamping and NO silent ignore: an unknown name (typo),
  // a full prefixed name, a duplicate, or an attempt to disable a core tool all
  // abort activation with MEM_E_INVALID_TOOL_NAME. A profile is either honest or
  // it does not boot.
  const toolsIn = input.tools ?? {};
  if (!isPlainObject(toolsIn)) {
    throw configError(ErrorCodes.CONFIG_INVALID_TYPE, 'config.tools must be an object', { key: 'tools' });
  }
  const disabledIn = toolsIn.disabled === undefined ? defaults.tools.disabled : toolsIn.disabled;
  if (!Array.isArray(disabledIn)) {
    throw configError(ErrorCodes.CONFIG_INVALID_TYPE, 'config.tools.disabled must be an array of tool suffixes', {
      key: 'tools.disabled',
      expected: 'string[]',
      got: Array.isArray(disabledIn) ? 'array' : typeof disabledIn,
    });
  }
  const disabledTools = [];
  for (const [index, rawName] of disabledIn.entries()) {
    if (typeof rawName !== 'string') {
      throw configError(ErrorCodes.CONFIG_INVALID_TYPE, `config.tools.disabled[${index}] must be a string`, {
        key: `tools.disabled[${index}]`,
        got: typeof rawName,
      });
    }
    const name = rawName;
    if (!TOOL_SUFFIXES.includes(name)) {
      throw configError(
        ErrorCodes.INVALID_TOOL_NAME,
        `config.tools.disabled contains unknown tool "${name}"; use the suffix without the toolPrefix`,
        { key: 'tools.disabled', name, known: [...TOOL_SUFFIXES], hint: 'suffixes only, e.g. "capture" (not "memory_capture")' },
      );
    }
    if (CORE_TOOL_SUFFIXES.includes(name)) {
      throw configError(
        ErrorCodes.INVALID_TOOL_NAME,
        `config.tools.disabled cannot disable core tool "${name}" (remember/recall/admin are required to operate the plugin)`,
        { key: 'tools.disabled', name, reason: 'core', core: [...CORE_TOOL_SUFFIXES] },
      );
    }
    if (disabledTools.includes(name)) {
      throw configError(ErrorCodes.INVALID_TOOL_NAME, `config.tools.disabled lists "${name}" twice`, {
        key: 'tools.disabled',
        name,
        reason: 'duplicate',
      });
    }
    disabledTools.push(name);
  }
  const toolsConfig = Object.freeze({ disabled: Object.freeze([...disabledTools]) });

  // ---- pre-ingest tagging (v1.5.6) ---------------------------------------
  // Fail-fast: this changes what lands in the index, so a wrong value must abort
  // activation rather than silently disable tagging or ask for 100 tags.
  const taggingIn = input.tagging ?? {};
  if (!isPlainObject(taggingIn)) {
    throw configError(ErrorCodes.CONFIG_INVALID_TYPE, 'config.tagging must be an object', { key: 'tagging' });
  }
  const taggingAutoTag = requireBoolean(
    taggingIn.autoTag === undefined ? defaults.tagging.autoTag : taggingIn.autoTag,
    'tagging.autoTag',
  );
  const taggingMaxTags = requireInteger(
    taggingIn.maxTags === undefined ? defaults.tagging.maxTags : taggingIn.maxTags,
    'tagging.maxTags',
    { min: 1, max: 5 },
  );
  const taggingConfig = Object.freeze({ autoTag: taggingAutoTag, maxTags: taggingMaxTags });

  // ---- optional capabilities / microkernel boundary (v1.5.6) --------------
  const featuresIn = input.features ?? {};
  if (!isPlainObject(featuresIn)) {
    throw configError(ErrorCodes.CONFIG_INVALID_TYPE, 'config.features must be an object', { key: 'features' });
  }
  const featureMultiSpace = requireBoolean(
    featuresIn.multiSpace === undefined ? defaults.features.multiSpace : featuresIn.multiSpace,
    'features.multiSpace',
  );
  const featureCrossSpaceTransfer = requireBoolean(
    featuresIn.crossSpaceTransfer === undefined
      ? // Turning multi-space off implies no cross-space transfer: require the
        // operator to opt back IN explicitly, never the other way around.
        featureMultiSpace
        ? defaults.features.crossSpaceTransfer
        : false
      : featuresIn.crossSpaceTransfer,
    'features.crossSpaceTransfer',
  );
  if (featureCrossSpaceTransfer && !featureMultiSpace) {
    throw configError(
      ErrorCodes.CONFIG_OUT_OF_RANGE,
      'config.features.crossSpaceTransfer requires features.multiSpace (a single-space core has no target space)',
      { key: 'features.crossSpaceTransfer', multiSpace: false },
    );
  }
  // v1.5.6: cross-space recall aggregation is OPT-IN (and off by default): it
  // queries every open space on each recall, so an operator must ask for it.
  const featureCrossSpaceRecall = requireBoolean(
    featuresIn.crossSpaceRecall === undefined ? defaults.features.crossSpaceRecall : featuresIn.crossSpaceRecall,
    'features.crossSpaceRecall',
  );
  if (featureCrossSpaceRecall && !featureMultiSpace) {
    throw configError(
      ErrorCodes.CONFIG_OUT_OF_RANGE,
      'config.features.crossSpaceRecall requires features.multiSpace (a single-space core has only one space)',
      { key: 'features.crossSpaceRecall', multiSpace: false },
    );
  }
  const featuresConfig = Object.freeze({
    multiSpace: featureMultiSpace,
    crossSpaceTransfer: featureCrossSpaceTransfer,
    crossSpaceRecall: featureCrossSpaceRecall,
  });

  // ---- L2 multi-merge (v1.5.6) -------------------------------------------
  const l2In = input.l2Merge === undefined ? {} : input.l2Merge;
  if (!isPlainObject(l2In)) {
    throw configError(ErrorCodes.CONFIG_INVALID_TYPE, 'config.l2Merge must be an object', { key: 'l2Merge' });
  }
  const l2MergeConfig = Object.freeze({
    enabled: requireBoolean(l2In.enabled === undefined ? defaults.l2Merge.enabled : l2In.enabled, 'l2Merge.enabled'),
    minGroupSize: requireInteger(
      l2In.minGroupSize === undefined ? defaults.l2Merge.minGroupSize : l2In.minGroupSize,
      'l2Merge.minGroupSize',
      { min: 2, max: 20 },
    ),
    maxGroupsPerRun: requireInteger(
      l2In.maxGroupsPerRun === undefined ? defaults.l2Merge.maxGroupsPerRun : l2In.maxGroupsPerRun,
      'l2Merge.maxGroupsPerRun',
      { min: 1, max: 50 },
    ),
    maxSummaryChars: requireInteger(
      l2In.maxSummaryChars === undefined ? defaults.l2Merge.maxSummaryChars : l2In.maxSummaryChars,
      'l2Merge.maxSummaryChars',
      { min: 100, max: 2000 },
    ),
  });

  const policyIn = input.policy === undefined ? {} : input.policy;
  if (!isPlainObject(policyIn)) {
    throw configError(ErrorCodes.CONFIG_INVALID_TYPE, 'config.policy must be an object', { key: 'policy' });
  }
  const identityIn = input.identity ?? {};
  if (identityIn.eventTimePolicy !== undefined && policyIn.identity?.eventTimePolicy !== undefined) {
    throw configError(
      ErrorCodes.CONFIG_CONFLICT,
      'eventTimePolicy is set in both config.identity and config.policy.identity; keep only one',
      { canonical: 'identity.eventTimePolicy' },
    );
  }
  const eventTimePolicy = requireEnum(
    identityIn.eventTimePolicy ?? policyIn.identity?.eventTimePolicy ?? defaults.identity.eventTimePolicy,
    'identity.eventTimePolicy',
    EVENT_TIME_POLICIES,
  );

  const enableDream = requireBoolean(
    input.enableDream === undefined ? defaults.enableDream : input.enableDream,
    'enableDream',
  );
  // Fail-fast, never clamp: a sub-minute idle window is a config bug, not a style.
  const dreamIdleMinutes = requireNumberInRange(
    input.dreamIdleMinutes === undefined ? defaults.dreamIdleMinutes : input.dreamIdleMinutes,
    'dreamIdleMinutes',
    { min: 1, max: 525_600 },
  );

  // ---- offline Dream distillation (v1.5.5) --------------------------------
  // Every tunable is bounded and fail-fast. The LLM leg itself is OPTIONAL: an
  // unconfigured endpoint is a legal state (the engine degrades to the local merge
  // and records MEM_E_DREAM_LLM_FALLBACK), so only a malformed value is rejected.
  // Credentials live in this config (or DSH_DREAM_LLM_* env) and are never
  // hard-coded in the plugin, never logged, and never returned by the HTTP routes.
  const dreamIn = input.dream === undefined ? {} : input.dream;
  if (!isPlainObject(dreamIn)) {
    throw configError(ErrorCodes.CONFIG_INVALID_TYPE, 'config.dream must be an object', { key: 'dream' });
  }
  const dreamLlmIn = dreamIn.llm === undefined ? {} : dreamIn.llm;
  if (!isPlainObject(dreamLlmIn)) {
    throw configError(ErrorCodes.CONFIG_INVALID_TYPE, 'config.dream.llm must be an object', { key: 'dream.llm' });
  }
  const optionalString = (value, key) => {
    if (value === undefined || value === null || value === '') return null;
    return requireString(value, key);
  };
  const dreamConfig = {
    useLlm: requireBoolean(dreamIn.useLlm === undefined ? defaults.dream.useLlm : dreamIn.useLlm, 'dream.useLlm'),
    minGroupSize: requireInteger(
      dreamIn.minGroupSize === undefined ? defaults.dream.minGroupSize : dreamIn.minGroupSize,
      'dream.minGroupSize',
      { min: 2, max: 50 },
    ),
    maxGroupsPerRun: requireInteger(
      dreamIn.maxGroupsPerRun === undefined ? defaults.dream.maxGroupsPerRun : dreamIn.maxGroupsPerRun,
      'dream.maxGroupsPerRun',
      { min: 1, max: 50 },
    ),
    maxSummaryChars: requireInteger(
      dreamIn.maxSummaryChars === undefined ? defaults.dream.maxSummaryChars : dreamIn.maxSummaryChars,
      'dream.maxSummaryChars',
      { min: 40, max: 2000 },
    ),
    maxSourceChars: requireInteger(
      dreamIn.maxSourceChars === undefined ? defaults.dream.maxSourceChars : dreamIn.maxSourceChars,
      'dream.maxSourceChars',
      { min: 80, max: 4000 },
    ),
    maxEventsPerGroup: requireInteger(
      dreamIn.maxEventsPerGroup === undefined ? defaults.dream.maxEventsPerGroup : dreamIn.maxEventsPerGroup,
      'dream.maxEventsPerGroup',
      { min: 2, max: 50 },
    ),
    llmTimeoutMs: requireInteger(
      dreamIn.llmTimeoutMs === undefined ? defaults.dream.llmTimeoutMs : dreamIn.llmTimeoutMs,
      'dream.llmTimeoutMs',
      { min: 500, max: 120_000 },
    ),
    failureThreshold: requireInteger(
      dreamIn.failureThreshold === undefined ? defaults.dream.failureThreshold : dreamIn.failureThreshold,
      'dream.failureThreshold',
      { min: 1, max: 20 },
    ),
    cooldownMinutes: requireInteger(
      dreamIn.cooldownMinutes === undefined ? defaults.dream.cooldownMinutes : dreamIn.cooldownMinutes,
      'dream.cooldownMinutes',
      { min: 1, max: 1440 },
    ),
    compensateAfterHours: requireInteger(
      dreamIn.compensateAfterHours === undefined ? defaults.dream.compensateAfterHours : dreamIn.compensateAfterHours,
      'dream.compensateAfterHours',
      { min: 1, max: 720 },
    ),
    onlyLowValley: requireBoolean(
      dreamIn.onlyLowValley === undefined ? defaults.dream.onlyLowValley : dreamIn.onlyLowValley,
      'dream.onlyLowValley',
    ),
    llm: {
      baseUrl: optionalString(dreamLlmIn.baseUrl, 'dream.llm.baseUrl'),
      model: optionalString(dreamLlmIn.model, 'dream.llm.model'),
      apiKey: optionalString(dreamLlmIn.apiKey, 'dream.llm.apiKey'),
    },
  };
  const enableReflection = requireBoolean(
    input.enableReflection === undefined ? defaults.enableReflection : input.enableReflection,
    'enableReflection',
  );
  // Graph rendering budget: one integer, fail-fast, never clamped. The offline
  // cache tops out at GRAPH_HARD_CAP (2000); asking for more would be a config bug.
  const graphMaxEdges = requireInteger(
    input.graphMaxEdges === undefined ? defaults.graphMaxEdges : input.graphMaxEdges,
    'graphMaxEdges',
    { min: 100, max: 2000 },
  );
  // Ring budget: integer MB, fail-fast. The UI recomputes the ring from this
  // value, so an out-of-range number is a config bug, not something to clamp.
  const storageBudgetMb = requireInteger(
    input.storageBudgetMb === undefined ? defaults.storageBudgetMb : input.storageBudgetMb,
    'storageBudgetMb',
    { min: 10, max: 1000 },
  );

  const resolved = {
    dataDir,
    migrateFrom,
    maintenanceCron,
    toolPrefix,
    briefing: requireBoolean(input.briefing === undefined ? defaults.briefing : input.briefing, 'briefing'),
    briefingTags: requireStringArray(input.briefingTags === undefined ? defaults.briefingTags : input.briefingTags, 'briefingTags'),
    promptSection: requireBoolean(input.promptSection === undefined ? defaults.promptSection : input.promptSection, 'promptSection'),
    contactTag: requireString(input.contactTag === undefined ? defaults.contactTag : input.contactTag, 'contactTag'),
    autoMaintainOnBoot: requireBoolean(
      input.autoMaintainOnBoot === undefined ? defaults.autoMaintainOnBoot : input.autoMaintainOnBoot,
      'autoMaintainOnBoot',
    ),
    enableDream,
    dreamIdleMinutes,
    dream: dreamConfig,
    enableReflection,
    graphMaxEdges,
    storageBudgetMb,
    maxRecallTopK,
    retrieval: { topK: retrievalTopK },
    index: { maxPostingsPerTag: indexMaxPostingsPerTag },
    context: {
      maxTokens: contextMaxTokens,
      maxInjectTokens: contextMaxInjectTokens,
      threshold: contextThreshold,
      target: contextTarget,
      injectPrompt: contextInjectPrompt,
      // v1.5.0 routing knobs below; v1.5.3 removed minInjectConfidence entirely.
      autoSpaceFollow: contextAutoSpaceFollow,
      autoRolloverEnabled: contextAutoRolloverEnabled,
      autoRolloverThreshold: contextAutoRolloverThreshold,
      nativeTokenLimit: contextNativeTokenLimit,
      requireExplicitConsentForTransfer: contextRequireExplicitConsentForTransfer,
    },
    temp: { ttlDays: tempTtlDays, promotionWindowDays: tempPromotionWindowDays },
    decay: { halfLifeDays: decayHalfLifeDays },
    activeSet: { cap: activeSetCap },
    raw: {
      mode: rawMode,
      autoCapture: rawAutoCapture,
      captureTools: rawCaptureTools,
      captureRatio: rawCaptureRatio,
      minSalience: rawMinSalience,
      maxTurnKb: rawMaxTurnKb,
      maxBytesPerDay: rawMaxBytesPerDay,
      maxTotalMb: rawMaxTotalMb,
      retentionDays: rawRetentionDays,
      maxScanMb: rawMaxScanMb,
      maxScanTurns: rawMaxScanTurns,
      maxResultTokens: rawMaxResultTokens,
    },
    delete: { graceHours: deleteGraceHours },
    review: { enabled: reviewEnabled, intervals: reviewIntervals },
    migration: { timeoutMs: migrationTimeoutMs },
    tagTree: tagTreeConfig,
    identity: { eventTimePolicy },
    tools: toolsConfig,
    tagging: taggingConfig,
    features: featuresConfig,
    l2Merge: l2MergeConfig,
    policy: policyIn,
  };
  return resolved;
}

/**
 * Config + policy projection that `Memory` consumes. Keeping this in one place is
 * what stops the config namespace and the policy namespace from drifting apart:
 * every override has exactly one home below.
 */
export function toMemoryOptions(config) {
  const policy = { ...config.policy };
  policy.identity = { ...(policy.identity ?? {}), eventTimePolicy: config.identity.eventTimePolicy };
  policy.temp = { ...(policy.temp ?? {}), ttlDays: config.temp.ttlDays, promotionWindowDays: config.temp.promotionWindowDays };
  policy.decay = { ...(policy.decay ?? {}), halfLifeDays: config.decay.halfLifeDays };
  policy.activeSet = { ...(policy.activeSet ?? {}), cap: config.activeSet.cap };
  // Two-phase delete + review schedule are policy values with config names.
  policy.delete = { ...(policy.delete ?? {}), graceHours: config.delete.graceHours };
  policy.review = { ...(policy.review ?? {}), enabled: config.review.enabled, intervals: config.review.intervals };
  return {
    dataDir: config.dataDir,
    policy,
    config: {
      context: config.context,
      index: config.index,
      maintenanceCron: config.maintenanceCron,
      temp: config.temp,
      identity: config.identity,
      graphMaxEdges: config.graphMaxEdges,
      raw: config.raw,
      delete: config.delete,
      review: config.review,
      migration: config.migration,
      tagTree: config.tagTree,
      // v1.5.5: Dream options are engine config, not policy. The llm block can hold
      // an injected credential; it is never projected into the HTTP/UI config.
      dream: config.dream,
      // v1.5.6: pre-ingest tagging knobs (read at the write gate).
      tagging: config.tagging,
      // v1.5.6: capability flags gate the space tools/routes at their use sites.
      features: config.features,
      // v1.5.6: L2 multi-merge tunables (offline maintain phase).
      l2Merge: config.l2Merge,
    },
  };
}
