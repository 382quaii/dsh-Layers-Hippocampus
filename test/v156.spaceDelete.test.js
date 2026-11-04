/**
 * v1.5.6 — space deletion (the missing UI + engine affordance).
 *
 * Contracts:
 *   1. engine: only a named space is deletable; `default` is always refused;
 *   2. destructive: `confirm:true` is mandatory, otherwise MEM_E_INVALID_INPUT;
 *   3. strict single-space core (no Orchestrator) answers MEM_E_FEATURE_DISABLED;
 *   4. the HTTP route carries `action:'delete'` and returns the refreshed list;
 *   5. the UI only renders the delete button for a non-default space and asks the
 *      human first (source contract).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { MEMORY_API, createMemoryRoutes } from '../src/webRoutes.js';
import { fakeCtx, makeMemory, T0, tempDir } from './helpers.js';

function fakeRequest({ method = 'POST', url = MEMORY_API.spaces, body = null } = {}) {
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
  const route = routes.find((candidate) => candidate.path === MEMORY_API.spaces);
  assert.ok(route, 'the spaces route is registered');
  const res = fakeResponse();
  await route.handler(request, res);
  return res;
}

test('a named space can be deleted; default and missing spaces are refused', async () => {
  const fixture = await makeMemory();
  try {
    const { memory } = fixture;
    await memory.createSpace('trash-me');
    const dir = path.join(fixture.dir, 'spaces', 'trash-me');
    assert.ok(fs.existsSync(dir));

    await assert.rejects(
      () => memory.deleteSpace('trash-me', { confirm: false }),
      (error) => error.code === 'MEM_E_INVALID_INPUT',
      'deletion requires explicit confirmation',
    );
    assert.ok(fs.existsSync(dir), 'nothing is removed without confirmation');

    await assert.rejects(
      () => memory.deleteSpace('default', { confirm: true }),
      (error) => error.code === 'MEM_E_SPACE_INVALID',
      'the default space is never deletable',
    );

    const result = await memory.deleteSpace('trash-me', { confirm: true });
    assert.equal(result.deleted, true);
    assert.ok(!fs.existsSync(dir), 'the space directory is removed');
    assert.ok(!result.spaces.ids.includes('trash-me'));
    assert.equal(fixture.memory.spaces.status().ids.length, 1);

    await assert.rejects(
      () => memory.deleteSpace('trash-me', { confirm: true }),
      (error) => error.code === 'MEM_E_NOT_FOUND',
      'a missing space is a clean 404-style error',
    );
  } finally {
    fixture.cleanup();
  }
});

test('the strict single-space core refuses deletion entirely', async () => {
  const fixture = await makeMemory({ multiSpace: false });
  try {
    await assert.rejects(
      () => fixture.memory.deleteSpace('work', { confirm: true }),
      (error) => error.code === 'MEM_E_FEATURE_DISABLED',
    );
  } finally {
    fixture.cleanup();
  }
});

test('the capabilities handshake versions deletion (old hosts hide the button)', async () => {
  const dir = tempDir('space-delete-caps');
  const { ctx, dispose } = fakeCtx();
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    assert.equal(runtime.capabilities().spaces, true);
    assert.equal(runtime.capabilities().spacesDelete, true);

    // A pre-delete host advertises spaces:true but no spacesDelete; the client must
    // render NO delete button, so the request can never be misread as CREATE.
    const source = fs.readFileSync(new URL('../ui/client.js', import.meta.url), 'utf8');
    assert.ok(source.includes('function spaceDeleteAvailable'));
    assert.ok(source.includes('caps.spacesDelete === true'));
    assert.ok(source.includes('deleteAvailable && props.value !== DEFAULT_SPACE_ID'));
    assert.ok(source.includes('if (!caps || caps.spaces !== true) return null'));
  } finally {
    dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /spaces {action:delete} removes the space and returns the refreshed list', async () => {
  const dir = tempDir('space-delete-route');
  const { ctx, dispose } = fakeCtx();
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    await runtime.createSpace('route-del');
    assert.ok(fs.existsSync(path.join(dir, 'spaces', 'route-del')));

    const routes = createMemoryRoutes({ runtime });
    const res = await call(
      routes,
      fakeRequest({ body: { action: 'delete', space_id: 'route-del', confirm: true } }),
    );
    assert.equal(res.state.status, 200);
    const payload = res.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.deleted, true);
    assert.deepEqual(payload.spaces, ['default']);
    assert.ok(!fs.existsSync(path.join(dir, 'spaces', 'route-del')));

    const noConfirm = await call(routes, fakeRequest({ body: { action: 'delete', space_id: 'default', confirm: true } }));
    assert.equal(noConfirm.state.status, 400);
    assert.equal(noConfirm.json().error.code, 'MEM_E_SPACE_INVALID');

    // An unknown action must NEVER fall through to CREATE (the "空间已存在" bug).
    const unknown = await call(routes, fakeRequest({ body: { action: 'destroy', space_id: 'whatever' } }));
    assert.equal(unknown.state.status, 400);
    assert.equal(unknown.json().error.code, 'MEM_E_INVALID_INPUT');
  } finally {
    dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the SpaceSelector renders the delete affordance and asks the human first', () => {
  const source = fs.readFileSync(new URL('../ui/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('删除空间'), 'the delete button exists');
  assert.ok(source.includes("action: 'delete'"), 'the client calls the delete action');
  assert.ok(source.includes('window.confirm'), 'the human confirms before the destructive call');
  assert.ok(source.includes('props.value !== DEFAULT_SPACE_ID'), 'default has no delete button');
});
