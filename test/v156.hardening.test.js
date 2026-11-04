/**
 * v1.5.6 hardening batch (no version bump): recall payload cap, close() release,
 * event-loop lag monitor.
 *
 * Locked contracts:
 *   1. one recall's JSON payload is capped by `context.maxInjectTokens`; the cut is
 *      loud (`truncated`, `payload.dropped`, a `payload-budget` note), never silent;
 *   2. `Memory.close()` persists queued raw turns synchronously, clears the flush
 *      timer, detaches the scheduler and releases the index views; idempotent;
 *   3. maintenance measures event-loop lag and reports `eventLoop` numbers, and
 *      yields between phases once the lag crosses the threshold.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { createLagMonitor } from '../src/eventLoop.js';
import { T0, makeMemory } from './helpers.js';

const DAY = new Date(T0).toISOString().slice(0, 10);

test('recall payload is capped by context.maxInjectTokens and reports the drop', async () => {
  const fixture = await makeMemory({ config: { context: { maxInjectTokens: 300 } } });
  try {
    for (let index = 0; index < 6; index += 1) {
      // No long base64-alphabet runs: the media guard must not fire on prose.
      await fixture.memory.remember({
        content: `needle ${index}：这是一段用于召回预算测试的长记忆内容，包含错误排查与发布门禁的细节，重复填充以便超过单次注入预算。`.repeat(3),
        tags: ['topic:payload'],
        salience: 0.9,
        eventTime: T0 + index * 1000,
      });
    }
    const result = await fixture.memory.recall({ text: 'needle', topK: 6 });

    assert.ok(result.hits.length < 6, 'a 300-token budget cannot carry six long hits');
    assert.equal(result.truncated, true);
    assert.equal(result.payload.maxTokens, 300);
    assert.ok(result.payload.dropped >= 1);
    assert.ok(result.notes.some((note) => note.includes('payload-budget')));
    assert.ok(result.payload.estimatedTokens <= 400, 'estimate stays near the budget (one oversized first hit may exceed)');
  } finally {
    fixture.cleanup();
  }
});

test('recall payload under the budget is untouched (no truncated flag, nothing dropped)', async () => {
  const fixture = await makeMemory({ config: { context: { maxInjectTokens: 4000 } } });
  try {
    await fixture.memory.remember({ content: 'needle one', tags: ['topic:small'], eventTime: T0 });
    await fixture.memory.remember({ content: 'needle two', tags: ['topic:small'], eventTime: T0 + 1000 });
    const result = await fixture.memory.recall({ text: 'needle', topK: 2 });

    assert.equal(result.payload.dropped, 0);
    assert.equal(result.truncated, undefined);
    assert.ok(result.payload.estimatedTokens > 0);
  } finally {
    fixture.cleanup();
  }
});

test('maxInjectTokens is fail-fast validated and defaults to 4000', () => {
  assert.equal(resolveConfig({}).context.maxInjectTokens, 4000);
  assert.equal(resolveConfig({ context: { maxInjectTokens: 2000 } }).context.maxInjectTokens, 2000);
  assert.throws(
    () => resolveConfig({ context: { maxInjectTokens: 100 } }),
    (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
  );
  assert.throws(
    () => resolveConfig({ context: { maxInjectTokens: 200_000 } }),
    (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
  );
});

test('Memory.close persists queued raw turns, clears the flush timer and releases views', async () => {
  const fixture = await makeMemory();
  try {
    await fixture.memory.captureRaw({ content: 'queued turn one', role: 'user', kind: 'chat', force: true });
    await fixture.memory.captureRaw({ content: 'queued turn two', role: 'assistant', kind: 'chat', force: true });
    assert.ok(fixture.memory.raw._flushTimer, 'the flush timer is armed while a turn is queued');

    fixture.memory.close();

    assert.equal(fixture.memory.raw._flushTimer, null, 'close() must clear the flush timer');
    const shard = fs.readFileSync(path.join(fixture.dir, 'raw', `${DAY}.jsonl`), 'utf8');
    assert.match(shard, /queued turn one/);
    assert.match(shard, /queued turn two/);
    assert.ok(!fixture.memory._scheduler);
    assert.equal(fixture.memory.indexManager._active, null, 'the index view is released');
    assert.deepEqual(fixture.memory.indexManager._records, []);

    // Idempotent: a second close must not throw or truncate the shard.
    fixture.memory.close();
    assert.match(fs.readFileSync(path.join(fixture.dir, 'raw', `${DAY}.jsonl`), 'utf8'), /queued turn two/);
  } finally {
    try {
      fixture.cleanup();
    } catch {
      /* the fixture was closed on purpose */
    }
  }
});

test('lag monitor yields after a delayed loop and maintenance reports its numbers', async () => {
  const monitor = createLagMonitor({ thresholdMs: 40, sleepMs: 5 });
  try {
    // Let the histogram take its first sample before the deliberate block; a monitor
    // that has not started sampling cannot attribute the delay.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const startedAt = Date.now();
    while (Date.now() - startedAt < 120) {
      /* deliberately block the loop */
    }
    // Give the sampler a turn to record the block.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const before = monitor.snapshot();
    assert.ok(before.maxMs >= 40, `measured max ${before.maxMs}ms before the yield`);
    assert.equal(await monitor.yieldIfLagging(), true, 'a 120ms block must trigger a yield');
    assert.equal(monitor.yields, 1);
    const snapshot = monitor.stop();
    assert.equal(snapshot.yields, 1);
    assert.equal(snapshot.thresholdMs, 40);
  } finally {
    monitor.stop();
  }

  const fixture = await makeMemory();
  try {
    await fixture.memory.remember({ content: 'one episode', tags: ['topic:lag'], eventTime: T0 });
    const report = await fixture.memory.maintain({ reason: 'test-lag' });
    assert.ok(report.eventLoop, 'maintenance report carries eventLoop');
    assert.equal(typeof report.eventLoop.maxMs, 'number');
    assert.equal(typeof report.eventLoop.p99Ms, 'number');
    assert.ok(report.eventLoop.yields >= 0);
  } finally {
    fixture.cleanup();
  }
});
