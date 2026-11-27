import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOrchestratorStub, FakeClock } from './helpers.js';

const { createRuntime } = await import('../index.js');
const { resolveConfig, toMemoryOptions } = await import('../src/config.js');
const { HANDOFF_CLEAR_RATIO, relievedDecision } = await import('../src/context/windowGuard.js');

const T0 = Date.parse('2026-11-27T12:00:00.000Z');

function makeRuntime(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-v174-'));
  const config = resolveConfig({
    dataDir: dir,
    autoMaintainOnBoot: false,
    context: { nativeTokenLimit: 1000, autoRolloverThreshold: 0.85, maxTokens: 100_000, ...(overrides.context ?? {}) },
  });
  const runtime = createRuntime({
    config,
    options: toMemoryOptions(config),
    clock: new FakeClock(T0),
    orchestrator: createOrchestratorStub(),
  });
  return { dir, runtime, clock: runtime.clock ?? new FakeClock(T0) };
}

async function withRuntime(overrides, fn) {
  const { dir, runtime } = makeRuntime(overrides);
  runtime.start();
  await runtime.ready;
  try {
    return await fn({ dir, runtime, memory: runtime.memory });
  } finally {
    await runtime.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readMarker(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'state', 'handoff.json'), 'utf8'));
}

/** Write the durable marker directly (the shape checkHandoff() produces). */
function seedMarker(dir, overrides = {}) {
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'state', 'handoff.json'),
    JSON.stringify({
      schema: 1,
      active: true,
      state: 'active',
      at: T0,
      sessionId: 'session-a',
      tokens: 860,
      nativeTokenLimit: 1000,
      ratio: 0.86,
      threshold: 0.85,
      summaryEventId: 'ev_seeded',
      ...overrides,
    }),
  );
}

// --------------------------------------------------------------- unit: the decision
test('relievedDecision: relief is absolute (below the clear ratio)', () => {
  const under = relievedDecision({ markerRatio: 0.9, projectedRatio: 0.42 });
  assert.equal(under.relieved, true);
  assert.equal(under.reason, 'below-clear-ratio');
  // The boundary belongs to relief: <= limit. Above it, a marker only 9 points away is
  // still "the same pressure" — 0.51 vs 0.9 would be a collapse, so use a close marker.
  assert.equal(relievedDecision({ markerRatio: 0.9, projectedRatio: 0.5 }).relieved, true);
  const above = relievedDecision({ markerRatio: 0.6, projectedRatio: 0.51 });
  assert.equal(above.relieved, false);
  assert.equal(above.reason, 'pressure-still-high');
});

test('relievedDecision: relief is also relative (pressure collapsed against the marker)', () => {
  // 0.3 below the marker's own ratio means "this conversation got compacted", whatever
  // the absolute threshold says.
  const collapsed = relievedDecision({ markerRatio: 0.9, projectedRatio: 0.55, threshold: 0.2 });
  assert.equal(collapsed.relieved, true);
  assert.equal(collapsed.reason, 'pressure-collapsed');
  // A bounce inside the delta is NOT relief — no flapping on small moves.
  assert.equal(relievedDecision({ markerRatio: 0.9, projectedRatio: 0.62, threshold: 0.2 }).relieved, false);
  // Without a marker ratio only the absolute threshold can decide.
  assert.equal(relievedDecision({ markerRatio: null, projectedRatio: 0.4 }).relieved, true);
});

// --------------------------------------------------------------- marker upkeep
test('maintainHandoffMarker: no measurement = no verdict (never clear on an empty counter)', async () => {
  await withRuntime({}, async ({ dir, memory }) => {
    seedMarker(dir);
    // The real host never calls observeSessionTokens, so sessionUsage() is 0 — reading
    // that as "0% pressure" would clear a marker that is still true.
    const upkeep = memory.maintainHandoffMarker();
    assert.equal(upkeep.cleared, false);
    assert.equal(upkeep.reason, 'no-pressure');
    assert.equal(memory.handoffState().active, true);
  });
});

