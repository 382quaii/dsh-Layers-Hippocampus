/**
 * v1.5.2 — architecture correction (UI/engine refactor, TDD).
 *
 * Two independent concerns are locked here and must stay physically separate:
 *
 *   A. PHYSICAL storage migration (dataDir, A/B double buffer, state=migrating):
 *      fail-fast on a missing/relative/same/inside/root/not-empty target; the old
 *      directory is never touched by a rejected request.
 *
 *   B. BUSINESS multi-space routing (SpaceSelector): every read route takes
 *      `?space=<id>` and returns THAT space's log/index/L1.5/session/context only.
 *      Switching spaces must never bleed the previous space's data.
 *
 *   C. The consent gate stays the backstop for business transfer: model tools and
 *      a raw HTTP POST without `user_approved:true` both answer
 *      MEM_E_REQUIRE_USER_CONSENT; only an explicit human approval passes.
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../index.js';
import { resolveConfig, toMemoryOptions } from '../src/config.js';
import { validateMigrationPaths } from '../src/migrationRunner.js';
import { MEMORY_API, createMemoryRoutes } from '../src/webRoutes.js';
import { FakeClock, T0, tempDir } from './helpers.js';

async function withRuntime(body, configOverrides = {}) {
  const dir = tempDir('v152');
  const config = resolveConfig({ dataDir: dir, autoMaintainOnBoot: false, ...configOverrides });
  const runtime = createRuntime({ config, options: toMemoryOptions(config), clock: new FakeClock(T0) });
  try {
    runtime.start();
    await runtime.ready;
    await body({ runtime, dir, config });
  } finally {
    runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// ---- A. physical dataDir migration: Fail-Fast ------------------------------

test('dataDir migration validation: missing, relative, same, inside, root are rejected', () => {
  const from = path.join(tempDir('v152-mig-src'), 'memory');
  const root = path.parse(path.resolve(from)).root;
  const cases = [
    { to: '', code: 'MEM_E_MIGRATION_PATH' },
    { to: '   ', code: 'MEM_E_MIGRATION_PATH' },
    { to: 'relative/dir', code: 'MEM_E_MIGRATION_PATH' },
    { to: from, code: 'MEM_E_MIGRATION_PATH' },
    { to: path.join(from, 'nested'), code: 'MEM_E_MIGRATION_PATH' },
    { to: root, code: 'MEM_E_MIGRATION_PATH' },
  ];
  for (const entry of cases) {
    assert.throws(
      () => validateMigrationPaths({ from, to: entry.to }),
      (error) => error.code === entry.code,
      `target ${JSON.stringify(entry.to)} must be rejected with ${entry.code}`,
    );
  }
});

test('dataDir migration validation: a non-empty / non-directory target is rejected before any job', () => {
  const from = tempDir('v152-mig-from');
  const busy = tempDir('v152-mig-busy');
  fs.writeFileSync(path.join(busy, 'keep.txt'), 'occupied', 'utf8');
  assert.throws(
    () => validateMigrationPaths({ from, to: busy }),
    (error) => error.code === 'MEM_E_MIGRATION_TARGET_BUSY',
  );
  const fileTarget = path.join(tempDir('v152-mig-file'), 'not-a-dir.txt');
  fs.writeFileSync(fileTarget, 'x', 'utf8');
  assert.throws(
    () => validateMigrationPaths({ from, to: fileTarget }),
    (error) => error.code === 'MEM_E_MIGRATION_PATH',
  );
  // A brand-new absolute target IS accepted (the only legal shape).
  const fresh = path.join(tempDir('v152-mig-ok'), 'new-store');
  assert.deepEqual(validateMigrationPaths({ from, to: fresh }), { source: path.resolve(from), target: path.resolve(fresh) });
});

test('runtime.startMigration fails fast on bad targets and keeps the old directory', async () => {
  await withRuntime(async ({ runtime, dir }) => {
    assert.throws(() => runtime.startMigration('relative-dir'), (error) => error.code === 'MEM_E_MIGRATION_PATH');
    assert.throws(() => runtime.startMigration(dir), (error) => error.code === 'MEM_E_MIGRATION_PATH');
    const busy = tempDir('v152-busy');
    fs.writeFileSync(path.join(busy, 'x'), 'x');
    assert.throws(
      () => runtime.startMigration(busy),
      (error) => error.code === 'MEM_E_MIGRATION_TARGET_BUSY',
    );
    // The old store is still authoritative and untouched.
    assert.equal(fs.existsSync(path.join(dir, 'log', 'CURRENT')), true);
    assert.equal(runtime.phase, 'ready');
    assert.equal((await runtime.uiPayload()).ok, true);
  });
});

// ---- B. SpaceSelector routing isolation ------------------------------------

test('every read follows ?space=<id>: stats, graph, memories and session do not bleed', async () => {
  await withRuntime(async ({ runtime }) => {
    // The default space gets its own event and its own session accounting.
    await runtime.memory.remember({ content: 'default-space fact', tags: ['iso:probe'], salience: 0.9 });
    runtime.memory.observeSessionTokens('default-session', 900);

    // The work space gets a different event (routed write).
    const workEvent = await runtime.memory.remember({
      content: 'work-space only fact',
      tags: ['iso:probe'],
      salience: 0.9,
      targetSpaceId: 'work',
    });
    assert.ok(workEvent.eventId);

    const defaultPayload = await runtime.uiPayload();
    assert.equal(defaultPayload.spaceId, 'default');
    assert.equal(defaultPayload.panel.global.events, 1, 'default stats count only the default space');
    assert.ok(defaultPayload.panel.session.tokens >= 900, 'default session accounting is its own');

    const workPayload = await runtime.uiPayload('work');
    assert.equal(workPayload.spaceId, 'work');
    assert.equal(workPayload.panel.global.events, 1, 'work stats count only the work space');
    assert.equal(workPayload.panel.session.tokens, 0, 'a different space has its own (empty) session context');
    assert.ok(workPayload.panel.spaces.ids.includes('default'));
    assert.ok(workPayload.panel.spaces.ids.includes('work'));

    // Graph route follows the selection too (its own spaceId, never blended).
    const graph = await runtime.graphPayload('work');
    assert.equal(graph.spaceId, 'work');

    // Memory list + retrieval are isolated by the same routing hook.
    const defaultRecent = await runtime.recentMemories({ limit: 5 });
    const workRecent = await runtime.recentMemories({ limit: 5, targetSpaceId: 'work' });
    assert.ok(defaultRecent.events.every((event) => event.snippet.includes('default-space')));
    assert.equal(workRecent.events.length, 1);
    assert.match(workRecent.events[0].snippet, /work-space only fact/);

    const defaultRecall = await runtime.memory.recall({ tags: ['iso:probe'] });
    const workRecall = await runtime.memory.recall({ tags: ['iso:probe'], targetSpaceId: 'work' });
    assert.ok(!defaultRecall.hits.some((hit) => hit.eventId === workEvent.eventId), 'work events never leak into default recall');
    assert.ok(workRecall.hits.some((hit) => hit.eventId === workEvent.eventId));
  });
});

test('SpaceSelector backend: ensureSpace creates an EMPTY space and stats route honours ?space=', async () => {
  await withRuntime(async ({ runtime }) => {
    const created = await runtime.ensureSpace('private');
    assert.equal(created.spaceId, 'private');
    assert.ok(created.spaces.ids.includes('private'));
    assert.ok(runtime.spaceList().includes('work') === false, 'no phantom spaces are invented');

    const routes = createMemoryRoutes({ runtime });
    const empty = await call(routes, MEMORY_API.stats, fakeRequest({ url: `${MEMORY_API.stats}?space=private` }));
    assert.equal(empty.state.status, 200);
    assert.equal(empty.json().spaceId, 'private');
    assert.equal(empty.json().panel.global.events, 0, 'a new space starts empty, never a copy');

    const spaces = await call(routes, MEMORY_API.spaces, fakeRequest({ method: 'GET', url: MEMORY_API.spaces }));
    assert.equal(spaces.state.status, 200);
    assert.deepEqual(spaces.json().spaces, runtime.spaceList());
    assert.equal(spaces.json().capabilities.spaces, true, 'the handshake advertises the route');
    const create = await call(
      routes,
      MEMORY_API.spaces,
      fakeRequest({ method: 'POST', url: MEMORY_API.spaces, body: { space_id: 'team' } }),
    );
    assert.equal(create.state.status, 201, 'creation answers 201 Created');
    assert.ok(create.json().spaces.includes('team'));
  });
});

// ---- C. consent gate backstop ----------------------------------------------

test('unauthorized transfer is blocked at the ENGINE and at the HTTP route', async () => {
  await withRuntime(async ({ runtime }) => {
    const stored = await runtime.memory.remember({ content: 'consent refactor probe', tags: ['iso:consent'], salience: 0.9 });
    await assert.rejects(
      () => runtime.memory.transferEvents({ eventIds: [stored.eventId], targetSpaceId: 'space-x' }),
      (error) => error.code === 'MEM_E_REQUIRE_USER_CONSENT',
    );

    const routes = createMemoryRoutes({ runtime });
    const blocked = await call(
      routes,
      MEMORY_API.transfer,
      fakeRequest({
        method: 'POST',
        url: MEMORY_API.transfer,
        body: { event_ids: [stored.eventId], target_space_id: 'space-x', transfer_mode: 'copy' },
      }),
    );
    assert.equal(blocked.state.status, 400);
    assert.equal(blocked.json().error.code, 'MEM_E_REQUIRE_USER_CONSENT');

    const approved = await call(
      routes,
      MEMORY_API.transfer,
      fakeRequest({
        method: 'POST',
        url: MEMORY_API.transfer,
        body: { event_ids: [stored.eventId], target_space_id: 'space-x', transfer_mode: 'copy', user_approved: true },
      }),
    );
    assert.equal(approved.state.status, 200, JSON.stringify(approved.json()));
    const inTarget = await runtime.recentMemories({ limit: 5, targetSpaceId: 'space-x' });
    assert.equal(inTarget.events.length, 1);
  });
});

// ---- D. UI refactor contract (no manual ids; selector + separate migrator) --

test('UI wiring: SpaceSelector in the header, no manual transfer ids, storage migrator isolated', () => {
  const source = fs.readFileSync(new URL('../ui/client.js', import.meta.url), 'utf8');
  for (const marker of [
    'function SpaceSelector',
    'function CrossSpaceTransferUI',
    'function StorageMigratorUI',
    'h(SpaceSelector',
    'h(StorageMigratorUI',
    '移动到…',
    '即将向 [',
    '二次确认 · 安全红线',
    'migrationPathProblem',
    'useActiveSpace',
    '?space=${encodeURIComponent',
    'context.requireExplicitConsentForTransfer',
  ]) {
    assert.ok(source.includes(marker), `ui/client.js must contain ${marker}`);
  }
  // UI_TASK_1: manual business-transfer inputs are gone; dataDir is not a form draft.
  for (const removed of [
    '目标空间 ID（target_space_id）',
    '事件 ID（event_ids，逗号分隔）',
    'draft.dataDir',
    '分享/转移',
  ]) {
    assert.equal(source.includes(removed), false, `"${removed}" must not exist in the UI anymore`);
  }
  // The global selector sits in the panel header; every read hook carries the space.
  assert.ok(source.includes('useMemoryStats(activeSpace)'), 'stats follow the selected space');
  assert.ok(source.includes('useGraph(limit, ready, activeSpace)'), 'graph follows the selected space');
  assert.ok(source.includes('useRecentMemories(ready, activeSpace'), 'memory list follows the selected space');
});
