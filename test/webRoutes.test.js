/**
 * HTTP surface for the UI (GET stats / GET+POST config).
 *
 * These tests drive the handlers with Node streams, no server: the contract that
 * matters is "what JSON, what status code, and did the runtime see the patch".
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  EDITABLE_CONFIG_KEYS,
  MEMORY_API,
  createMemoryRoutes,
  registerMemoryRoutes,
  validatePatch,
} from '../src/webRoutes.js';

const PANEL = {
  global: { events: 3, activeTags: 2, semanticSummaries: 1, tempQuarantined: 0 },
  tokens: { contextTokens: 12, contextMaxTokens: 4000, evictedBlocks: 1, cumulativeSavedTokens: 340 },
  storage: { dataDir: 'C:/tmp/memory', diskBytes: 4096 },
  maintenance: { lastSuccessAt: 1, nextRunAt: 2, maintenanceCron: '0 */6 * * *', running: false, queuedDeletes: 0 },
  generations: { logGen: 'gen-000001', indexGen: 'gen-000001' },
};

function fakeRuntime(overrides = {}) {
  const calls = { updateConfig: [], uiPayload: 0 };
  let config = {
    dataDir: 'C:/tmp/memory',
    maintenanceCron: '0 */6 * * *',
    enableDream: true,
    dreamIdleMinutes: 180,
    enableReflection: true,
    context: { maxTokens: 4000, threshold: 0.85, target: 0.7, injectPrompt: true },
    temp: { ttlDays: 30, promotionWindowDays: 20 },
  };
  const runtime = {
    phase: 'ready',
    async uiPayload() {
      calls.uiPayload += 1;
      return {
        ok: true,
        phase: 'ready',
        ready: true,
        panel: PANEL,
        briefing: 'Memory gen=gen-000001 events=3',
        config,
      };
    },
    uiConfig: () => config,
    async updateConfig(patch) {
      calls.updateConfig.push(patch);
      config = { ...config, ...patch, context: { ...config.context, ...(patch.context ?? {}) } };
      return config;
    },
    ...overrides,
  };
  return { runtime, calls, getConfig: () => config };
}

function fakeRequest({ method = 'GET', url = '/', body = null } = {}) {
  const chunks = body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const stream = Readable.from(chunks);
  stream.method = method;
  stream.url = url;
  stream.headers = { host: '127.0.0.1' };
  return stream;
}

function fakeResponse() {
  const state = { status: 0, headers: null, text: '' };
  return {
    state,
    json: () => JSON.parse(state.text),
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers ?? null;
      return this;
    },
    end(text = '') {
      state.text = text;
      return this;
    },
  };
}

async function call(routes, path, request) {
  const route = routes.find((candidate) => candidate.path === path);
  assert.ok(route, `route ${path} is registered`);
  const res = fakeResponse();
  await route.handler(request, res);
  return res;
}

test('GET stats returns the panel, the briefing and the writable config', async () => {
  const { runtime, calls } = fakeRuntime();
  const routes = createMemoryRoutes({ runtime });
  const res = await call(routes, MEMORY_API.stats, fakeRequest({ method: 'GET', url: MEMORY_API.stats }));

  assert.equal(res.state.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.phase, 'ready');
  assert.deepEqual(body.panel, PANEL);
  assert.equal(body.config.context.maxTokens, 4000);
  assert.equal(calls.uiPayload, 1, 'the route does not re-derive numbers');
});

test('GET stats reports the startup phase with 503 instead of pretending empty', async () => {
  const { runtime } = fakeRuntime({
    phase: 'in_progress',
    async uiPayload() {
      return { ok: false, phase: 'in_progress', ready: false, maintenanceInFlight: false };
    },
  });
  const routes = createMemoryRoutes({ runtime });
  const res = await call(routes, MEMORY_API.stats, fakeRequest());
  assert.equal(res.state.status, 503);
  assert.equal(res.json().phase, 'in_progress');
  assert.equal(res.json().panel, undefined, 'no zero-filled panel while starting');
});

test('GET config exposes only the editable shape', async () => {
  const { runtime } = fakeRuntime();
  const routes = createMemoryRoutes({ runtime });
  const res = await call(routes, MEMORY_API.config, fakeRequest({ method: 'GET' }));
  assert.equal(res.state.status, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().config.dreamIdleMinutes, 180);
});

test('POST config applies the patch, reports persistence and returns the new config', async () => {
  const { runtime, calls, getConfig } = fakeRuntime();
  const persisted = [];
  const routes = createMemoryRoutes({
    runtime,
    persist: async (patch) => {
      persisted.push(patch);
      return { persisted: true };
    },
  });
  const res = await call(
    routes,
    MEMORY_API.config,
    fakeRequest({
      method: 'POST',
      body: { patch: { enableDream: false, 'context.maxTokens': 2048, 'temp.ttlDays': 14 } },
    }),
  );

  assert.equal(res.state.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.persisted, true);
  assert.equal(body.config.enableDream, false);
  assert.equal(calls.updateConfig.length, 1);
  assert.deepEqual(calls.updateConfig[0], { enableDream: false, context: { maxTokens: 2048 }, temp: { ttlDays: 14 } });
  assert.equal(getConfig().context.maxTokens, 2048);
  assert.equal(persisted.length, 1, 'persistence sees the same patch');
});