test('maintainHandoffMarker: a host ratio below the clear ratio consumes the marker', async () => {
  await withRuntime({}, async ({ dir, memory }) => {
    seedMarker(dir);
    const upkeep = memory.maintainHandoffMarker({ ratio: 0.12, usage: { sessionId: 'session-a' } });
    assert.equal(upkeep.cleared, true);
    assert.equal(upkeep.reason, 'below-clear-ratio');
    assert.equal(memory.handoffState().active, false);
    const marker = readMarker(dir);
    assert.equal(marker.active, false);
    assert.equal(marker.reason, 'pressure-relieved:below-clear-ratio');
    assert.match(String(marker.consumedBy), /session-a:ratio=0\.12/);

    // Idempotent: upkeep on a consumed marker is a no-op, not a rewrite.
    const second = memory.maintainHandoffMarker({ ratio: 0.12, usage: { sessionId: 'session-a' } });
    assert.equal(second.cleared, false);
    assert.equal(second.reason, 'inactive');
  });
});

test('maintainHandoffMarker: high pressure keeps the marker (no premature clearing)', async () => {
  await withRuntime({}, async ({ dir, memory }) => {
    seedMarker(dir);
    const upkeep = memory.maintainHandoffMarker({ ratio: 0.86, usage: { sessionId: 'session-a' } });
    assert.equal(upkeep.cleared, false);
    assert.equal(upkeep.reason, 'pressure-still-high');
    assert.equal(memory.handoffState().active, true);
  });
});

test('maintainHandoffMarker: a collapsed ratio clears even above the absolute threshold', async () => {
  await withRuntime({ context: { handoffClearRatio: 0.2 } }, async ({ dir, memory }) => {
    seedMarker(dir);
    // 0.5 is above handoffClearRatio=0.2, but 0.36 below the marker's own 0.86.
    const upkeep = memory.maintainHandoffMarker({ ratio: 0.5, usage: { sessionId: 'session-a' } });
    assert.equal(upkeep.cleared, true);
    assert.equal(upkeep.reason, 'pressure-collapsed');
    assert.equal(readMarker(dir).reason, 'pressure-relieved:pressure-collapsed');
  });
});

// --------------------------------------------------------------- the reported bug, end to end
test('prompt drops [交接标记] once a fresh host measurement says pressure is gone', async () => {
  await withRuntime({}, async ({ dir, runtime, memory }) => {
    seedMarker(dir);
    // guardRequest stores the host-true reading; prompt assembly reuses it.
    runtime.lastPressure = { ratio: 0.86, tokens: 860, at: memory.clock.now() };
    const hot = runtime.promptState();
    assert.match(hot, /\[交接标记\]/, 'at 86% the marker tells the truth and must be injected');
    assert.match(hot, /上下文已接近原生窗口上限/);

    // The host (or an external compactor) drops the conversation to ~12% of the window.
    runtime.lastPressure = { ratio: 0.12, tokens: 120, at: memory.clock.now() };
    const cool = runtime.promptState();
    assert.doesNotMatch(cool, /\[交接标记\]/, 'a stale marker must not survive relief');
    assert.doesNotMatch(cool, /上下文已接近原生窗口上限/);
    assert.equal(memory.handoffState().active, false);
    assert.equal(readMarker(dir).reason, 'pressure-relieved:below-clear-ratio');

    // And it stays gone on later turns.
    assert.doesNotMatch(runtime.promptState(), /\[交接标记\]/);
  });
});

test('prompt keeps [交接标记] when the pressure reading is stale or absent', async () => {
  await withRuntime({}, async ({ dir, runtime, memory }) => {
    seedMarker(dir);
    // No reading at all (first turn after a restart): the marker must be trusted, not
    // guessed away.
    assert.match(runtime.promptState(), /\[交接标记\]/);
    assert.equal(memory.handoffState().active, true);
    // A reading older than the freshness window is not evidence either.
    runtime.lastPressure = { ratio: 0.05, tokens: 50, at: memory.clock.now() - 10 * 60 * 1000 };
    assert.match(runtime.promptState(), /\[交接标记\]/);
    assert.equal(memory.handoffState().active, true);
  });
});

// --------------------------------------------------------------- config surface
test('config exposes context.handoffClearRatio and rejects nonsense', () => {
  assert.equal(HANDOFF_CLEAR_RATIO, 0.5);
  assert.equal(resolveConfig({ dataDir: os.tmpdir() }).context.handoffClearRatio, 0.5);
  assert.equal(resolveConfig({ dataDir: os.tmpdir(), context: { handoffClearRatio: 0.35 } }).context.handoffClearRatio, 0.35);
  assert.throws(() => resolveConfig({ dataDir: os.tmpdir(), context: { handoffClearRatio: 0.99 } }), /handoffClearRatio/);
  assert.throws(() => resolveConfig({ dataDir: os.tmpdir(), context: { handoffClearRatio: 0 } }), /handoffClearRatio/);
});
