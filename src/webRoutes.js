/**
 * HTTP surface for the memory panel.
 *
 * The client half (`ui/client.js`) runs in the browser and cannot call agent
 * tools, so the panel talks to these two routes instead. They are thin: every
 * number comes from `runtime.uiPayload()` — the exact same call
 * `memory_admin action=status` uses — so the panel and the tool can never
 * disagree.
 *
 *   GET  /api/memory/stats   -> { ok, phase, panel, briefing, config }
 *   GET  /api/memory/config  -> { ok, config }
 *   POST /api/memory/config  -> { ok, config, persisted, note? }
 *
 * Contract notes:
 *   - Not ready is a `503`, not a `200` with zeros: the UI must be able to tell
 *     "migrating" from "empty".
 *   - A rejected write keeps the previous config and answers `400` with the
 *     MEM_E_CONFIG_* code from resolveConfig's fail-fast validation.
 *   - No per-route auth: the routes are same-origin inside the local web UI and
 *     expose nothing a signed-in user of that UI could not already read from
 *     `memory_admin`.
 */

import { ErrorCodes, MemoryError, asMemoryError, invalidInput } from './errors.js';

export const MEMORY_API = Object.freeze({
  stats: '/api/hippocampus/stats',
  config: '/api/hippocampus/config',
  graph: '/api/hippocampus/graph',
  retry: '/api/hippocampus/retry',
});

/** Only these keys may change over HTTP; anything else is rejected, not dropped. */
export const EDITABLE_CONFIG_KEYS = Object.freeze([
  'dataDir',
  'maintenanceCron',
  'briefing',
  'promptSection',
  'autoMaintainOnBoot',
  'enableDream',
  'enableReflection',
  'dreamIdleMinutes',
  'graphMaxEdges',
  'storageBudgetMb',
  'maxRecallTopK',
  'retrieval.topK',
  'context.maxTokens',
  'context.threshold',
  'context.target',
  'context.injectPrompt',
  'temp.ttlDays',
  'temp.promotionWindowDays',
  'decay.halfLifeDays',
  'activeSet.cap',
  'raw.mode',
  'raw.autoCapture',
  'raw.captureTools',
  'raw.minSalience',
  'raw.maxTurnKb',
  'raw.maxBytesPerDay',
  'raw.maxTotalMb',
  'raw.retentionDays',
  'raw.maxScanMb',
  'raw.maxResultTokens',
  'delete.graceHours',
  'review.enabled',
  'identity.eventTimePolicy',
]);

const MAX_BODY_BYTES = 16 * 1024;
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
});

/**
 * Write a dotted path into a nested patch. Depth is arbitrary, but the caller has
 * already checked the path against EDITABLE_CONFIG_KEYS, so no path can invent a
 * group (`identity.eventTimePolicy` and `retrieval.topK` both need this).
 */
function nestPatch(target, dotted, value) {
  const parts = String(dotted).split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
  return target;
}

/**
 * Reject unknown keys instead of filtering them: a UI that sends `ttlDays`
 * instead of `temp.ttlDays` must get an error, otherwise the toggle silently
 * appears to work while nothing changes.
 */
export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw configError('patch must be an object', { got: patch === null ? 'null' : typeof patch });
  }
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === '_') continue;
    if (!EDITABLE_CONFIG_KEYS.includes(key)) {
      throw configError(`config key "${key}" is not editable over HTTP`, {
        key,
        editable: EDITABLE_CONFIG_KEYS,
      });
    }
    nestPatch(out, key, value);
  }
  return out;
}

function configError(message, details) {
  return new MemoryError(ErrorCodes.CONFIG_UNKNOWN_KEY, message, details);
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw invalidInput(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw invalidInput('request body is not valid JSON');
  }
}

/**
 * The one field the UI branches on. Every response carries it — including 400,
 * 405, 409 and 500 — so a client never has to infer the engine's state from an
 * HTTP status code. A bare 404 (route not mounted yet, or a stale bundle calling
 * an old prefix) has no body and is treated as `pending` by the client, with a
 * long window; that is the only case the protocol cannot carry a state.
 */
export function stateOf(runtime) {
  const phase = runtime?.phase;
  return phase === 'in_progress' || phase === 'ready' || phase === 'failed' || phase === 'migrating' ? phase : 'pending';
}

function sendState(res, status, runtime, body) {
  const state = stateOf(runtime);
  sendJson(res, status, { ...body, state, phase: state });
}

function fail(res, status, error, runtime) {
  sendState(res, status, runtime, { ok: false, error: asMemoryError(error).toJSON() });
}

/**
 * @param {object} options
 * @param {object} options.runtime        createRuntime() result
 * @param {Function|null} options.persist async (patch) => {persisted, note?}
 * @param {object|null} options.logger    optional ctx.logger
 * @returns {Array<{kind:'exact', path:string, handler:Function}>}
 */
