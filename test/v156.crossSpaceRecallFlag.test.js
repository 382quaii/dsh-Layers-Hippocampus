/**
 * v1.5.6 — `features.crossSpaceRecall` (opt-in, default FALSE).
 *
 * Contract:
 *   1. default false: the runtime never aggregates spaces implicitly;
 *   2. true requires multiSpace (contradiction is fail-fast);
 *   3. true + Orchestrator dedupe => `runtime.recall()` returns cross-space hits;
 *   4. false + same setup => the payload stays single-space;
 *   5. the setting is HTTP-editable and rendered in the settings page.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { resolveConfig } from '../src/config.js';
import { EDITABLE_CONFIG_KEYS } from '../src/webRoutes.js';
import { ContentRegistry } from '../../dsh-orchestrator/src/dedupe.js';
import { createOrchestratorStub, fakeCtx, tempDir, T0 } from './helpers.js';

const DAY = 86_400_000;

test('crossSpaceRecall is off by default and fail-fast', () => {
  assert.equal(resolveConfig({}).features.crossSpaceRecall, false);
  assert.equal(resolveConfig({ features: { crossSpaceRecall: true } }).features.crossSpaceRecall, true);
  assert.throws(
    () => resolveConfig({ features: { multiSpace: false, crossSpaceRecall: true } }),
    (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
  );
  assert.throws(
    () => resolveConfig({ features: { crossSpaceRecall: 'yes' } }),
    (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE',
  );
  assert.ok(EDITABLE_CONFIG_KEYS.includes('features.crossSpaceRecall'));
});

async function withRuntime(crossSpaceRecall, body) {
  const dir = tempDir('cross-space-flag');
  const { ctx, services, dispose } = fakeCtx({ orchestrator: false });
  services.set('orchestrator', createOrchestratorStub({ dedupe: new ContentRegistry() }));
  try {
    await apply(ctx, {
      dataDir: dir,
      maintenanceCron: '0 */6 * * *',
      autoMaintainOnBoot: false,
      features: { crossSpaceRecall },
    });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    await body(runtime);
  } finally {
    dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('flag true: recall aggregates every open space', async () => {
  await withRuntime(true, async (runtime) => {
    assert.equal(runtime.capabilities().crossSpaceRecall, true);
    await runtime.createSpace('work');
    await runtime.memory.remember({ content: 'flag token default', tags: ['topic:flag'], eventTime: T0 - 20 * DAY });
    await runtime.memory.remember({ targetSpaceId: 'work', content: 'flag token work', tags: ['topic:flag'], eventTime: T0 - 19 * DAY });
    await runtime.runMaintenance('test');
    await runtime.memory.spaces.run('work', (target) => target.maintain({ reason: 'test' }));
    const result = await runtime.recall({ text: 'flag token', topK: 10 });
    assert.equal(result.mode, 'cross-space');
    assert.equal(result.crossSpace, true);
    assert.ok(result.hits.some((hit) => hit.spaceId === 'work'));
  });
});

test('flag false (default): recall stays single-space', async () => {
  await withRuntime(false, async (runtime) => {
    assert.equal(runtime.capabilities().crossSpaceRecall, false);
    await runtime.createSpace('work');
    await runtime.memory.remember({ content: 'flag token default', tags: ['topic:flag'], eventTime: T0 - 20 * DAY });
    await runtime.memory.remember({ targetSpaceId: 'work', content: 'flag token work', tags: ['topic:flag'], eventTime: T0 - 19 * DAY });
    await runtime.runMaintenance('test');
    await runtime.memory.spaces.run('work', (target) => target.maintain({ reason: 'test' }));
    const result = await runtime.recall({ text: 'flag token', topK: 10 });
    assert.notEqual(result.mode, 'cross-space');
    assert.ok(result.hits.every((hit) => hit.spaceId === undefined));
  });
});
