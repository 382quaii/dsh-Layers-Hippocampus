/**
 * v1.5.6 — settings-page "install dsh-orchestrator from GitHub" button.
 *
 * Contract:
 *   1. already installed => no Host installer call;
 *   2. mutating the profile requires explicit `{confirm:true}`;
 *   3. no pluginManager service => a structured manual fallback (never silently fail);
 *   4. with pluginManager => `installBundle(repo,{enabled:true})` and restart reporting;
 *   5. the HTTP route and the UI source carry the same repo URL + confirm dialog.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { apply, getRuntime, ORCHESTRATOR_REPO } from '../index.js';
import { MEMORY_API, createMemoryRoutes } from '../src/webRoutes.js';
import { createOrchestratorStub, fakeCtx, tempDir } from './helpers.js';

function fakeRequest({ method = 'POST', url = MEMORY_API.orchestratorInstall, body = null } = {}) {
  const chunks = body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const stream = Readable.from(chunks);
  stream.method = method;
  stream.url = url;
  stream.headers = { host: '127.0.0.1' };
  return stream;
}

function fakeResponse() {
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

async function call(routes, request) {
  const route = routes.find((candidate) => candidate.path === MEMORY_API.orchestratorInstall);
  assert.ok(route, 'the install route is registered');
  const res = fakeResponse();
  await route.handler(request, res);
  return res;
}

async function withPluginManager(manager, body) {
  const dir = tempDir('orchestrator-install');
  const { ctx, services, dispose } = fakeCtx({ orchestrator: false });
  if (manager) services.set('pluginManager', manager);
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    await body(runtime, ctx);
  } finally {
    dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('already installed is reported without touching the Host installer', async () => {
  let called = 0;
  const { ctx } = { ctx: null };
  const manager = { inspect: async () => ({ status: 'accepted' }), installBundle: async () => { called += 1; return { application: 'applied' }; } };
  // This fixture injects a real orchestrator service, so the runtime short-circuits.
  const dir = tempDir('orchestrator-already');
  const fixture = fakeCtx({ orchestrator: false });
  fixture.services.set('pluginManager', manager);
  fixture.services.set('orchestrator', createOrchestratorStub());
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    const result = await runtime.installOrchestrator({ confirm: true });
    assert.equal(result.state, 'already-installed');
    assert.equal(called, 0);
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('confirmation and missing pluginManager produce structured outcomes', async () => {
  await withPluginManager(null, async (runtime) => {
    assert.equal((await runtime.installOrchestrator({ confirm: false })).state, 'confirmation-required');
    const manual = await runtime.installOrchestrator({ confirm: true });
    assert.equal(manual.state, 'manual');
    assert.ok(Array.isArray(manual.steps) && manual.steps.length >= 2);
  });
});

test('with pluginManager the GitHub spec is installed and restart is reported', async () => {
  const calls = [];
  const manager = {
    inspect: async (spec) => {
      calls.push(['inspect', spec]);
      return { status: 'accepted', kind: 'git' };
    },
    installBundle: async (spec, options) => {
      calls.push(['install', spec, options]);
      return { changed: true, application: 'restart-required' };
    },
  };
  await withPluginManager(manager, async (runtime) => {
    const result = await runtime.installOrchestrator({ confirm: true });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'restart-required');
    assert.equal(result.restartRequired, true);
    assert.deepEqual(calls[0], ['inspect', ORCHESTRATOR_REPO]);
    assert.deepEqual(calls[1], ['install', ORCHESTRATOR_REPO, { enabled: true }]);
  });
});

test('the HTTP route requires confirm:true and delegates to the runtime', async () => {
  const manager = { inspect: async () => ({ status: 'accepted' }), installBundle: async () => ({ application: 'restart-required' }) };
  await withPluginManager(manager, async (runtime) => {
    const routes = createMemoryRoutes({ runtime });
    const noConfirm = await call(routes, fakeRequest({ body: {} }));
    assert.equal(noConfirm.state.status, 400);
    assert.equal(noConfirm.json().error.code, 'MEM_E_INVALID_INPUT');

    const ok = await call(routes, fakeRequest({ body: { confirm: true } }));
    assert.equal(ok.state.status, 200);
    assert.equal(ok.json().installState, 'restart-required');
  });
});

test('the settings page ships the button, repo URL and confirm dialog', () => {
  const source = fs.readFileSync(new URL('../ui/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('orchestratorInstall:'));
  assert.ok(source.includes('从 GitHub 安装 dsh-orchestrator'));
  assert.ok(source.includes('https://github.com/382quaii/dsh-Layers-Orchestrator'));
  assert.ok(source.includes('window.confirm'));
  assert.ok(source.includes('h(OrchestratorInstallCard'));
});
