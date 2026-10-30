/**
 * P0 seam: the UI must branch on `state`, never on the HTTP status, and writes
 * before READY must be refused loudly instead of being swallowed.
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { apply } from '../index.js';
import { createMemoryRoutes } from '../src/webRoutes.js';
import { fakeCtx, tempDir } from './helpers.js';

function fakeRuntime(phase, overrides = {}) {
  let current = phase;
  return {
    get phase() {
      return current;
    },
    set phase(next) {
      current = next;
    },
    async uiPayload() {
      return { ok: current === 'ready', phase: current, state: current, panel: current === 'ready' ? {} : undefined };
    },
    uiConfig() {
      return {
        maintenanceCron: '0 */6 * * *',
        storageBudgetMb: 50,
        decay: { halfLifeDays: 30 },
        activeSet: { cap: 200 },
        context: {},
        temp: {},
        identity: { eventTimePolicy: 'content' },
      };
    },
    async updateConfig(patch) {
      return { ...this.uiConfig(), ...patch, phase: current };
    },
    async graphPayload() {
      return { ok: current === 'ready', phase: current, state: current, graph: { available: current === 'ready', nodes: [], edges: [] } };
    },
    async retry() {
      return { ok: false, code: 'MEM_E_NOT_FAILED', phase: current, state: current };
    },
    ...overrides,
  };
}

function request({ method = 'GET', body = null } = {}) {
  const stream = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  stream.url = '/';
  stream.headers = { host: '127.0.0.1' };
  return stream;
}

function response() {
  const state = { status: 0, text: '' };
  return {
    state,
    json: () => JSON.parse(state.text),
    writeHead(status) {
      state.status = status;
      return this;
    },
    end(text = '') {
      state.text = text;
      return this;
    },
  };
}

async function invoke(routes, path, req) {
  const route = routes.find((candidate) => candidate.path === path);
  const res = response();
  await route.handler(req, res);
  return res;
}

test('stats carries state=pending with a 503 while the store is starting', async () => {
  const runtime = fakeRuntime('pending');
  const routes = createMemoryRoutes({ runtime });
  const res = await invoke(routes, '/api/hippocampus/stats', request());
  const body = res.json();
  assert.equal(res.state.status, 503);
  assert.equal(body.state, 'pending');
  assert.equal(body.ok, false);
});

test('every error body still carries a state, including 405', async () => {
  const routes = createMemoryRoutes({ runtime: fakeRuntime('in_progress') });
  const res = await invoke(routes, '/api/hippocampus/stats', request({ method: 'PUT' }));
  assert.equal(res.state.status, 405);
  assert.equal(res.json().state, 'in_progress');
});

test('config GET stays readable before READY and reports the state', async () => {
  const routes = createMemoryRoutes({ runtime: fakeRuntime('pending') });
  const res = await invoke(routes, '/api/hippocampus/config', request());
  const body = res.json();
  assert.equal(res.state.status, 200);
  assert.equal(body.state, 'pending');
  assert.equal(body.config.storageBudgetMb, 50);
  assert.equal(body.config.decay.halfLifeDays, 30);
  assert.equal(body.config.activeSet.cap, 200);
});

test('config POST is rejected before READY with MEM_E_NOT_READY and a state', async () => {
  for (const phase of ['pending', 'in_progress']) {
    const routes = createMemoryRoutes({ runtime: fakeRuntime(phase) });
    const res = await invoke(routes, '/api/hippocampus/config', request({ method: 'POST', body: { patch: { storageBudgetMb: 80 } } }));
    const body = res.json();
    assert.equal(res.state.status, 409, `${phase}: write must not be accepted`);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'MEM_E_NOT_READY');
    assert.equal(body.state, phase);
    assert.equal(body.error.details.state, phase);
  }
});

test('config POST succeeds and reports ready once the store is open', async () => {
  const runtime = fakeRuntime('ready');
  const routes = createMemoryRoutes({ runtime });
  const res = await invoke(routes, '/api/hippocampus/config', request({ method: 'POST', body: { patch: { storageBudgetMb: 80 } } }));
  const body = res.json();
  assert.equal(res.state.status, 200);
  assert.equal(body.state, 'ready');
  assert.equal(body.ok, true);
});

test('tools refuse writes before READY with a state-bearing MEM_E_NOT_READY', async () => {
  const dir = tempDir('seam');
  const host = fakeCtx();
  try {
    await apply(host.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    // Deliberately do NOT await readiness: this is the boot race the P0 fixes.
    for (const [tool, args] of [
      ['memory_remember', { content: 'hello' }],
      ['memory_checkpoint', { task_id: 't1', progress: 10 }],
    ]) {
      const definition = host.tools.get(tool);
      assert.ok(definition, `${tool} must be registered before READY`);
      const rendered = await definition.execute(args);
      const text = Array.isArray(rendered) ? rendered[0].text : String(rendered);
      const body = JSON.parse(text);
      assert.equal(body.ok, false, `${tool} must refuse before READY`);
      assert.equal(body.error.code, 'MEM_E_NOT_READY');
      const detailState = body.error.details?.state ?? body.error.details?.phase;
      assert.ok(['pending', 'in_progress'].includes(detailState), `${tool} must report its state, got ${detailState}`);
    }
  } finally {
    host.dispose();
  }
});

test('webServer arriving AFTER apply still registers routes (cold-start ordering)', async () => {
  const dir = tempDir('deferred');
  const host = fakeCtx();
  const order = [];
  const pending = [];
  /** Deferred inject: the callback is stored and fired when the service appears. */
  host.ctx.inject = (_deps, callback) => {
    pending.push(callback);
    return () => {};
  };
  host.ctx.get = (name) =>
    name === 'webServer'
      ? {
          register() {
            order.push('route');
            return () => {};
          },
        }
      : null;
  try {
    await apply(host.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    assert.equal(order.length, 0, 'nothing is registered before the service exists');
    assert.equal(pending.length, 1, 'the child fiber is created at apply time');

    // The web app row activates later: only NOW does the route table exist.
    pending[0](host.ctx);
    assert.equal(order.length, 4, 'all four routes register as soon as webServer appears');
    assert.ok(order.every((entry) => entry === 'route'));
  } finally {
    host.dispose();
  }
});

test('routes are registered BEFORE tools, so the boot race hits a live handler', async () => {
  const dir = tempDir('order');
  const host = fakeCtx();
  const order = [];
  try {
    const registerTool = host.ctx.tools.register.bind(host.ctx.tools);
    host.ctx.tools.register = (definition) => {
      order.push('tool');
      return registerTool(definition);
    };
    host.ctx.get = (name) =>
      name === 'webServer'
        ? {
            register() {
              order.push('route');
              return () => {};
            },
          }
        : null;

    await apply(host.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });

    assert.ok(order.includes('route'), 'the HTTP surface is registered');
    assert.ok(order.includes('tool'), 'tools are registered too');
    assert.equal(order[0], 'route', `routes must come first, got: ${order.slice(0, 4).join(',')}`);
    assert.ok(order.indexOf('route') < order.indexOf('tool'), 'route registration precedes the tool surface');
  } finally {
    host.dispose();
  }
});
