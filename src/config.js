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
  'enableReflection',
  'graphMaxEdges',
  'storageBudgetMb',
  'maxRecallTopK',
  'retrieval',
  'context',
  'temp',
  'decay',
  'activeSet',
  'raw',
  'delete',
  'review',
  'migration',
  'identity',
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
  enableReflection: true,
  // Edges returned by /api/memory/graph. The offline cache may hold up to
  // GRAPH_HARD_CAP; this is the read-time ceiling, so changing it is cheap.
  graphMaxEdges: 500,
  // Display threshold for the storage ring (MB). Never evicts anything.
  storageBudgetMb: 50,
  maxRecallTopK: 100,
  retrieval: Object.freeze({ topK: 20 }),
  context: Object.freeze({ maxTokens: 4000, threshold: 0.85, target: 0.7, injectPrompt: true }),
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
    minSalience: 0.6,
    maxTurnKb: 64,
    maxBytesPerDay: 8,
    maxTotalMb: 256,
    retentionDays: 30,
    maxScanMb: 16,
    // Result token budget: deep_raw truncates and says so instead of flooding
    // the model's context with raw records.
    maxResultTokens: 1000,
  }),
  // Two-phase delete: forget parks the event for this long before the pipeline runs.
  delete: Object.freeze({ graceHours: 24 }),
  // Spaced repetition schedule (days between reviews).
  review: Object.freeze({ enabled: true, intervals: [1, 2, 4, 7, 15, 30] }),
  migration: Object.freeze({ timeoutMs: 600_000 }),
  identity: Object.freeze({ eventTimePolicy: 'content' }),
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
  for (const group of ['retrieval', 'context', 'temp', 'decay', 'activeSet', 'raw', 'delete', 'review', 'migration', 'identity']) {
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
 * Validate and resolve. Throws `MemoryError` with a `MEM_E_CONFIG_*` code; never
 * clamps, never defaults a bad value.
 *
 * @param {object} [raw] caller/config-file values
 * @param {{env?: object}} [opts]
 */
export function resolveConfig(raw = {}, { env = process.env } = {}) {
  const input = normaliseRaw(raw);

  for (const group of ['retrieval', 'context', 'temp', 'decay', 'activeSet', 'raw', 'delete', 'review', 'migration', 'identity']) {
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
    enableReflection,
    graphMaxEdges,
    storageBudgetMb,
    maxRecallTopK,
    retrieval: { topK: retrievalTopK },
    context: {
      maxTokens: contextMaxTokens,
      threshold: contextThreshold,
      target: contextTarget,
      injectPrompt: contextInjectPrompt,
    },
    temp: { ttlDays: tempTtlDays, promotionWindowDays: tempPromotionWindowDays },
    decay: { halfLifeDays: decayHalfLifeDays },
    activeSet: { cap: activeSetCap },
    raw: {
      mode: rawMode,
      autoCapture: rawAutoCapture,
      captureTools: rawCaptureTools,
      minSalience: rawMinSalience,
      maxTurnKb: rawMaxTurnKb,
      maxBytesPerDay: rawMaxBytesPerDay,
      maxTotalMb: rawMaxTotalMb,
      retentionDays: rawRetentionDays,
      maxScanMb: rawMaxScanMb,
      maxResultTokens: rawMaxResultTokens,
    },
    delete: { graceHours: deleteGraceHours },
    review: { enabled: reviewEnabled, intervals: reviewIntervals },
    migration: { timeoutMs: migrationTimeoutMs },
    identity: { eventTimePolicy },
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
      maintenanceCron: config.maintenanceCron,
      temp: config.temp,
      identity: config.identity,
      graphMaxEdges: config.graphMaxEdges,
      raw: config.raw,
      delete: config.delete,
      review: config.review,
      migration: config.migration,
    },
  };
}
