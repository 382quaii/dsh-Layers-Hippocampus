/**
 * v1.5.3 — space-creation incident fix (route drift + Fail-Fast + human copy).
 *
 * Incident: a new client bundle called `/api/hippocampus/spaces`, the running host
 * process was older and did not serve it, and the UI surfaced `MEM_E_SPACES: HTTP
 * 404` verbatim. Three locks, all asserted here:
 *
 *   1. ROUTE-DRIFT LOCK: every route the client calls must exist verbatim in the
 *      backend table (no missing route, no slash mismatch).
 *   2. FAIL-FAST ENGINE: invalid / reserved / conflicting space ids throw
 *      MEM_E_SPACE_INVALID (400 over HTTP) BEFORE any directory or JSONL write.
 *   3. HUMAN COPY: the client maps 404 / route-missing / network failures to
 *      "创建失败：底层引擎未响应，请检查版本或联系架构师" and gates creation on a
 *      capability handshake so an old host is detected before a request is made.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createRuntime } from '../index.js';
import { resolveConfig, toMemoryOptions } from '../src/config.js';
import { ErrorCodes } from '../src/errors.js';
import { MEMORY_API, createMemoryRoutes, registerMemoryRoutes } from '../src/webRoutes.js';
import { validateNewSpaceId } from '../src/spaces/spaceRouter.js';
import { FakeClock, T0, makeMemory, tempDir } from './helpers.js';

const CLIENT_PATH = new URL('../ui/client.js', import.meta.url);
const FRIENDLY_404 = '创建失败：底层引擎未响应，请检查版本或联系架构师';

function fakeRequest({ method = 'GET', url = '/', body = null } = {}) {
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
async function call(routes, routePath, request) {
  const route = routes.find((candidate) => candidate.path === routePath);
  assert.ok(route, `route ${routePath} is registered`);
  const res = fakeResponse();
  await route.handler(request, res);
  return res;
}
async function withRuntime(body) {
  const dir = tempDir('v153');
  const config = resolveConfig({ dataDir: dir, autoMaintainOnBoot: false });
  const runtime = createRuntime({ config, options: toMemoryOptions(config), clock: new FakeClock(T0) });
  try {
    runtime.start();
    await runtime.ready;
    await body({ runtime });
  } finally {
    runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 1. route-drift lock (the direct 404 prevention) -----------------------

test('every client API path exists verbatim in the backend route table (no slash drift)', () => {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  // The client keeps one API constant table. Parse it and compare path-by-path.
  const tableStart = source.indexOf('const API = {');
  const tableEnd = source.indexOf('};', tableStart);
  assert.ok(tableStart > 0 && tableEnd > tableStart, 'the client API table exists');
  const literals = [...source.slice(tableStart, tableEnd).matchAll(/([a-zA-Z]+):\s*'([^']+)'/g)].map((match) => ({
    key: match[1],
    path: match[2],
  }));
  assert.deepEqual(
    literals.map((entry) => entry.key).sort(),
    Object.keys(MEMORY_API).sort(),
    'the client must expose exactly the backend route keys (adding a route means updating both sides)',
  );
  for (const [key, backendPath] of Object.entries(MEMORY_API)) {
    const clientEntry = literals.find((entry) => entry.key === key);
    assert.ok(clientEntry, `client is missing API.${key}`);
    assert.equal(clientEntry.path, backendPath, `API.${key} drifted from the backend path`);
    // And the literal really is in the served bundle source (not built dynamically).
    assert.ok(source.includes(`'${backendPath}'`), `client does not contain ${backendPath}`);
  }
  // The route table the host registers must include every advertised path.
  const routes = createMemoryRoutes({ runtime: {} });
  assert.deepEqual(routes.map((route) => route.path), Object.values(MEMORY_API));
  assert.ok(routes.some((route) => route.path === MEMORY_API.spaces), 'the spaces route is really registered');
});

// ---- 2. engine Fail-Fast: MEM_E_SPACE_INVALID ------------------------------

test('validateNewSpaceId rejects malformed / reserved / default ids with MEM_E_SPACE_INVALID', () => {
  const invalid = ['', '   ', 'Bad', 'bad id!', 'a/b', '..', '.', 'work.', 'con', 'nul', 'com1', 'x'.repeat(65), null, 42];
  for (const value of invalid) {
    assert.throws(
      () => validateNewSpaceId(value),
      (error) => error.code === 'MEM_E_SPACE_INVALID',
      `${JSON.stringify(value)} must be MEM_E_SPACE_INVALID`,
    );
  }
  // `33` (the id from the incident report) is a LEGAL id: numbers are allowed.
  for (const value of ['33', 'work', 'private', 'team_a.b-c', 'global']) {
    assert.equal(validateNewSpaceId(value), value);
  }
  assert.equal(ErrorCodes.SPACE_INVALID, 'MEM_E_SPACE_INVALID');
});

test('Memory.createSpace rejects conflicts before writing anything', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const first = await memory.createSpace('33');
    assert.equal(first.spaceId, '33');
    assert.equal(first.created, true);
    // Conflict: the same id cannot be created twice.
    await assert.rejects(() => memory.createSpace('33'), (error) => error.code === 'MEM_E_SPACE_INVALID');
    // `default` always exists.
    await assert.rejects(() => memory.createSpace('default'), (error) => error.code === 'MEM_E_SPACE_INVALID');
    // A FILE where the space directory would live is a path conflict.
    fs.mkdirSync(path.join(memory.dataDir, 'spaces'), { recursive: true });
    fs.writeFileSync(path.join(memory.dataDir, 'spaces', 'blocked'), 'not a dir', 'utf8');
    await assert.rejects(() => memory.createSpace('blocked'), (error) => error.code === 'MEM_E_SPACE_INVALID');
    // Nothing dirty reached the log: only the one valid creation exists.
    const view = memory.indexManager.snapshot();
    assert.ok(view.events.length === 0 || view.events.every((event) => event.content !== 'blocked'));
  } finally {
    cleanup();
  }
});

// ---- 3. HTTP: 201 / 400 MEM_E_SPACE_INVALID / capability handshake ---------

test('POST /spaces creates (201), rejects invalid + duplicate (400 MEM_E_SPACE_INVALID)', async () => {
  await withRuntime(async ({ runtime }) => {
    const routes = createMemoryRoutes({ runtime });
    const created = await call(
      routes, MEMORY_API.spaces,
      fakeRequest({ method: 'POST', url: MEMORY_API.spaces, body: { space_id: '33' } }),
    );
    assert.equal(created.state.status, 201);
    assert.equal(created.json().spaceId, '33');
    assert.equal(created.json().created, true);

    const duplicate = await call(
      routes, MEMORY_API.spaces,
      fakeRequest({ method: 'POST', url: MEMORY_API.spaces, body: { space_id: '33' } }),
    );
    assert.equal(duplicate.state.status, 400);
    assert.equal(duplicate.json().error.code, 'MEM_E_SPACE_INVALID');

    for (const bad of ['bad id!', '..', '', 'UPPER', 'con']) {
      const res = await call(
        routes, MEMORY_API.spaces,
        fakeRequest({ method: 'POST', url: MEMORY_API.spaces, body: { space_id: bad } }),
      );
      assert.equal(res.state.status, 400, `space_id ${JSON.stringify(bad)} must be a 400`);
      assert.equal(res.json().error.code, 'MEM_E_SPACE_INVALID');
    }

    // Stats carries the capability handshake the client gates creation on.
    const stats = await call(routes, MEMORY_API.stats, fakeRequest({ url: MEMORY_API.stats }));
    assert.equal(stats.json().capabilities.spaces, true);
    // GET /spaces also advertises it (old host = absent field, never a lie).
    const list = await call(routes, MEMORY_API.spaces, fakeRequest({ url: MEMORY_API.spaces }));
    assert.equal(list.json().capabilities.spaces, true);
  });
});

// The strongest anti-404 assertion: take the path the CLIENT actually calls,
// register the routes the way the host does, dispatch a real POST through that
// exact path, and prove a HANDLER answered (never the router's 404).
test('the client create path is captured by the registered host routes (no 404)', async () => {
  await withRuntime(async ({ runtime }) => {
    const source = fs.readFileSync(CLIENT_PATH, 'utf8');
    const literal = /spaces:\s*'([^']+)'/.exec(source)?.[1];
    assert.equal(literal, MEMORY_API.spaces, 'client and backend paths must be identical');

    const registered = [];
    const host = {
      get(name) {
        if (name !== 'webServer') return null;
        return {
          register(route) {
            registered.push(route);
            return () => {};
          },
        };
      },
    };
    const result = registerMemoryRoutes(host, { runtime });
    assert.equal(result.registered, true);
    const route = registered.find((candidate) => candidate.path === literal);
    assert.ok(route, `the host registered no handler for the client path ${literal} (this IS the 404)`);

    const res = fakeResponse();
    await route.handler(
      fakeRequest({ method: 'POST', url: literal, body: { space_id: '33' } }),
      res,
    );
    // A handler answered: 201 created. A router 404 would have no body/handler.
    assert.notEqual(res.state.status, 404);
    assert.equal(res.state.status, 201);
    assert.equal(res.json().ok, true);
  });
});

// ---- 4. UI: capability gate + human copy (no raw HTTP 404) ------------------

function loadClient() {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  const captured = {};
  const window = {
    __ModuleLoader__: {
      load(entry) {
        captured.factory = entry.factory;
      },
    },
  };
  const run = new Function('window', 'document', 'fetch', 'console', '"use strict";\n' + source);
  run(window, undefined, () => Promise.reject(new Error('offline')), { warn() {}, error() {} });
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect() {},
    useRef: (value) => ({ current: value }),
  };
  return captured.factory((name) => {
    if (name === 'react') return fakeReact;
    throw new Error(`unexpected module ${name}`);
  });
}

test('the client maps 404 and route-missing failures to the exact human copy', () => {
  const module = loadClient();
  assert.equal(typeof module.describeSpaceError, 'function');
  assert.equal(module.describeSpaceError({ code: 'MEM_E_SPACES', message: 'HTTP 404' }), FRIENDLY_404);
  assert.equal(module.describeSpaceError(null, 404), FRIENDLY_404);
  assert.equal(module.describeSpaceError({ code: 'MEM_E_NETWORK', message: 'fetch failed' }), FRIENDLY_404);
  assert.equal(
    module.describeSpaceError({ code: 'MEM_E_SPACE_INVALID', message: 'space already exists: 33', details: { reason: 'conflict', spaceId: '33' } }),
    '创建失败：空间「33」已存在，请换一个名称',
  );
  assert.equal(
    module.describeSpaceError({ code: 'MEM_E_SPACE_INVALID', message: 'reserved', details: { reason: 'reserved', spaceId: 'con' } }),
    '创建失败：该名称是系统保留名，请换一个',
  );
  assert.match(
    module.describeSpaceError({ code: 'MEM_E_SPACE_INVALID', message: 'invalid space id: "Bad"' }),
    /空间名称无效/,
  );
  assert.match(module.describeSpaceError({ code: 'MEM_E_NOT_READY', message: 'not ready' }), /尚未就绪/);
  // No branch may echo a raw code:status pair.
  for (const sample of [
    module.describeSpaceError({ code: 'MEM_E_SPACES', message: 'HTTP 404' }),
    module.describeSpaceError({ code: 'MEM_E_SPACE_INVALID', message: 'bad' }),
    module.describeSpaceError(undefined, undefined),
  ]) {
    assert.ok(!/HTTP\s*404/i.test(sample), `raw 404 leaked: ${sample}`);
    assert.ok(sample.startsWith('创建失败：'), `message is not human copy: ${sample}`);
  }
});

test('the capability handshake turns an old host into a version hint, not a 404', () => {
  const module = loadClient();
  assert.equal(module.spaceCreateAvailable({ capabilities: { spaces: true } }).available, true);
  for (const payload of [null, {}, { capabilities: {} }, { capabilities: { spaces: false } }]) {
    const state = module.spaceCreateAvailable(payload);
    assert.equal(state.available, false);
    assert.match(state.reason, /宿主版本/);
  }
  // Source-level: the selector must NEVER call /spaces before checking the gate,
  // and the raw code/message template must be gone.
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  for (const marker of [
    'function spaceCreateAvailable',
    'function describeSpaceError',
    'capabilities.spaces',
    '创建失败：底层引擎未响应，请检查版本或联系架构师',
    '空间名称需以小写字母/数字开头',
  ]) {
    assert.ok(source.includes(marker), `client must contain ${marker}`);
  }
  assert.equal(
    source.includes("`${error.code || 'MEM_E_SPACES'}: ${error.message || `HTTP ${httpStatus}`}`"),
    false,
    'the raw MEM_E_SPACES: HTTP 404 template must be gone',
  );
});
