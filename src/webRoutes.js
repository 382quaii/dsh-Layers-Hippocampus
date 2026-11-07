/**
 * HTTP surface for the memory panel.
 *
 * The client half (`ui/client.js`) runs in the browser and cannot call agent
 * tools, so the panel talks to these two routes instead. They are thin: every
 * number comes from `runtime.uiPayload()` — the exact same call
 * `memory_admin action=status` uses — so the panel and the tool can never
 * disagree.
 *
 *   GET  /api/hippocampus/stats    -> { ok, phase, panel, briefing, config }
 *   GET  /api/hippocampus/config   -> { ok, config }
 *   POST /api/hippocampus/config   -> { ok, config, persisted, note? }
 *   GET  /api/hippocampus/graph    -> { ok, graph, tagTree }
 *   POST /api/hippocampus/retry    -> { ok, ... }
 *   POST /api/hippocampus/transfer -> { ok, ...transferResult }
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
  transfer: '/api/hippocampus/transfer',
  // Per-memory projection for the panel's human-initiated 分享/转移 button.
  memories: '/api/hippocampus/memories',
  // Global SpaceSelector: list/create the physical spaces the UI may switch to.
  spaces: '/api/hippocampus/spaces',
  // Escape hatch (v1.5.4): clear a wedged rollover/handoff state from the UI.
  sessionReset: '/api/hippocampus/session/reset',
  // Settings-page button: install the GitHub Orchestrator through the Host manager.
  orchestratorInstall: '/api/hippocampus/orchestrator/install',
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
  // v1.5.6: one recall's response cap (JSON payload handed to the caller).
  'context.maxInjectTokens',
  'context.threshold',
  'context.target',
  'context.injectPrompt',
  // REMOVED v1.5.3: 'context.minInjectConfidence' (dead token knob). It is no
  // longer editable — the config validator rejects it loudly on profile load.
  // v1.5.0 multi-space routing + session handoff. Pure physical layer: these
  // only move data between spaces and track the native context window.
  'context.autoSpaceFollow',
  'context.autoRolloverEnabled',
  'context.autoRolloverThreshold',
  'context.nativeTokenLimit',
  // Security red line (v1.5.1): the operator decides whether model-initiated
  // cross-space transfer needs an explicit per-call user approval. Default true.
  'context.requireExplicitConsentForTransfer',
  'index.maxPostingsPerTag',
  // Tool schema pruning (v1.5.3): array of suffixes; the engine validates names
  // fail-fast (core tools are rejected), the UI renders a checkbox catalog.
  'tools.disabled',
  // Pre-ingest tagging (v1.5.6): engine-side anchors for untagged writes.
  'tagging.autoTag',
  'tagging.maxTags',
  // v1.5.6 capability flags: switching these off removes the space tools and makes
  // the space/transfer routes answer MEM_E_FEATURE_DISABLED.
  'features.multiSpace',
  'features.crossSpaceTransfer',
  'features.crossSpaceRecall',
  // v1.5.6: client half may open a fresh conversation when a handoff turns active.
  'context.autoNewSession',
  'context.autoNewSessionPoll',
  'context.autoNewSessionIntervalSeconds',
  // v1.6.0 cold-start injection switches (independent; default summary on, turns off).
  'context.coldStartInjectSummary',
  'context.coldStartInjectRecentTurns',
  // v1.5.6 L2 multi-merge tunables (offline maintain phase).
  'l2Merge.enabled',
  'l2Merge.minGroupSize',
  'l2Merge.maxGroupsPerRun',
  'l2Merge.maxSummaryChars',
  // v1.5.6 offline Dream tunables. CREDENTIALS ARE NOT EDITABLE: `dream.llm.*`
  // (baseUrl/model/apiKey) stays in the profile / DSH_DREAM_LLM_* env.
  'dream.useLlm',
  'dream.minGroupSize',
  'dream.maxGroupsPerRun',
  'dream.maxSummaryChars',
  'dream.maxSourceChars',
  'dream.maxEventsPerGroup',
  'dream.llmTimeoutMs',
  'dream.failureThreshold',
  'dream.cooldownMinutes',
  'dream.compensateAfterHours',
  'dream.onlyLowValley',
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
  'raw.archiveAfterDays',
  'raw.maxScanMb',
  'raw.maxScanTurns',
  'raw.maxResultTokens',
  'raw.captureRatio',
  'delete.graceHours',
  'review.enabled',
  // L1.5 tag-tree lifecycle. Rebuildable derived state, so a change is applied by
  // the next maintenance pass, never by rewriting anything on the request path.
  'tagTree.midHalfLifeMultiplier',
  'tagTree.midGracePeriodDays',
  'tagTree.pruneBatchSize',
  'tagTree.leafDecayFloor',
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
 * Transfer body -> the exact shape `runtime.transferEvents()` expects.
 *
 * The wire uses snake_case (`event_ids`, `target_space_id`, `transfer_mode`,
 * `source_space_id`) because this is also the agent-tool boundary; inside the
 * plugin it is camelCase. Validation is deliberately strict: an empty id list or
 * an unknown mode is a 400 with MEM_E_INVALID_INPUT, never a silent no-op, so a
 * UI that renders "已转移" always corresponds to a real engine call.
 */