export function createMemoryRoutes({ runtime, persist = null, logger = null }) {
  const log = (message) => {
    try {
      logger?.warn?.(`hippocampus: ${message}`);
    } catch {
      // A failing logger must not fail the request.
    }
  };

  const statsHandler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendState(res, 405, runtime, { ok: false, error: { code: 'MEM_E_INVALID_INPUT', message: 'use GET' } });
      return;
    }
    try {
      const payload = await runtime.uiPayload();
      sendState(res, payload.ok ? 200 : 503, runtime, payload);
    } catch (error) {
      log(`stats failed: ${error?.message ?? error}`);
      fail(res, 500, error, runtime);
    }
  };

  const configHandler = async (req, res) => {
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        // Reads are always allowed: the form must be fillable while the store
        // is still loading (otherwise the settings page would be blank on boot).
        sendState(res, 200, runtime, { ok: true, config: runtime.uiConfig() });
        return;
      }
      if (req.method !== 'POST') {
        sendState(res, 405, runtime, { ok: false, error: { code: 'MEM_E_INVALID_INPUT', message: 'use GET or POST' } });
        return;
      }
      // WRITE ISOLATION: a config write before READY is rejected loudly, never
      // swallowed — the runtime cannot apply it to a store that is not open.
      if (stateOf(runtime) !== 'ready') {
        const state = stateOf(runtime);
        sendState(res, 409, runtime, {
          ok: false,
          error: {
            code: ErrorCodes.NOT_READY,
            message: `memory is not ready (state=${state}); config write rejected, retry after READY`,
            details: { state, retryable: state !== 'failed', operation: 'config-write' },
          },
        });
        return;
      }
      const body = await readJsonBody(req);
      const patch = validatePatch(body.patch ?? body);
      // dataDir is not a live config value: it starts a background migration and
      // returns 202 immediately. The request never waits on the copy.
      if (patch.dataDir !== undefined) {
        if (Object.keys(patch).length !== 1) {
          sendState(res, 400, runtime, {
            ok: false,
            error: {
              code: ErrorCodes.INVALID_INPUT,
              message: 'dataDir must be migrated on its own: send only { dataDir } in this request',
            },
          });
          return;
        }
        const descriptor = runtime.startMigration(patch.dataDir);
        sendState(res, 202, runtime, { ok: true, migration: descriptor, state: 'migrating' });
        return;
      }
      const next = await runtime.updateConfig(patch);
      let persisted = { persisted: false, note: 'config applied for this process only' };
      if (persist) {
        try {
          persisted = await persist(patch);
        } catch (error) {
          // The live config already changed; persistence failure is reported,
          // never rolled back silently, so the UI can show a warning.
          log(`config persist failed: ${error?.message ?? error}`);
          persisted = { persisted: false, note: asMemoryError(error).message };
        }
      }
      sendState(res, 200, runtime, { ok: true, config: runtime.uiConfig(), ...persisted, applied: next });
    } catch (error) {
      fail(res, 400, error, runtime);
    }
  };

  // Graph: cached projection, sliced to config.graphMaxEdges. The handler does
  // no sorting and touches no log — `view()` is a slice of an in-memory array.
  const graphHandler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendState(res, 405, runtime, { ok: false, error: { code: 'MEM_E_INVALID_INPUT', message: 'use GET' } });
      return;
    }
    try {
      const view = await runtime.graphPayload();
      sendState(res, view.ok ? 200 : 503, runtime, view);
    } catch (error) {
      log(`graph failed: ${error?.message ?? error}`);
      fail(res, 500, error, runtime);
    }
  };

  // Retry: only meaningful while the phase is `failed`; the runtime owns the
  // state machine, so this handler never starts a second bootstrap by itself.
  const retryHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendState(res, 405, runtime, { ok: false, error: { code: 'MEM_E_INVALID_INPUT', message: 'use POST' } });
      return;
    }
    try {
      const result = await runtime.retry();
      sendState(res, result.ok ? 202 : 409, runtime, result);
    } catch (error) {
      log(`retry failed: ${error?.message ?? error}`);
      fail(res, 500, error, runtime);
    }
  };

  return [
    { kind: 'exact', path: MEMORY_API.stats, handler: statsHandler },
    { kind: 'exact', path: MEMORY_API.config, handler: configHandler },
    { kind: 'exact', path: MEMORY_API.graph, handler: graphHandler },
    { kind: 'exact', path: MEMORY_API.retry, handler: retryHandler },
  ];
}

/** Registers the routes on the host web server; returns a disposer. */
export function registerMemoryRoutes(ctx, options) {
  const webServer = ctx?.get?.('webServer') ?? ctx?.webServer ?? null;
  if (!webServer || typeof webServer.register !== 'function') {
    return { registered: false, reason: 'webServer service unavailable', paths: [] };
  }
  const disposers = [];
  const routes = createMemoryRoutes(options);
  for (const route of routes) {
    disposers.push(webServer.register(route));
  }
  return {
    registered: true,
    paths: routes.map((route) => route.path),
    dispose: () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // Already disposed by the host; disposal must stay idempotent.
        }
      }
    },
  };
}
