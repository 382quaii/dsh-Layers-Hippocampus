/**
 * v1.5.1 — cross-space transfer requires EXPLICIT user consent.
 *
 * Threat model: an agent decides on its own that a memory "would be useful" in
 * another space (or the global space) and moves it. That is a data-egress action,
 * not a memory optimization. Two independent locks are asserted here:
 *
 *   1. PROMPT LAYER: `memory:policy` carries a static "最高安全红线" block that
 *      forbids model-initiated transfers and explains the user_approved retry.
 *   2. ENGINE LAYER: `Memory.transferEvents` refuses any call without
 *      `userApproved === true` while `context.requireExplicitConsentForTransfer`
 *      is true (default), BEFORE opening a space or reading any content, and
 *      answers MEM_E_REQUIRE_USER_CONSENT with the fixed intercept message.
 *
 * The human channel (the panel's own HTTP route) marks consent itself, so a UI
 * click never needs the model — that path is asserted too.
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { resolveConfig } from '../src/config.js';
import { EDITABLE_CONFIG_KEYS, MEMORY_API, createMemoryRoutes, validatePatch } from '../src/webRoutes.js';
import { FakeClock, T0, fakeCtx, makeMemory, tempDir } from './helpers.js';

const INTERCEPT_MESSAGE = '[系统拦截] 跨空间传递需要用户明确授权。请向用户确认后再试。';

async function withPlugin(overrides = {}, body) {
  const dir = tempDir('v151-consent');
  const host = fakeCtx();
  try {
    await apply(host.ctx, { dataDir: dir, autoMaintainOnBoot: false, ...overrides });
    await getRuntime(host.ctx).ready;
    await body({ host, dir, runtime: getRuntime(host.ctx) });
  } finally {
    host.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function seed(runtime, text = 'consent probe fact', tags = ['consent:probe']) {
  return runtime.memory.remember({ content: text, tags, salience: 0.9, happenedAt: T0 });
}

test('default configuration requires explicit consent for transfers', () => {
  const config = resolveConfig({});
  assert.equal(config.context.requireExplicitConsentForTransfer, true, 'the gate is ON by default');
  // Never a truthy string, never silently coerced.
  assert.throws(
    () => resolveConfig({ context: { requireExplicitConsentForTransfer: 'yes' } }),
    (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE',
  );
  assert.ok(EDITABLE_CONFIG_KEYS.includes('context.requireExplicitConsentForTransfer'));
  assert.deepEqual(validatePatch({ 'context.requireExplicitConsentForTransfer': false }), {
    context: { requireExplicitConsentForTransfer: false },
  });
});

test('MEM_E_REQUIRE_USER_CONSENT: the engine gate fires before any validation or I/O', async () => {
  await withPlugin({}, async ({ runtime }) => {
    const stored = await seed(runtime);

    // Even an INVALID target answers CONSENT first: the gate cannot be probed for
    // information about the store, and no space is opened.
    await assert.rejects(
      () => runtime.memory.transferEvents({ eventIds: [stored.eventId], targetSpaceId: '../escape' }),
      (error) =>
        error.code === 'MEM_E_REQUIRE_USER_CONSENT' &&
        error.message === INTERCEPT_MESSAGE &&
        error.details.requires === 'user_approved',
    );

    // Nothing moved, nothing parked.
    assert.equal((await runtime.memory.status()).panel.pendingDeletes.total, 0);
    const recalled = await runtime.memory.recall({ tags: ['consent:probe'] });
    assert.ok(recalled.hits.some((hit) => hit.eventId === stored.eventId), 'the source memory is untouched');
  });
});

test('the agent tool blocks without user_approved and succeeds with it', async () => {
  await withPlugin({}, async ({ host, runtime }) => {
    const stored = await seed(runtime);
    const definition = host.tools.get('memory_space_transfer');
    assert.ok(definition);

    const blocked = JSON.parse(
      await definition.execute({ event_ids: [stored.eventId], target_space_id: 'space-b' }),
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'MEM_E_REQUIRE_USER_CONSENT');
    assert.equal(blocked.error.message, INTERCEPT_MESSAGE);
    const emptyTarget = await runtime.memory.recall({ tags: ['consent:probe'], targetSpaceId: 'space-b' });
    assert.equal(emptyTarget.hits.length, 0, 'a refused call wrote nothing into the target space');

    const approved = JSON.parse(
      await definition.execute({ event_ids: [stored.eventId], target_space_id: 'space-b', user_approved: true }),
    );
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(approved.mode, 'copy');
    assert.equal(approved.source.state, 'retained');
    const moved = await runtime.memory.recall({ tags: ['consent:probe'], targetSpaceId: 'space-b' });
    assert.ok(moved.hits.length >= 1, 'the approved copy reached the target space');
  });
});

test('transfer_to_global honours the same gate and targets the global space', async () => {
  await withPlugin({}, async ({ host, runtime }) => {
    const stored = await seed(runtime, 'global transfer probe', ['consent:global']);
    const definition = host.tools.get('memory_transfer_to_global');
    assert.ok(definition, 'the global-transfer alias is registered');

    const blocked = JSON.parse(await definition.execute({ event_ids: [stored.eventId] }));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, 'MEM_E_REQUIRE_USER_CONSENT');
    assert.equal((await runtime.memory.recall({ tags: ['consent:global'], targetSpaceId: 'global' })).hits.length, 0);

    const approved = JSON.parse(await definition.execute({ event_ids: [stored.eventId], user_approved: true }));
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.equal(approved.target.spaceId, 'global');
    const inGlobal = await runtime.memory.recall({ tags: ['consent:global'], targetSpaceId: 'global' });
    assert.ok(inGlobal.hits.length >= 1);
  });
});

test('the operator can disable the gate explicitly (and only then does it pass)', async () => {
  await withPlugin({ context: { requireExplicitConsentForTransfer: false } }, async ({ host, runtime }) => {
    const stored = await seed(runtime, 'gate-off probe', ['consent:off']);
    const definition = host.tools.get('memory_space_transfer');
    const parsed = JSON.parse(await definition.execute({ event_ids: [stored.eventId], target_space_id: 'space-c' }));
    assert.equal(parsed.ok, true, 'gate disabled by config: no per-call approval needed');
    assert.equal(parsed.mode, 'copy');
  });
});

test('engine-level transferEvents enforces the same contract', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const stored = await memory.remember({ content: 'engine consent probe', tags: ['consent:engine'], salience: 0.9 });
    await assert.rejects(
      () => memory.transferEvents({ eventIds: [stored.eventId], targetSpaceId: 'space-d' }),
      (error) => error.code === 'MEM_E_REQUIRE_USER_CONSENT',
    );
    const result = await memory.transferEvents({
      eventIds: [stored.eventId],
      targetSpaceId: 'space-d',
      userApproved: true,
    });
    assert.equal(result.mode, 'copy');
    assert.equal(result.source.state, 'retained');
  } finally {
    cleanup();
  }
});

test('prompt layer: the red-line block names both tools and the retry protocol', async () => {
  await withPlugin({}, async ({ host }) => {
    const policy = host.sections.find((section) => section.name === 'memory:policy');
    assert.ok(policy, 'the static policy section exists');
    const text = policy.text();
    for (const marker of [
      '最高安全红线',
      '绝对禁止',
      'memory_space_transfer',
      'memory_transfer_to_global',
      'user_approved',
      'MEM_E_REQUIRE_USER_CONSENT',
      '您需要我把这条信息同步到其他空间吗？',
    ]) {
      assert.ok(text.includes(marker), `memory:policy must contain ${marker}`);
    }
    // The two registration lines also carry the security warning.
    const tools = host.sections.find((section) => section.name === 'memory');
    assert.ok(tools && tools.text().includes('SECURITY: requires explicit user consent'));
  });
});

test('the HTTP transfer route does NOT fabricate consent: it forwards the explicit flag', async () => {
  const { ErrorCodes, MemoryError } = await import('../src/errors.js');
  const calls = [];
  const runtime = {
    phase: 'ready',
    state: 'ready',
    async transferEvents(payload) {
      // Mirror the engine gate so the route behaviour is asserted end-to-end.
      if (payload.userApproved !== true) {
        throw new MemoryError(ErrorCodes.REQUIRE_USER_CONSENT, '[系统拦截] 跨空间传递需要用户明确授权。请向用户确认后再试。', {
          requires: 'user_approved',
        });
      }
      calls.push(payload);
      return { mode: payload.transferMode, target: { spaceId: payload.targetSpaceId, eventIds: ['new-1'] } };
    },
  };
  const routes = createMemoryRoutes({ runtime });
  const route = routes.find((candidate) => candidate.path === MEMORY_API.transfer);
  assert.ok(route);
  const invoke = async (body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST';
    req.url = MEMORY_API.transfer;
    const res = {
      status: 0,
      text: '',
      writeHead(status) {
        this.status = status;
        return this;
      },
      end(text = '') {
        this.text = text;
        return this;
      },
    };
    await route.handler(req, res);
    return { status: res.status, body: JSON.parse(res.text) };
  };

  // No user_approved -> the engine gate refuses; the route must not add consent.
  const blocked = await invoke({ event_ids: ['e1'], target_space_id: 'work', transfer_mode: 'copy' });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, 'MEM_E_REQUIRE_USER_CONSENT');
  assert.equal(calls.length, 0);

  // Only an explicit human flag reaches the engine.
  const approved = await invoke({ event_ids: ['e1'], target_space_id: 'work', transfer_mode: 'copy', user_approved: true });
  assert.equal(approved.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userApproved, true, 'explicit user_approved is forwarded, never fabricated');
});

test('the panel uses a SpaceSelector + checkbox 移动到… flow instead of manual ids', () => {
  const source = fs.readFileSync(new URL('../ui/client.js', import.meta.url), 'utf8');
  for (const marker of [
    'function SpaceSelector',
    'function CrossSpaceTransferUI',
    'function StorageMigratorUI',
    '移动到…',
    '即将向 [',
    '二次确认 · 安全红线',
    'requireExplicitConsentForTransfer',
    'MEM_E_REQUIRE_USER_CONSENT',
    "memories: '/api/hippocampus/memories'",
    "spaces: '/api/hippocampus/spaces'",
    'API.transfer',
    'migrationPathProblem',
    'user_approved: true',
  ]) {
    assert.ok(source.includes(marker), `ui/client.js must contain ${marker}`);
  }
  // UI_TASK_1: the old manual event_ids / target_space_id text inputs are gone.
  for (const removed of ['目标空间 ID（target_space_id）', '事件 ID（event_ids，逗号分隔）']) {
    assert.equal(source.includes(removed), false, `manual input "${removed}" must be removed from the UI`);
  }
});