function normaliseTransferInput(body) {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const input = raw.patch ?? raw;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidInput('transfer body must be an object', { got: input === null ? 'null' : typeof input });
  }

  if (!Array.isArray(input.event_ids) || input.event_ids.length === 0) {
    throw invalidInput('event_ids must be a non-empty array of event ids', { field: 'event_ids' });
  }
  const eventIds = input.event_ids.map((id) => (typeof id === 'string' ? id.trim() : ''));
  if (eventIds.some((id) => id === '')) {
    throw invalidInput('event_ids must contain only non-empty strings', { field: 'event_ids' });
  }

  if (typeof input.target_space_id !== 'string' || input.target_space_id.trim() === '') {
    throw invalidInput('target_space_id must be a non-empty string', { field: 'target_space_id' });
  }

  // Default is the safe one: a copy never removes anything from the source space.
  const transferMode = input.transfer_mode === undefined || input.transfer_mode === null ? 'copy' : input.transfer_mode;
  if (transferMode !== 'copy' && transferMode !== 'move') {
    throw invalidInput("transfer_mode must be 'copy' or 'move'", { field: 'transfer_mode', got: transferMode });
  }

  let sourceSpaceId;
  if (input.source_space_id !== undefined && input.source_space_id !== null) {
    if (typeof input.source_space_id !== 'string' || input.source_space_id.trim() === '') {
      throw invalidInput('source_space_id must be a non-empty string when provided', { field: 'source_space_id' });
    }
    sourceSpaceId = input.source_space_id.trim();
  }

  return {
    eventIds,
    targetSpaceId: input.target_space_id.trim(),
    transferMode,
    sourceSpaceId,
    // SECURITY (v1.5.2): the browser must state the human approval explicitly.
    // A request that omits it is refused by the ENGINE gate
    // (MEM_E_REQUIRE_USER_CONSENT), exactly like the agent tool path. The HTTP
    // route is not a consent-granting master key.
    userApproved: input.user_approved === true,
  };
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

  /**
   * The SpaceSelector routing hook: every read route accepts `?space=<id>` and the
   * runtime resolves it to that physical store. A missing/blank value means the
   * default space (single-space behaviour stays byte-identical).
   */
  const requestedSpace = (req) => {
    try {
      const value = new URL(String(req.url ?? '/'), 'http://localhost').searchParams.get('space');
      return value && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  };

  const statsHandler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendState(res, 405, runtime, { ok: false, error: { code: 'MEM_E_INVALID_INPUT', message: 'use GET' } });
      return;
    }
    try {
      const payload = await runtime.uiPayload(requestedSpace(req));
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
      const view = await runtime.graphPayload(requestedSpace(req));
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

  // Recent memories: bounded read-only projection. This is what the panel's
  // per-memory detail rows render before the human clicks 分享/转移. No writes, no
  // log scan: `Memory.recentMemories` sorts the live index snapshot.
  const memoriesHandler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendState(res, 405, runtime, { ok: false, error: { code: 'MEM_E_INVALID_INPUT', message: 'use GET' } });
      return;
    }
    try {
      const url = new URL(String(req.url ?? MEMORY_API.memories), 'http://localhost');
      const limitRaw = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.round(limitRaw), 200) : 20;
      const space = url.searchParams.get('space') || undefined;
      if (stateOf(runtime) !== 'ready') {
        sendState(res, 503, runtime, { ok: false, error: asMemoryError(runtime.notReady('memories')).toJSON() });
        return;
      }
      const result = await runtime.recentMemories({ limit, targetSpaceId: space });
      sendState(res, 200, runtime, { ok: true, ...result });
    } catch (error) {
      log(`memories failed: ${error?.message ?? error}`);
      fail(res, 400, error, runtime);
    }
  };

  // Global SpaceSelector data source. GET lists every physical space (root router);
  // POST creates a NEW empty space (201). A missing route is exactly what produced
  // `MEM_E_SPACES: HTTP 404` in the field (new client bundle + old host process):
  // the stats payload now carries `capabilities.spaces`, so the client checks the
  // handshake BEFORE calling this route and degrades with human-readable copy if
  // the host is stale.
  const spacesHandler = async (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      sendState(res, 200, runtime, {
        ok: true,
        spaces: runtime.spaceList(),
        defaultSpaceId: 'default',
        capabilities: runtime.capabilities?.() ?? null,
      });
      return;
    }
    if (req.method !== 'POST') {
      sendState(res, 405, runtime, { ok: false, error: { code: 'MEM_E_INVALID_INPUT', message: 'use GET or POST' } });
      return;
    }
    try {
      if (stateOf(runtime) !== 'ready') {
        sendState(res, 409, runtime, { ok: false, error: asMemoryError(runtime.notReady('spaces')).toJSON() });
        return;
      }
      const body = await readJsonBody(req);
      const raw = body && typeof body === 'object' ? (body.patch ?? body) : {};
      const spaceId = typeof raw.space_id === 'string' ? raw.space_id : typeof raw.spaceId === 'string' ? raw.spaceId : '';
      // Actions are an explicit enum: an unknown action must NEVER fall through to
      // CREATE (that is exactly how a delete request on an old host answered
      // "空间已存在"). Fail fast instead.
      const action = typeof raw.action === 'string' && raw.action.length > 0 ? raw.action : 'create';
      if (action !== 'create' && action !== 'delete') {
        throw new MemoryError(ErrorCodes.INVALID_INPUT, `unknown spaces action: ${action}`, {
          action,
          hint: 'use "create" or "delete"',
        });
      }
      // v1.5.6: the same route carries deletion (`action:'delete'`). It is
      // destructive, so the engine itself refuses without `confirm:true` and the
      // UI only sends it after the human confirm dialog.
      if (action === 'delete') {
        const result = await runtime.deleteSpace(spaceId, { confirm: raw.confirm === true });
        sendState(res, 200, runtime, {
          ok: true,
          spaceId: result.spaceId,
          deleted: true,
          spaces: result.spaces.ids,
          capabilities: runtime.capabilities?.() ?? null,
        });
        return;
      }
      // The strict validator lives in the ENGINE (validateNewSpaceId): malformed /
      // reserved / existing ids throw MEM_E_SPACE_INVALID and land in the catch as
      // a clean 400 — nothing is written, no raw FS error is exposed.
      const result = await runtime.createSpace(spaceId);
      sendState(res, 201, runtime, {
        ok: true,
        spaceId: result.spaceId,
        created: result.created === true,
        spaces: result.spaces.ids,
        capabilities: runtime.capabilities?.() ?? null,
      });
    } catch (error) {
      log(`spaces failed: ${error?.message ?? error}`);
      fail(res, 400, error, runtime);
    }
  };

  // Transfer: copy/move events between spaces. The runtime owns the engine
  // (privacy screen, fresh target ids, two-phase pending-delete queue for move);
  // this handler only normalises the wire shape and maps every failure to 400.
  //
  // SECURITY (v1.5.2): the route FORWARDS the browser's explicit user_approved
  // flag; it does NOT fabricate consent. A request that skips the UI's second
  // confirmation (no `user_approved:true`) hits the same engine gate as an agent
  // tool call and answers MEM_E_REQUIRE_USER_CONSENT. The agent half cannot reach
  // HTTP routes at all, so "bottom API bypasses the UI" is blocked twice.
  const transferHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendState(res, 405, runtime, { ok: false, error: { code: 'MEM_E_INVALID_INPUT', message: 'use POST' } });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const payload = normaliseTransferInput(body);
      const result = await runtime.transferEvents(payload);
      sendState(res, 200, runtime, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
    } catch (error) {
      log(`transfer failed: ${error?.message ?? error}`);
      fail(res, 400, error, runtime);
    }
  };

  // Escape hatch (v1.5.4): a user whose session is wedged by a handoff can POST
  // here (settings page button) to clear the token baseline, in-flight guard and
  // marker. It touches only state/, never durable memories.
  const sessionResetHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendState(res, 405, runtime, { ok: false, error: { code: 'MEM_E_INVALID_INPUT', message: 'use POST' } });
      return;
    }
    try {
      if (stateOf(runtime) !== 'ready') {
        sendState(res, 409, runtime, { ok: false, error: asMemoryError(runtime.notReady('reset_session')).toJSON() });
        return;
      }
      let reason = 'ui_escape_hatch';
      try {
        const body = await readJsonBody(req);
        if (body && typeof body.reason === 'string' && body.reason.trim()) reason = body.reason.trim().slice(0, 120);
      } catch {
        /* an empty/invalid body still resets: this is the recovery path */
      }
      const result = await runtime.resetSessionState({ reason });
      sendState(res, 200, runtime, { ok: true, ...result });
    } catch (error) {
      log(`session reset failed: ${error?.message ?? error}`);
      fail(res, 500, error, runtime);
    }
  };

  const orchestratorInstallHandler = async (req, res) => {
    if (req.method !== 'POST') {
      sendState(res, 405, runtime, { ok: false, error: { code: 'MEM_E_INVALID_INPUT', message: 'use POST' } });
      return;
    }
    try {
      if (stateOf(runtime) !== 'ready') {
        sendState(res, 409, runtime, { ok: false, error: asMemoryError(runtime.notReady('install_orchestrator')).toJSON() });
        return;
      }
      let body = {};
      try {
        body = (await readJsonBody(req)) ?? {};
      } catch {
        body = {};
      }
      if (!body || body.confirm !== true) {
        sendState(res, 400, runtime, {
          ok: false,
          error: {
            code: 'MEM_E_INVALID_INPUT',
            message: 'installing dsh-orchestrator mutates the profile; send {confirm:true} after the user confirms',
          },
        });
        return;
      }
      const result = await runtime.installOrchestrator({ confirm: true, repo: typeof body.repo === 'string' ? body.repo : undefined });
      const status = result.ok || result.state === 'already-installed' ? 200 : result.state === 'manual' ? 501 : 400;
      // `state` is the runtime phase in every payload; keep the install verdict in
      // its own field instead of overwriting it.
      sendState(res, status, runtime, { ...result, installState: result.state });
    } catch (error) {
      log(`orchestrator install failed: ${error?.message ?? error}`);
      fail(res, 400, error, runtime);
    }
  };

  return [
    { kind: 'exact', path: MEMORY_API.stats, handler: statsHandler },
    { kind: 'exact', path: MEMORY_API.config, handler: configHandler },
    { kind: 'exact', path: MEMORY_API.graph, handler: graphHandler },
    { kind: 'exact', path: MEMORY_API.retry, handler: retryHandler },
    { kind: 'exact', path: MEMORY_API.transfer, handler: transferHandler },
    { kind: 'exact', path: MEMORY_API.memories, handler: memoriesHandler },
    { kind: 'exact', path: MEMORY_API.spaces, handler: spacesHandler },
    { kind: 'exact', path: MEMORY_API.sessionReset, handler: sessionResetHandler },
    { kind: 'exact', path: MEMORY_API.orchestratorInstall, handler: orchestratorInstallHandler },
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
