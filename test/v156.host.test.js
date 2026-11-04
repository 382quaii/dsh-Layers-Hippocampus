/**
 * v1.5.6 / P1-7 — host lifecycle bridge (Dream compensation on session start).
 *
 * Locked contracts:
 *   1. `agent/created` / `session/created` are the "session start" signals; they are
 *      subscribed through a plain `{on, off}` bus seam (MockHostEnvironment);
 *   2. no Dream for `dream.compensateAfterHours` + price allowed ⇒ exactly ONE
 *      compensating run, through the shared maintenance gate (never a second one);
 *   3. an LLM-backed Dream with UNKNOWN price is skipped (never guess the valley);
 *      a local-only Dream may run (cheap, deterministic);
 *   4. `enableDream:false` disables compensation entirely;
 *   5. detach() unsubscribes; the bridge is disposed with the plugin.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { resolveConfig } from '../src/config.js';
import { HostBridge, HOST_EVENT_NAMES, normalisePrice } from '../src/hostBridge.js';
import { tempDir } from './helpers.js';

/** Minimal host mock: one bus, one ctx, no real harness. */
function createMockHostEnvironment() {
  const handlers = new Map();
  const tools = new Map();
  const sections = new Map();
  const contexts = new Map();
  const effects = [];
  const bus = {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(handler);
    },
    off(name, handler) {
      handlers.get(name)?.delete(handler);
    },
    emit(name, payload) {
      for (const handler of handlers.get(name) ?? []) handler(payload);
    },
    listenerCount(name) {
      return handlers.get(name)?.size ?? 0;
    },
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    systemPrompt: {
      section(definition) {
        sections.set(definition.name, definition);
        return () => sections.delete(definition.name);
      },
      context(definition) {
        contexts.set(definition.name, definition);
        return () => contexts.delete(definition.name);
      },
    },
    effect(factory) {
      const disposer = factory();
      effects.push(disposer);
      return disposer;
    },
    get() {
      return null;
    },
    inject(_deps, callback) {
      callback(ctx);
      return () => {};
    },
    on: bus.on,
    off: bus.off,
    emit: bus.emit,
    listenerCount: bus.listenerCount,
    toolsMap: tools,
    sections,
    contexts,
    async dispose() {
      for (const disposer of effects.reverse()) {
        if (typeof disposer === 'function') await disposer();
      }
    },
  };
  ctx.root = ctx;
  return { ctx, bus };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

function unitBridge({ config = {}, lastDreamAt = null, onDream = null, bus = null } = {}) {
  const bridge = new HostBridge({
    bus,
    clock: () => 1_000_000,
    getConfig: () => ({ enableDream: true, dream: { useLlm: false, compensateAfterHours: 1 }, ...config }),
    getLastDreamAt: () => lastDreamAt,
    onDream,
  });
  return bridge;
}

test('price provider results are normalised, never guessed', () => {
  assert.deepEqual(normalisePrice(true), { known: true, low: true });
  assert.deepEqual(normalisePrice(false), { known: true, low: false });
  assert.deepEqual(normalisePrice({ low: true }), { known: true, low: true });
  assert.deepEqual(normalisePrice(null), { known: false, low: null });
  assert.deepEqual(normalisePrice('low'), { known: false, low: null });
});

test('session start runs one compensating Dream when due and price allows', async () => {
  const { bus } = createMockHostEnvironment();
  const calls = [];
  const bridge = unitBridge({
    onDream: async (context) => {
      calls.push(context.trigger);
      return { ran: true };
    },
  });
  bridge.attach(bus);
  assert.equal(bus.listenerCount(HOST_EVENT_NAMES.agentCreated), 1, 'the session-start signal is subscribed');

  bus.emit(HOST_EVENT_NAMES.agentCreated, { source: 'new' });
  assert.ok(await waitFor(() => calls.length === 1), 'the due compensation ran');
  const status = bridge.status();
  assert.equal(status.sessionStarts, 1);
  assert.equal(status.compensations, 1);
  assert.equal(status.dreamDue, true, 'without a recorded Dream it stays due until one runs');

  bridge.detach();
  assert.equal(bus.listenerCount(HOST_EVENT_NAMES.agentCreated), 0, 'detach unsubscribes');
});