test('POST config keeps the change live and warns when persistence is unavailable', async () => {
  const { runtime } = fakeRuntime();
  const routes = createMemoryRoutes({
    runtime,
    persist: async () => ({ persisted: false, note: 'configEditor unavailable' }),
  });
  const res = await call(routes, MEMORY_API.config, fakeRequest({ method: 'POST', body: { patch: { enableReflection: false } } }));
  assert.equal(res.state.status, 200);
  assert.equal(res.json().persisted, false);
  assert.match(res.json().note, /configEditor/);
});

test('POST config rejects unknown keys before touching the runtime', async () => {
  const { runtime, calls } = fakeRuntime();
  const routes = createMemoryRoutes({ runtime });
  const res = await call(routes, MEMORY_API.config, fakeRequest({ method: 'POST', body: { patch: { ttlDays: 5 } } }));
  assert.equal(res.state.status, 400);
  assert.equal(res.json().ok, false);
  assert.equal(res.json().error.code, 'MEM_E_CONFIG_UNKNOWN_KEY');
  assert.equal(res.json().error.details.key, 'ttlDays');
  assert.equal(calls.updateConfig.length, 0);
});

test('a validation failure from resolveConfig is a 400 with the MEM_E_CONFIG code', async () => {
  const { runtime } = fakeRuntime({
    async updateConfig() {
      const error = new Error('config.dreamIdleMinutes is out of range');
      error.code = 'MEM_E_CONFIG_OUT_OF_RANGE';
      throw error;
    },
  });
  const routes = createMemoryRoutes({ runtime });
  const res = await call(routes, MEMORY_API.config, fakeRequest({ method: 'POST', body: { patch: { dreamIdleMinutes: 0 } } }));
  assert.equal(res.state.status, 400);
  assert.equal(res.json().error.code, 'MEM_E_CONFIG_OUT_OF_RANGE');
});

test('non-GET/POST methods answer 405 and malformed JSON answers 400', async () => {
  const { runtime } = fakeRuntime();
  const routes = createMemoryRoutes({ runtime });
  const put = await call(routes, MEMORY_API.config, fakeRequest({ method: 'PUT' }));
  assert.equal(put.state.status, 405);

  const bad = await call(routes, MEMORY_API.config, fakeRequest({ method: 'POST', body: '{not json' }));
  assert.equal(bad.state.status, 400);
  assert.equal(bad.json().error.code, 'MEM_E_INVALID_INPUT');
});

test('validatePatch rejects non-objects and accepts only the editable set', () => {
  assert.throws(() => validatePatch(null), /patch must be an object/);
  assert.throws(() => validatePatch([1, 2]), /patch must be an object/);
  const accepted = validatePatch(Object.fromEntries(EDITABLE_CONFIG_KEYS.map((key, index) => [key, index])));
  assert.deepEqual(Object.keys(accepted).sort(), [
    'activeSet',
    'autoMaintainOnBoot',
    'briefing',
    'context',
    'dataDir',
    'decay',
    'delete',
    'dreamIdleMinutes',
    'enableDream',
    'enableReflection',
    'graphMaxEdges',
    'identity',
    'maintenanceCron',
    'maxRecallTopK',
    'promptSection',
    'raw',
    'retrieval',
    'review',
    'storageBudgetMb',
    'temp',
  ]);
});

test('dotted patches nest at any depth and reject unknown groups', () => {
  assert.deepEqual(validatePatch({ 'identity.eventTimePolicy': 'explicit' }), { identity: { eventTimePolicy: 'explicit' } });
  assert.deepEqual(validatePatch({ 'retrieval.topK': 12 }), { retrieval: { topK: 12 } });
  assert.deepEqual(validatePatch({ 'context.maxTokens': 8000, 'temp.ttlDays': 7 }), {
    context: { maxTokens: 8000 },
    temp: { ttlDays: 7 },
  });
  assert.throws(() => validatePatch({ 'policy.decay.floor': 0.1 }), /not editable/);
  assert.throws(() => validatePatch({ 'context.nope': 1 }), /not editable/);
});

test('registerMemoryRoutes registers the full route table and disposes it, or reports why not', () => {
  const { runtime } = fakeRuntime();
  const registered = [];
  const disposed = [];
  const host = {
    get: (name) => (name === 'webServer' ? {
      register(route) {
        registered.push(route);
        return () => disposed.push(route.path);
      },
    } : null),
  };
  const result = registerMemoryRoutes(host, { runtime });
  assert.equal(result.registered, true);
  assert.deepEqual(result.paths, [MEMORY_API.stats, MEMORY_API.config, MEMORY_API.graph, MEMORY_API.retry]);
  assert.deepEqual(registered.map((route) => route.kind), ['exact', 'exact', 'exact', 'exact']);
  result.dispose();
  assert.deepEqual(disposed.sort(), [MEMORY_API.config, MEMORY_API.graph, MEMORY_API.retry, MEMORY_API.stats].sort());

  const missing = registerMemoryRoutes({ get: () => null }, { runtime });
  assert.equal(missing.registered, false);
  assert.match(missing.reason, /webServer/);
});
