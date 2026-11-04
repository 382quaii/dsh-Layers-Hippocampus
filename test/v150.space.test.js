/**
 * v1.5.0 module 2 — multi-space routing (physical layer) + native/rollover
 * context accounting.
 *
 * Two independent contracts are proved here:
 *   1. SpaceRouter: one space = one FIFO chain, two spaces = two chains. The
 *      concurrency test gates space `a` behind a promise only space `b` can
 *      release; a single global lock would deadlock the test (the watchdog would
 *      report it) instead of merely being suboptimal.
 *   2. ContextEngine: native vs layered is a measurement of the SAME blocks the
 *      engine already tracks, the handoff threshold is a headroom, and the legacy
 *      threshold eviction is byte-for-byte unchanged.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ContextEngine } from '../src/context/contextEngine.js';
import {
  DEFAULT_SPACE_ID,
  SPACE_ID_PATTERN,
  SpaceRouter,
  normaliseSpaceId,
} from '../../dsh-orchestrator/src/spaceRouter.js';
import { FakeClock, T0, tempDir } from './helpers.js';

/**
 * Fail a test instead of hanging the whole runner: the space-router proof is a
 * deadlock detector, so its failure mode must be a normal assertion failure.
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function makeRouter(dir) {
  const calls = [];
  const owner = { name: 'owner', close() {} };
  const router = new SpaceRouter({
    owner,
    dataDir: dir,
    openChild: async (childDir) => {
      calls.push(childDir);
      fs.mkdirSync(childDir, { recursive: true });
      return { dir: childDir, close() {} };
    },
  });
  return { router, owner, calls };
}

test('different spaces run concurrently while one space stays FIFO', async () => {
  const dir = tempDir('space-concurrency');
  const { router } = makeRouter(dir);
  try {
    const order = [];
    let releaseA;
    const gate = new Promise((resolve) => {
      releaseA = resolve;
    });
    // 'a' must WAIT. The only thing that can release it is 'b', so if the router
    // serialised across spaces (one global lock), neither promise could resolve
    // and this test would time out. Completing at all proves per-space chains.
    const aTask = router.run('a', async () => {
      order.push('a-start');
      await gate;
      order.push('a-end');
      return 'a-result';
    });
    const bTask = router.run('b', async () => {
      order.push('b-start');
      releaseA();
      order.push('b-end');
      return 'b-result';
    });
    const [aResult, bResult] = await withTimeout(Promise.all([aTask, bTask]), 2000, 'cross-space concurrency');
    assert.equal(aResult, 'a-result');
    assert.equal(bResult, 'b-result');
    // 'a' started before it blocked, and could only finish after 'b' finished:
    // b genuinely ran WHILE a was in flight, not merely after it.
    assert.ok(order.includes('a-start'), 'space a task started');
    assert.ok(order.indexOf('b-end') >= 0, 'space b task completed');
    assert.ok(
      order.indexOf('a-end') > order.indexOf('b-end'),
      `a finishes only after b releases it (order: ${order.join(',')})`,
    );

    // Same-space FIFO: the second task may not start before the first finishes.
    const fifo = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const first = router.run('a', async () => {
      fifo.push('first-start');
      await firstGate;
      fifo.push('first-end');
    });
    const second = router.run('a', async () => {
      fifo.push('second');
    });
    releaseFirst();
    await withTimeout(Promise.all([first, second]), 2000, 'same-space FIFO');
    assert.deepEqual(fifo, ['first-start', 'first-end', 'second'], 'one space is a FIFO queue, never interleaved');
    // Both ops are done: the queue depth is back to zero.
    assert.equal(router.pending('a'), 0);
  } finally {
    await router.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spaces are isolated directories and unsafe ids are rejected', async () => {
  const dir = tempDir('space-isolation');
  const { router, owner, calls } = makeRouter(dir);
  try {
    // No spaces/ directory yet: the default space is the only one.
    assert.deepEqual(router.all(), ['default']);
    // The default id is the owner handle itself, not an opened child.
    assert.equal(await router.memoryFor('default'), owner);
    assert.equal(router.spaceDir('default'), dir);

    const a = await router.memoryFor('a');
    const b = await router.memoryFor('b');
    assert.equal(a.dir, path.join(dir, 'spaces', 'a'), 'child space lives under <dataDir>/spaces/<id>');
    assert.equal(b.dir, path.join(dir, 'spaces', 'b'));
    assert.notEqual(a, b, 'each child space has its own handle');
    // Opening is lazy and cached: repeat/concurrent callers share one open, so a
    // second Memory instance is never raced onto the same directory.
    assert.equal(await router.memoryFor('a'), a);
    assert.equal(calls.filter((childDir) => childDir === a.dir).length, 1);

    // 'default' sorts first; children follow in localeCompare order.
    assert.deepEqual(router.all(), ['default', 'a', 'b']);
    assert.deepEqual(router.status(), {
      available: true,
      multiSpace: true,
      ids: ['default', 'a', 'b'],
      open: ['a', 'b'],
      defaultSpaceId: 'default',
    });

    // An unsafe id must never become a path. These are the traversal/alias cases
    // the pattern exists for: they throw instead of silently becoming 'default'.
    for (const bad of ['../x', 'A B', 'x/y']) {
      assert.throws(
        () => normaliseSpaceId(bad),
        (error) => error.code === 'MEM_E_INVALID_INPUT',
        `normaliseSpaceId(${JSON.stringify(bad)}) must be rejected`,
      );
      await assert.rejects(
        () => router.memoryFor(bad),
        (error) => error.code === 'MEM_E_INVALID_INPUT',
        `memoryFor(${JSON.stringify(bad)}) must be rejected`,
      );
    }
    assert.equal(DEFAULT_SPACE_ID, 'default');
    assert.equal(SPACE_ID_PATTERN.test('team.docs_2'), true);
    assert.equal(SPACE_ID_PATTERN.test('../x'), false);
    assert.equal(normaliseSpaceId(undefined), 'default');
    assert.equal(normaliseSpaceId(''), 'default');

    // runMany takes a DETERMINISTIC sorted acquisition order, so `['b','a']` and
    // `['a','b']` cannot deadlock each other (ABBA) and the task sees both handles.
    const seen = await withTimeout(
      router.runMany(['b', 'a', 'a'], async (memories) => ({
        keys: [...memories.keys()],
        aDir: memories.get('a')?.dir,
        bDir: memories.get('b')?.dir,
      })),
      2000,
      'runMany',
    );
    assert.deepEqual(seen.keys, ['a', 'b'], 'normalised, deduped, sorted acquisition order');
    assert.equal(seen.aDir, a.dir);
    assert.equal(seen.bDir, b.dir);
  } finally {
    await router.closeAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nativeState switches to layered exactly at the native token limit', () => {
  const clock = new FakeClock(T0);
  // No config overrides: the documented defaults must be 4000 / 8000.
  const engine = new ContextEngine({ clock, getPolicy: () => ({}) });
  assert.equal(engine.nativeTokenLimit, 8000);
  assert.equal(engine.rolloverThreshold, 0.85);
  assert.equal(engine.rolloverEnabled, true);

  engine.inject({ id: 'n1', tokens: 7000, text: 'x' });
  let native = engine.nativeState();
  assert.equal(native.mode, 'native', '7000 < 8000: the session still fits natively');
  assert.equal(native.tokens, 7000);
  assert.equal(engine.foldAllowed(), false, 'folding is a layered-mode operation only');

  engine.inject({ id: 'n2', tokens: 1000, text: 'y' });
  native = engine.nativeState();
  assert.equal(native.tokens, 8000);
  assert.equal(native.mode, 'layered', 'the boundary is inclusive: 8000 is already layered');
  assert.equal(engine.foldAllowed(), true);

  // The session side is part of the measurement: a native session over the
  // engine's own block total still forces layered mode.
  const sessionEngine = new ContextEngine({
    clock,
    getPolicy: () => ({}),
    getSessionTokens: () => 9000,
  });
  assert.equal(sessionEngine.nativeState().mode, 'layered');
  assert.equal(sessionEngine.nativeState().effectiveTokens, 9000, 'max(blocks, session), not blocks alone');
});

test('remainingTokens measures headroom to the handoff point', () => {
  const engine = new ContextEngine({
    clock: new FakeClock(T0),
    getPolicy: () => ({}),
    nativeTokenLimit: 1000,
    autoRolloverThreshold: 0.85,
  });
  engine.inject({ id: 'big', tokens: 900, text: 'x' });
  let native = engine.nativeState();
  assert.equal(native.mode, 'native');
  assert.equal(native.ratio, 0.9);
  assert.equal(native.handoffThresholdTokens, 850);
  assert.equal(native.rolloverDue, true, '0.90 >= 0.85: a handoff is due');
  assert.equal(native.remainingTokens, 0, 'past the handoff point the headroom is clamped to zero, never negative');

  engine.clear();
  engine.inject({ id: 'small', tokens: 400, text: 'x' });
  native = engine.nativeState();
  assert.equal(native.remainingTokens, 450, '850 (handoff) - 400 = 450 tokens until the handoff point');
  assert.equal(native.rolloverDue, false);
});

test('rollover disabled forces eviction at 95% of the native window', () => {
  const clock = new FakeClock(T0);
  const base = {
    clock,
    getPolicy: () => ({}),
    // maxTokens is deliberately huge: the legacy threshold (85000) is never
    // crossed, so ANY eviction here can only come from the native-force path.
    maxTokens: 100_000,
    nativeTokenLimit: 1000,
    autoRolloverThreshold: 0.85,
  };
  const fill = (engine) => {
    for (let i = 0; i < 6; i += 1) {
      // 6 x 160 = 960 tokens = 96% of the 1000-token native window.
      engine.inject({ id: `b${i}`, tokens: 160, text: 'x', salience: 0.5, at: T0 });
    }
  };

  // Enabled: 96% of native is a HANDOFF, not an eviction. The legacy window is
  // untouched, so enforce() must not trigger.
  const enabled = new ContextEngine(base);
  fill(enabled);
  const nativeEnabled = enabled.nativeState();
  assert.equal(nativeEnabled.rolloverDue, true, '0.96 >= 0.85');
  assert.equal(nativeEnabled.forceEvictionDue, false, 'forced eviction is only for rollover-disabled sessions');
  assert.equal(enabled.enforce({ now: T0 }).triggered, false, 'enabled handoff path leaves the window alone');

  // Disabled: there is no handoff to move the session, so 96% must evict.
  const disabled = new ContextEngine({ ...base, autoRolloverEnabled: false });
  fill(disabled);
  assert.equal(disabled.nativeState().forceEvictionDue, true, '0.96 >= 0.95 with rollover disabled');
  const report = disabled.enforce({ now: T0 });
  assert.equal(report.triggered, true);
  assert.equal(report.reason, 'native-force');
  assert.equal(report.forced, true);
  assert.ok(report.native, 'the return carries the native snapshot that justified the trigger');
  assert.equal(report.native.forceEvictionDue, true);
  // The forced limit is the STRICTER of the legacy target and the native target:
  // a huge maxTokens must not turn the forced eviction into a no-op.
  const limit = Math.min(report.target * report.maxTokens, report.target * report.native.nativeTokenLimit);
  assert.equal(limit, 700);
  assert.ok(report.after <= limit, `after (${report.after}) must land at or below ${limit}`);
  assert.ok(report.evicted.length > 0);
});

test('legacy threshold eviction is unchanged', () => {
  const engine = new ContextEngine({
    clock: new FakeClock(T0),
    getPolicy: () => ({}),
    maxTokens: 1000,
    threshold: 0.85,
  });
  // Mirror of test/context.test.js: 5 x 300 = 1500 > 0.85 * 1000.
  for (let i = 0; i < 5; i += 1) {
    engine.inject({ id: `l${i}`, tokens: 300, text: `${i}`, salience: 1 - i * 0.1, at: T0 });
  }
  assert.equal(engine.tokens(), 1500);

  const report = engine.enforce({ now: T0 });
  assert.equal(report.triggered, true, 'the legacy trigger still fires at maxTokens * threshold');
  assert.equal(report.reason, 'threshold');
  assert.equal(report.forced, false);
  assert.ok(report.after <= 700, 'evicts down to target * maxTokens exactly as before');
  assert.ok(report.evicted.length >= 2);
  assert.equal(report.evicted[0].id, 'l4', 'lowest score leaves first — deterministic score order unchanged');
  // Existing keys are all still present; the new keys are additive only.
  for (const key of ['triggered', 'before', 'after', 'evicted', 'threshold', 'target', 'maxTokens', 'pinnedFloorReached']) {
    assert.ok(key in report, `legacy enforce key ${key} must survive`);
  }

  // snapshot() keeps every legacy key and adds the native measurement.
  const snapshot = engine.snapshot({ now: T0 });
  assert.equal(snapshot.maxTokens, 1000);
  assert.ok(snapshot.native, 'snapshot carries the native state');
  assert.equal(snapshot.native.mode, 'native');
  assert.equal(typeof snapshot.savedTokens, 'number');
});