test('an LLM-backed Dream with unknown price is skipped (price-unknown)', async () => {
  let called = 0;
  const bridge = unitBridge({
    config: { dream: { useLlm: true, compensateAfterHours: 1 } },
    onDream: async () => {
      called += 1;
    },
  });
  const verdict = await bridge.maybeCompensate({ trigger: 'session-start' });
  assert.deepEqual(verdict, { ran: false, reason: 'price-unknown' });
  assert.equal(called, 0);
  assert.equal(bridge.status().lastSkipReason, 'price-unknown');

  // An injected low-valley probe permits it; a peak probe refuses it.
  bridge.setPriceProbe(() => ({ low: true }));
  assert.equal((await bridge.maybeCompensate()).ran, true);
  bridge.setPriceProbe(() => ({ low: false }));
  const peak = await bridge.maybeCompensate({ trigger: 'session-start' });
  assert.deepEqual(peak, { ran: false, reason: 'peak' });
});

test('not due, disabled and in-flight are each refused', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const bridge = unitBridge({
    onDream: async () => {
      calls += 1;
      await gate;
    },
  });
  // In flight: the second attempt is refused, not queued.
  const first = bridge.maybeCompensate();
  const second = await bridge.maybeCompensate();
  assert.deepEqual(second, { ran: false, reason: 'in-flight' });
  release();
  await first;
  assert.equal(calls, 1);

  // Not due: a recent Dream clamps the window.
  const recent = new HostBridge({
    clock: () => 10 * 3_600_000,
    getConfig: () => ({ enableDream: true, dream: { useLlm: false, compensateAfterHours: 2 } }),
    getLastDreamAt: () => 10 * 3_600_000 - 60_000,
    onDream: async () => ({ ran: true }),
  });
  assert.deepEqual(await recent.maybeCompensate(), { ran: false, reason: 'not-due' });

  // Disabled entirely.
  const disabled = new HostBridge({
    clock: () => 1,
    getConfig: () => ({ enableDream: false, dream: { useLlm: false } }),
    getLastDreamAt: () => null,
    onDream: async () => ({ ran: true }),
  });
  assert.deepEqual(await disabled.maybeCompensate(), { ran: false, reason: 'dream-disabled' });
});

test('plugin integration: MockHostEnvironment session start compensates once and updates host status', async () => {
  const dir = tempDir('host-bridge');
  const { ctx, bus } = createMockHostEnvironment();
  try {
    await apply(ctx, {
      dataDir: dir,
      maintenanceCron: '0 */6 * * *',
      autoMaintainOnBoot: false,
      dream: { useLlm: false, compensateAfterHours: 1 },
    });
    const runtime = getRuntime(ctx);
    await runtime.ready;

    assert.ok(runtime.hostBridge, 'the bridge is exposed on the runtime');
    assert.equal(runtime.hostStatus().sessionStarts, 0);
    assert.equal(runtime.hostStatus().dreamDue, true);

    bus.emit(HOST_EVENT_NAMES.agentCreated, { source: 'new' });
    assert.ok(await waitFor(() => runtime.hostStatus().compensations === 1), 'the compensation ran through the gate');
    assert.equal(runtime.hostStatus().sessionStarts, 1);
    assert.ok(runtime.lastDreamAt > 0, 'the Dream timestamp advanced');
    assert.equal(runtime.hostStatus().dreamDue, false, 'a fresh Dream is not due again');

    // A payload from the /stats surface carries the same status.
    const payload = await runtime.uiPayload();
    assert.equal(payload.host.compensations, 1);
    assert.equal(payload.host.sessionStarts, 1);
  } finally {
    await ctx.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dream.compensateAfterHours is fail-fast validated', () => {
  assert.equal(resolveConfig({}).dream.compensateAfterHours, 24);
  assert.equal(resolveConfig({ dream: { compensateAfterHours: 6 } }).dream.compensateAfterHours, 6);
  assert.throws(
    () => resolveConfig({ dream: { compensateAfterHours: 0 } }),
    (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
  );
  assert.throws(
    () => resolveConfig({ dream: { compensateAfterHours: 1000 } }),
    (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
  );
});
