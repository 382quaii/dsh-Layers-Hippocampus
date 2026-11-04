/**
 * v1.5.6 — physical split: the hippocampus core is single-space.
 *
 * Multi-space routing / cross-space transfer now live in `dsh-orchestrator` and are
 * injected through the `orchestrator` Host service. Without it the core:
 *   1. keeps working for the `default` space, byte-identically;
 *   2. refuses every named-space operation with **MEM_E_FEATURE_DISABLED**;
 *   3. advertises `capabilities.spaces=false` and does not register the space tools,
 *      so the client hides the affordances instead of hitting a dead route.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { createOrchestratorStub, fakeCtx, makeMemory, tempDir } from './helpers.js';

test('the engine core works for default and refuses named spaces', async () => {
  const fixture = await makeMemory({ multiSpace: false });
  try {
    const { memory } = fixture;
    const written = await memory.remember({ content: 'default space still works', tags: ['core:default'] });
    assert.ok(written.eventId);
    assert.equal(memory.spaces.status().multiSpace, false);
    assert.deepEqual(memory.spaces.status().ids, ['default']);
    assert.deepEqual(memory.spaces.status().open, []);

    await assert.rejects(
      () => memory.remember({ content: 'nope', tags: ['core:x'], targetSpaceId: 'work' }),
      (error) => error.code === 'MEM_E_FEATURE_DISABLED' && error.details?.spaceId === 'work',
    );
    await assert.rejects(() => memory.createSpace('work'), (error) => error.code === 'MEM_E_FEATURE_DISABLED');
    await assert.rejects(
      () => memory.ensureSpace('work'),
      (error) => error.code === 'MEM_E_FEATURE_DISABLED',
    );
    await assert.rejects(
      () => memory.transferEvents({ eventIds: [written.eventId], targetSpaceId: 'global', userApproved: true }),
      (error) => error.code === 'MEM_E_FEATURE_DISABLED',
    );
  } finally {
    fixture.cleanup();
  }
});

test('without the Orchestrator service the plugin advertises and registers only single-space', async () => {
  const dir = tempDir('single-space-plugin');
  const { ctx, tools, contexts, dispose } = fakeCtx({ orchestrator: false });
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(ctx);
    await runtime.ready;

    const caps = runtime.capabilities();
    assert.equal(caps.spaces, false);
    assert.equal(caps.multiSpace, false);
    assert.equal(caps.crossSpaceTransfer, false);
    assert.ok(!tools.has('memory_space_transfer'), 'the transfer tool is not registered');
    assert.ok(!tools.has('memory_transfer_to_global'), 'the global-transfer tool is not registered');
    assert.equal(tools.size, 8, 'eight single-space tools remain');

    const payload = await runtime.uiPayload();
    assert.equal(payload.capabilities.spaces, false);
    assert.deepEqual(await runtime.spaceList(), ['default']);
    assert.equal(payload.panel.spaces.ids.length, 1);

    // The prompt section must not advertise a capability the core does not have.
    const prompt = [...contexts.values()].map((spec) => String(spec.text?.() ?? '')).join('\n');
    assert.ok(!prompt.includes('space_transfer'), 'no dead tool is advertised to the model');
  } finally {
    dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('injecting the Orchestrator service brings the multi-space surface back', async () => {
  const dir = tempDir('single-space-orch');
  const { ctx, tools, services, dispose } = fakeCtx({ orchestrator: false });
  services.set('orchestrator', createOrchestratorStub());
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    assert.equal(runtime.capabilities().spaces, true);
    assert.equal(runtime.capabilities().crossSpaceTransfer, true);
    assert.equal(tools.size, 10);
    assert.ok(tools.has('memory_space_transfer'));
    const payload = await runtime.uiPayload();
    assert.equal(payload.capabilities.spaces, true);
  } finally {
    dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
