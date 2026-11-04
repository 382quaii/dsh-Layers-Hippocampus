/**
 * v1.5.6 — the working mode (Host agent preset) survives a handoff.
 *
 * Why: a long session hands off to a NEW conversation; without this the new
 * session silently falls back to the profile's default preset instead of the mode
 * the user was actually working in (e.g. “创造模式”).
 *
 * Locked contracts:
 *   1. the handoff marker records the preset in force at rollover time;
 *   2. a NEW conversation (`agent/created` source='startup') from a different
 *      session re-applies that preset via `agentPresets.select` BEFORE the first
 *      turn (the Host event is serial and awaited);
 *   3. `resume`/`same-session` never re-apply; a failed select never fails creation;
 *   4. `agent-preset/selected` keeps the tracked mode current.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { T0, tempDir } from './helpers.js';
import { apply, getRuntime } from '../index.js';

function createMockHost() {
  const handlers = new Map();
  const services = new Map();
  const tools = new Map();
  const effects = [];
  const bus = {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(handler);
    },
    off(name, handler) {
      handlers.get(name)?.delete(handler);
    },
    async emit(name, ...args) {
      const results = [];
      for (const handler of handlers.get(name) ?? []) results.push(await handler(...args));
      return results;
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
      section() {
        return () => {};
      },
      context() {
        return () => {};
      },
    },
    effect(factory) {
      const disposer = factory();
      effects.push(disposer);
      return disposer;
    },
    get(name) {
      return services.get(name) ?? null;
    },
    inject(_deps, callback) {
      callback(ctx);
      return () => {};
    },
    on: bus.on,
    off: bus.off,
    services,
    async dispose() {
      for (const disposer of effects.reverse()) {
        if (typeof disposer === 'function') await disposer();
      }
    },
  };
  ctx.root = ctx;
  return { ctx, bus };
}

function writeMarker(dir, marker) {
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'handoff.json'), JSON.stringify(marker), 'utf8');
}

test('the handoff marker records the working mode in force at rollover', async () => {
  const dir = tempDir('preset-marker');
  const { ctx } = createMockHost();
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(ctx);
    await runtime.ready;

    runtime.agentPreset = 'creative';
    runtime.memory.observeSessionTokens('session-old', 100_000);
    const result = await runtime.memory.checkHandoff({ distill: false });
    assert.equal(result.handoff.active, true);
    assert.equal(result.handoff.agentPreset, 'creative', 'the marker carries the mode');
    assert.equal(runtime.memory.handoffState().agentPreset, 'creative');
  } finally {
    await ctx.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an older marker without a preset is backfilled from the live agent mode', async () => {
  const dir = tempDir('preset-backfill');
  const { ctx } = createMockHost();
  ctx.services.set('agentPresets', {
    composedPreset: (agentCtx) => agentCtx?.preset ?? null,
    select: async (_agent, preset) => preset,
  });
  ctx.services.set('agents', { currentInitiator: () => ({ id: 'session-live', ctx: { preset: 'creative' } }) });
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    // Marker written before the feature existed: no agentPreset field.
    writeMarker(dir, { active: true, sessionId: 'session-live' });
    assert.equal(runtime.memory.handoffState().agentPreset, undefined);

    assert.equal(runtime.syncAgentPreset(), 'creative');
    assert.equal(runtime.agentPreset, 'creative');
    assert.equal(runtime.memory.handoffState().agentPreset, 'creative', 'the marker is backfilled');

    runtime.syncAgentPreset();
    assert.equal(runtime.memory.handoffState().agentPreset, 'creative', 'backfill is idempotent');
  } finally {
    await ctx.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new conversation restores the preset the handoff marker recorded', async () => {
  const dir = tempDir('preset-inherit');
  const { ctx, bus } = createMockHost();
  const calls = [];
  ctx.services.set('agentPresets', {
    composedPreset: () => null,
    async select(agent, preset) {
      calls.push({ agentId: agent.id, preset });
      return preset;
    },
  });
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    writeMarker(dir, { active: true, sessionId: 'session-old', agentPreset: 'creative', summaryEventId: 'ev_x' });

    const agent = { id: 'session-new', ctx: { preset: 'creative' } };
    await bus.emit('agent/created', { agent, source: 'startup' });

    assert.deepEqual(calls, [{ agentId: 'session-new', preset: 'creative' }]);
    assert.equal(runtime.lastPresetInherit.inherited, true);
    assert.equal(runtime.agentPreset, 'creative');
    const payload = await runtime.uiPayload();
    assert.equal(payload.agentPreset, 'creative');
    assert.equal(payload.presetInherit.inherited, true);
  } finally {
    await ctx.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resume, same-session and a marker without a preset never re-apply', async () => {
  const dir = tempDir('preset-skip');
  const { ctx, bus } = createMockHost();
  const calls = [];
  ctx.services.set('agentPresets', {
    composedPreset: () => null,
    async select(agent, preset) {
      calls.push(preset);
      return preset;
    },
  });
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    writeMarker(dir, { active: true, sessionId: 'session-old', agentPreset: 'creative' });

    await bus.emit('agent/created', { agent: { id: 'session-resumed' }, source: 'resume' });
    assert.deepEqual(calls, [], 'resume keeps the session as-is');

    await bus.emit('agent/created', { agent: { id: 'session-old' }, source: 'startup' });
    assert.deepEqual(calls, [], 'the marker owner session is not re-applied');

    writeMarker(dir, { active: true, sessionId: 'session-old' });
    await bus.emit('agent/created', { agent: { id: 'session-new2' }, source: 'startup' });
    assert.deepEqual(calls, [], 'no recorded preset => no override');
    assert.equal(runtime.lastPresetInherit.reason, 'marker-without-preset');
  } finally {
    await ctx.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed select is reported but never fails agent creation', async () => {
  const dir = tempDir('preset-fail');
  const { ctx, bus } = createMockHost();
  ctx.services.set('agentPresets', {
    composedPreset: () => null,
    async select() {
      throw new Error('preset disappeared');
    },
  });
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    writeMarker(dir, { active: true, sessionId: 'session-old', agentPreset: 'gone' });

    await bus.emit('agent/created', { agent: { id: 'session-new' }, source: 'startup' });
    assert.equal(runtime.lastPresetInherit.inherited, false);
    assert.match(runtime.lastPresetInherit.message, /preset disappeared/);
    assert.equal(runtime.agentPreset, null, 'the failed mode is not recorded as current');
  } finally {
    await ctx.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent-preset/selected keeps the tracked mode current', async () => {
  const dir = tempDir('preset-track');
  const { ctx, bus } = createMockHost();
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    await bus.emit('agent-preset/selected', 'session-1', 'creative');
    assert.equal(runtime.agentPreset, 'creative');
    assert.equal(runtime.agentPresetSessionId, 'session-1');
    assert.ok(runtime.hostStatus().presetSelections >= 1);
  } finally {
    await ctx.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
