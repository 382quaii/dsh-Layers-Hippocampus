/**
 * Host-plugin adapter tests (no DSH runtime needed).
 *
 * The fake ctx mirrors the contracts the plugin relies on: `ctx.tools.register`,
 * `ctx.systemPrompt.section/context` and `ctx.effect`. Tool results are asserted
 * through `output.render`, i.e. exactly what the model would see.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { apply, getRuntime, inject, resolveConfig } from '../index.js';
import { tempDir } from './helpers.js';

function fakeCtx() {
  const tools = new Map();
  const sections = new Map();
  const contexts = new Map();
  const disposers = [];
  return {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        assert.equal(typeof definition.name, 'string');
        assert.equal(typeof definition.description, 'string');
        assert.equal(typeof definition.execute, 'function');
        assert.equal(typeof definition.output.schema, 'object');
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
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
      disposers.push(disposer);
      return disposer;
    },
    get() {
      return null;
    },
    // The real cordis `inject` waits for a service; here webServer is simply
    // absent, so the child callback runs and registration reports "unavailable".
    inject(_deps, callback) {
      callback(this);
      return () => {};
    },
    sections,
    contexts,
    get toolsMap() {
      return tools;
    },
    async dispose() {
      for (const disposer of disposers.reverse()) {
        if (typeof disposer === 'function') await disposer();
      }
    },
    async call(toolName, args) {
      const definition = tools.get(toolName);
      assert.ok(definition, `${toolName} is registered`);
      const value = await definition.execute(args, {});
      assert.equal(typeof value, 'string', 'tool execute returns a JSON string');
      assert.deepEqual(definition.output.render(args, value), [{ type: 'text', text: value }]);
      return JSON.parse(value);
    },
  };
}

test('resolveConfig applies documented defaults and rejects bad input', () => {
  const config = resolveConfig({});
  assert.equal(config.maintenanceCron, '0 */6 * * *');
  assert.equal(config.retrieval.topK, 20);
  assert.equal(config.context.maxTokens, 4000);
  assert.equal(config.identity.eventTimePolicy, 'content');
  assert.equal(config.briefing, true);
  assert.ok(config.dataDir.endsWith('memory'), 'defaults under the DSH home directory');

  const codeOf = (fn) => {
    let code = null;
    assert.throws(fn, (error) => {
      code = error.code;
      return typeof error.code === 'string' && error.code.startsWith('MEM_E_CONFIG_');
    });
    return code;
  };

  assert.equal(codeOf(() => resolveConfig({ dataDir: '' })), 'MEM_E_CONFIG_OUT_OF_RANGE');
  assert.equal(codeOf(() => resolveConfig({ maintenanceCron: 'every 6 hours' })), 'MEM_E_CONFIG_INVALID_CRON');
  assert.equal(codeOf(() => resolveConfig({ context: { threshold: 2 } })), 'MEM_E_CONFIG_OUT_OF_RANGE');
  assert.equal(codeOf(() => resolveConfig({ identity: { eventTimePolicy: 'wallclock' } })), 'MEM_E_CONFIG_UNKNOWN_ENUM');
  assert.equal(codeOf(() => resolveConfig({ briefing: 'yes' })), 'MEM_E_CONFIG_INVALID_TYPE');
  // The old interval key must fail loudly instead of silently disabling maintenance.
  assert.equal(codeOf(() => resolveConfig({ maintenanceIntervalMinutes: 360 })), 'MEM_E_CONFIG_DEPRECATED');
});

