/**
 * UI panel contract: `memory_admin action=status` renders this shape.
 *
 * The snapshot test is deliberate — adding or renaming a panel field is a breaking
 * change for the panel renderer, so it must fail here first and be updated on
 * purpose, not slip through.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeClock, T0, makeMemory, tempDir } from './helpers.js';

const PANEL_KEYS = [
  'generatedAt',
  'global',
  'tokens',
  'storage',
  'maintenance',
  'generations',
  'graph',
  'raw',
  'reviews',
  'pendingDeletes',
].sort();

test('the status panel has the full documented shape', async () => {
  const { memory, cleanup } = await makeMemory({ config: { maintenanceCron: '0 */6 * * *' } });
  try {
    const status = await memory.status();
    const panel = status.panel;

    assert.deepEqual(Object.keys(panel).sort(), PANEL_KEYS);
    assert.deepEqual(Object.keys(panel.global).sort(), ['activeTags', 'events', 'semanticSummaries', 'tempQuarantined']);
    assert.deepEqual(Object.keys(panel.tokens).sort(), [
      'contextMaxTokens',
      'contextTokens',
      'cumulativeSavedTokens',
      'evictedBlocks',
    ]);
    assert.deepEqual(Object.keys(panel.storage).sort(), ['dataDir', 'diskBytes']);
    assert.deepEqual(Object.keys(panel.maintenance).sort(), [
      'lastSuccessAt',
      'maintenanceCron',
      'nextRunAt',
      'queuedDeletes',
      'running',
    ]);
    assert.deepEqual(Object.keys(panel.generations).sort(), [
      'indexGen',
      'indexGeneration',
      'logGen',
      'logGeneration',
    ]);

    // Values, not just keys.
    assert.equal(panel.generatedAt, T0);
    assert.equal(panel.global.events, 0);
    assert.equal(panel.storage.dataDir, memory.dataDir);
    assert.equal(panel.maintenance.maintenanceCron, '0 */6 * * *');
    assert.equal(panel.maintenance.running, false);
    assert.equal(panel.maintenance.queuedDeletes, 0);
    assert.equal(panel.maintenance.lastSuccessAt, null);
    assert.equal(typeof panel.maintenance.nextRunAt, 'number');
    assert.ok(panel.maintenance.nextRunAt > T0, 'next run is in the future');
    assert.equal(panel.generations.logGen, 'gen-000001', 'opening the store materialises generation 1');
    assert.equal(panel.generations.logGeneration, 1);
    assert.equal(panel.generations.indexGen, 'gen-000001', 'boot publishes an index generation (empty store)');
    assert.equal(panel.generations.indexGeneration, 1);
    assert.equal(panel.tokens.cumulativeSavedTokens, 0);
  } finally {
    cleanup();
  }
});

test('the panel follows writes: events, generations and last success', async () => {
  const { memory, clock, cleanup } = await makeMemory({ config: { maintenanceCron: '0 */6 * * *' } });
  try {
    await memory.remember({ content: 'alpha briefing', happenedAt: T0 - 1000, tags: ['preference'] });
    await memory.remember({ content: 'beta choice', happenedAt: T0 - 500, tags: ['preference'] });

    let panel = (await memory.status()).panel;
    assert.equal(panel.global.events, 2, 'new events are counted before maintenance folds them');
    assert.equal(panel.generations.logGeneration, 1);
    const indexGenerationsBefore = panel.generations.indexGeneration;

    clock.advance(60_000);
    await memory.maintain({ reason: 'manual' });

    panel = (await memory.status()).panel;
    assert.equal(panel.global.events, 2);
    assert.equal(panel.global.activeTags, 1);
    assert.match(panel.generations.indexGen, /^gen-\d{6}$/);
    assert.equal(
      panel.generations.indexGeneration,
      indexGenerationsBefore + 1,
      'each rebuild publishes exactly one new generation',
    );
    assert.equal(panel.maintenance.lastSuccessAt, clock.now());
    assert.ok(panel.storage.diskBytes > 0, 'the data directory is measured, not assumed');
  } finally {
    cleanup();
  }
});

test('cumulative saved tokens are the sum of evicted blocks and survive a reopen', async () => {
  const dir = tempDir('panel-tokens');
  const first = await makeMemory({ dir, config: { context: { maxTokens: 120 } } });
  try {
    first.memory.context.inject({ id: 'b1', text: 'x'.repeat(400), tags: ['preference'], salience: 0.1 });
    first.memory.context.inject({ id: 'b2', text: 'y'.repeat(400), tags: ['preference'], salience: 0.1 });
    first.memory.context.enforce();
    const panel = (await first.memory.status()).panel;
    assert.ok(panel.tokens.evictedBlocks > 0, 'the window evicted something');
    assert.ok(panel.tokens.cumulativeSavedTokens > 0);
    assert.equal(panel.tokens.contextMaxTokens, 120);
    first.memory.close();

    // The accumulator is derived state persisted at eviction time, not recomputed.
    const second = await makeMemory({ dir, config: { context: { maxTokens: 120 } } });
    try {
      const after = (await second.memory.status()).panel;
      assert.equal(after.tokens.cumulativeSavedTokens, panel.tokens.cumulativeSavedTokens);
      assert.equal(after.tokens.evictedBlocks, panel.tokens.evictedBlocks);
    } finally {
      second.cleanup();
    }
  } finally {
    first.cleanup();
  }
});

test('queued deletes come from the delete pipeline, not a separate counter', async () => {
  const { memory, cleanup } = await makeMemory({ config: { maintenanceCron: '0 */6 * * *' } });
  try {
    const event = await memory.remember({ content: 'to be purged', happenedAt: T0 - 1000 });
    const job = await memory.deletePipeline.request({ eventIds: [event.eventId], mode: 'purge', reason: 'test' });
    const status = await memory.status();
    // The panel reads the pipeline's own pending set; there is no second counter to drift.
    assert.equal(status.panel.maintenance.queuedDeletes, status.deletes.queued);
    assert.equal(status.deletes.total, 1);
    assert.equal(job.status, 'done');
    assert.equal(status.panel.maintenance.queuedDeletes, 0, 'a finished job is not queued work');
  } finally {
    cleanup();
  }
});
