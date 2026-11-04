/**
 * v1.5.6 — capability flags / microkernel boundary.
 *
 * Locked contracts:
 *   1. with `features.multiSpace=false` the engine is a STRICT single space:
 *      every routed read/write with a non-default target answers
 *      MEM_E_FEATURE_DISABLED, and create/ensure/warmup refuse too;
 *   2. the space tools disappear from the registry AND from the prompt section;
 *   3. `features.crossSpaceTransfer=false` removes transfer tools and makes the
 *      engine transfer refuse before the consent dance;
 *   4. turning multiSpace off implies crossSpaceTransfer off (fail-fast if an
 *      operator explicitly asks for the impossible combination);
 *   5. `Memory.open('/abs/dir')` is the single-space form and `warmup()` is lazy
 *      and read-only.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { resolveConfig } from '../src/config.js';
import { Memory } from '../src/memory.js';
import { createOrchestratorStub, tempDir } from './helpers.js';

function fakeCtx() {
  const tools = new Map();
  const sections = new Map();
  const contexts = new Map();
  const effects = [];
  // v1.5.6: multi-space surface requires the Orchestrator Host service.
  const services = new Map([['orchestrator', createOrchestratorStub()]]);
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
    get(name) {
      return services.get(name) ?? null;
    },
    inject(_deps, callback) {
      callback(ctx);
      return () => {};
    },
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
  return ctx;
}

async function withPlugin(config, run) {
  const dir = tempDir('features');
  const ctx = fakeCtx();
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false, ...config });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    return await run({ ctx, runtime, dir });
  } finally {
    await ctx.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('features config is fail-fast and implies transfer off when multi-space is off', () => {
  const defaults = resolveConfig({});
  assert.deepEqual(defaults.features, { multiSpace: true, crossSpaceTransfer: true, crossSpaceRecall: false });

  const single = resolveConfig({ features: { multiSpace: false } });
  assert.deepEqual(single.features, { multiSpace: false, crossSpaceTransfer: false, crossSpaceRecall: false }, 'implied off');

  assert.throws(
    () => resolveConfig({ features: { multiSpace: false, crossSpaceTransfer: true } }),
    (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
  );
  assert.throws(
    () => resolveConfig({ features: { multiSpace: 'yes' } }),
    (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE',
  );
  assert.throws(
    () => resolveConfig({ features: 'off' }),
    (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE',
  );
});

test('multiSpace=false: engine and capabilities refuse space operations', async () => {
  await withPlugin({ features: { multiSpace: false } }, async ({ ctx, runtime }) => {
    assert.equal(ctx.toolsMap.has('memory_remember'), true);
    assert.equal(ctx.toolsMap.has('memory_space_transfer'), false);
    assert.equal(ctx.toolsMap.has('memory_transfer_to_global'), false);

    await assert.rejects(
      runtime.memory.remember({ content: 'x', tags: ['a'], targetSpaceId: 'work' }),
      (error) => error.code === 'MEM_E_FEATURE_DISABLED',
    );
    await assert.rejects(
      runtime.memory.recall({ text: 'x', targetSpaceId: 'work' }),
      (error) => error.code === 'MEM_E_FEATURE_DISABLED',
    );
    await assert.rejects(runtime.memory.createSpace('work'), (error) => error.code === 'MEM_E_FEATURE_DISABLED');
    await assert.rejects(runtime.memory.ensureSpace('work'), (error) => error.code === 'MEM_E_FEATURE_DISABLED');
    await assert.rejects(runtime.memory.warmup({ targetSpaceId: 'work' }), (error) => error.code === 'MEM_E_FEATURE_DISABLED');
    await assert.rejects(
      runtime.memory.transferEvents({ eventIds: ['e1'], targetSpaceId: 'work', userApproved: true }),
      (error) => error.code === 'MEM_E_FEATURE_DISABLED',
    );

    const payload = await runtime.uiPayload();
    assert.equal(payload.capabilities.multiSpace, false);
    assert.equal(payload.capabilities.spaces, false, 'the client hides the selector/create button');
    assert.deepEqual(runtime.spaceList(), ['default']);
  });
});

test('crossSpaceTransfer=false alone: reads/writes work, transfer is refused', async () => {
  await withPlugin({ features: { crossSpaceTransfer: false } }, async ({ ctx, runtime }) => {
    assert.equal(ctx.toolsMap.has('memory_space_transfer'), false);
    assert.equal(ctx.toolsMap.has('memory_transfer_to_global'), false);
    assert.equal(ctx.toolsMap.has('memory_recall'), true);

    await assert.rejects(
      runtime.memory.transferEvents({ eventIds: ['e1'], targetSpaceId: 'work', userApproved: true }),
      (error) => error.code === 'MEM_E_FEATURE_DISABLED',
    );
    const payload = await runtime.uiPayload();
    assert.equal(payload.capabilities.multiSpace, true);
    assert.equal(payload.capabilities.crossSpaceTransfer, false);
  });
});

test('defaults: space tools + capabilities stay on (no regression)', async () => {
  await withPlugin({}, async ({ ctx, runtime }) => {
    assert.equal(ctx.toolsMap.has('memory_space_transfer'), true);
    assert.equal(ctx.toolsMap.has('memory_transfer_to_global'), true);
    const payload = await runtime.uiPayload();
    assert.equal(payload.capabilities.multiSpace, true);
    assert.equal(payload.capabilities.spaces, true);
    assert.deepEqual(runtime.spaceList(), ['default']);
  });
});

test('Memory.open(string) is the single-space form; warmup is lazy and read-only', async () => {
  const dir = tempDir('warmup');
  try {
    const memory = await Memory.open(dir);
    assert.equal(memory.dataDir, path.resolve(dir));
    const warm = await memory.warmup();
    assert.deepEqual(warm, {
      spaceId: 'default',
      dataDir: path.resolve(dir),
      phase: 'ready',
      indexGeneration: memory.indexManager.generation ?? null,
      events: 0,
    });
    await assert.rejects(memory.warmup({ dataDir: 'relative/dir' }), (error) => error.code === 'MEM_E_INVALID_INPUT');
    await assert.rejects(memory.warmup({ dataDir: path.join(dir, 'elsewhere') }), (error) => error.code === 'MEM_E_INVALID_INPUT');
    memory.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