test('an invalid policy is rejected at activation, before any store is created', async () => {
  const dir = tempDir('badpolicy');
  const ctx = fakeCtx();
  try {
    await assert.rejects(
      () => apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false, policy: { candidates: { topK: -1 } } }),
      (error) => error.code === 'MEM_E_INVALID_POLICY',
    );
    assert.equal(ctx.toolsMap.size, 0, 'nothing is registered when activation fails');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply registers six tools and both prompt layers, and dispose removes them', async () => {
  const dir = tempDir('ctx');
  const ctx = fakeCtx();
  try {
    assert.deepEqual(inject, ['tools', 'systemPrompt']);
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    assert.equal(ctx.toolsMap.size, 6, 'the tool surface exists immediately, before the store is ready');
    // Startup is asynchronous; await it the way a caller would.
    await getRuntime(ctx).ready;

    assert.deepEqual([...ctx.toolsMap.keys()].sort(), [
      'memory_admin',
      'memory_checkpoint',
      'memory_forget',
      'memory_recall',
      'memory_reinforce',
      'memory_remember',
    ]);
    assert.ok(ctx.sections.has('memory'));
    assert.ok(ctx.contexts.has('memory-state'));
    assert.match(ctx.contexts.get('memory-state').text(), /Memory gen=/);
  } finally {
    await ctx.dispose();
    assert.equal(ctx.toolsMap.size, 0, 'dispose unregisters every tool');
  }
  rmSync(dir, { recursive: true, force: true });
});

test('the tool surface round-trips a memory through JSON', async () => {
  const dir = tempDir('roundtrip');
  const ctx = fakeCtx();
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false, policy: { activeSet: { minEvents: 1 } } });
    await getRuntime(ctx).ready;
    const now = new Date().toISOString(); // the tool takes the event time from its payload
    const remembered = await ctx.call('memory_remember', {
      content: 'use pnpm -r build before publishing',
      tags: ['preference:tooling', 'habit:release'],
      salience: 0.8,
      happened_at: now,
    });
    assert.equal(remembered.ok, true);
    assert.equal(remembered.status, 'appended');
    assert.equal(remembered.indexed, true, 'the live view serves it before maintenance');
    const eventId = remembered.eventId;

    const recalled = await ctx.call('memory_recall', { text: 'pnpm build publishing', tags: ['habit:release'], top_k: 5 });
    assert.equal(recalled.ok, true);
    assert.ok(['active', 'degraded'].includes(recalled.mode));
    assert.equal(recalled.hits.length, 1);
    assert.equal(recalled.hits[0].eventId, eventId);

    const reinforced = await ctx.call('memory_reinforce', { event_ids: [eventId] });
    assert.deepEqual(reinforced.reinforced, [eventId]);

    const maintained = await ctx.call('memory_admin', { action: 'maintain' });
    assert.match(maintained.maintenance.indexGen, /^gen-\d{6}$/);
    assert.equal(maintained.maintenance.stats.events, 1);

    const active = await ctx.call('memory_admin', { action: 'active_tags' });
    assert.deepEqual(active.entries.map((entry) => entry.tag).sort(), ['habit:release', 'preference:tooling']);
    assert.ok(active.entries.every((entry) => entry.priority >= 0 && entry.priority <= 1), 'priority is a score, not a checkbox');
    assert.equal(active.cap, 200);

    const status = await ctx.call('memory_admin', { action: 'status' });
    assert.match(status.briefing, /habit:release/);

    const forgotten = await ctx.call('memory_forget', { event_ids: [eventId], mode: 'archive', reason: 'plugin test' });
    assert.equal(forgotten.job.status, 'archived');
    assert.equal(forgotten.job.mode, 'archive');

    const hidden = await ctx.call('memory_recall', { text: 'pnpm', top_k: 5 });
    assert.equal(hidden.hits.length, 0, 'the tombstone hides it immediately');
  } finally {
    await ctx.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing tool returns a structured error instead of throwing', async () => {
  const dir = tempDir('errors');
  const ctx = fakeCtx();
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    await getRuntime(ctx).ready;
    // An empty memory is not an error: it is routed to the dead-letter queue so it
    // is counted without overwriting anything.
    const empty = await ctx.call('memory_remember', { content: '' });
    assert.equal(empty.status, 'dead-letter');
    assert.equal(empty.deadLetter, true);

    const outOfRange = await ctx.call('memory_remember', { content: 'x', salience: 7 });
    assert.equal(outOfRange.error.code, 'MEM_E_INVALID_INPUT');

    const unknown = await ctx.call('memory_admin', { action: 'nope' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, 'MEM_E_INVALID_INPUT');

    const missing = await ctx.call('memory_forget', { event_ids: ['ev_nope_0_zzzz'] });
    assert.equal(missing.error.code, 'MEM_E_NOT_FOUND');
    assert.deepEqual(missing.error.details.missing, ['ev_nope_0_zzzz']);
  } finally {
    await ctx.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
