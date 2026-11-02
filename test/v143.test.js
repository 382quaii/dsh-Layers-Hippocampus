/**
 * v1.4.3 — write-path batching and the deep_raw newest-first fix.
 *
 * Two measurements from the 2026-11-02 handoff drive this file:
 *   1. sequential `remember()` was ~100 events/s because every append rewrote the
 *      ledger, the log manifest and the whole index;
 *   2. `deep_raw` scanned from the HEAD of a shard, so the newest 5000 turns of a
 *      large day file could never be found.
 *
 * The tests below lock the new contracts rather than a wall-clock number: stage/
 * commit separation, one commit per bulk chunk, newest-first scan order with a
 * config budget, dirty-driven briefing, and crash-visible log checkpoints.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { EDITABLE_CONFIG_KEYS, validatePatch } from '../src/webRoutes.js';
import { FakeClock } from '../src/clock.js';
import { Memory } from '../src/memory.js';
import { DAY_MS, T0, makeMemory, tempDir } from './helpers.js';

const DAY = DAY_MS;

function readManifest(dir) {
  const root = path.join(dir, 'log');
  const gen = fs.readFileSync(path.join(root, 'CURRENT'), 'utf8').trim();
  return JSON.parse(fs.readFileSync(path.join(root, gen, 'manifest.json'), 'utf8'));
}

test('raw.maxScanTurns: documented default, fail-fast range, editable over HTTP', () => {
  const config = resolveConfig({});
  assert.equal(config.raw.maxScanTurns, 5000);
  assert.throws(() => resolveConfig({ raw: { maxScanTurns: 100 } }), (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE');
  assert.throws(() => resolveConfig({ raw: { maxScanTurns: 100_000 } }), (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE');
  assert.ok(EDITABLE_CONFIG_KEYS.includes('raw.maxScanTurns'), 'the UI must be able to tune the scan budget');
  assert.deepEqual(validatePatch({ 'raw.maxScanTurns': 8000 }), { raw: { maxScanTurns: 8000 } });
});

test('deep_raw scans newest-first and honours the configured turn budget', async () => {
  const { memory, cleanup } = await makeMemory({ config: { raw: { maxScanTurns: 500, maxResultTokens: 4000 } } });
  try {
    for (let i = 0; i < 600; i += 1) {
      await memory.captureRaw({ content: `raw line ${i} payload`, role: 'user', kind: 'chat', force: true });
    }
    await memory.raw.flush();
    const window = { startTime: T0 - DAY, endTime: T0 + DAY, limit: 20 };

    const newest = await memory.deepRaw({ text: 'raw line 599', ...window });
    assert.equal(newest.hits.length, 1, 'the newest turn is found even though the shard exceeds the budget');
    assert.ok(newest.hits[0].snippet.includes('raw line 599'));
    assert.ok(newest.scanned.turns <= 500);
    assert.equal(newest.budget.maxTurns, 500, 'the budget comes from config, not a hard-coded constant');

    const oldest = await memory.deepRaw({ text: 'raw line 1 ', ...window });
    assert.equal(oldest.hits.length, 0, 'a turn beyond the newest-N window is not scanned');
    assert.equal(oldest.truncated, true);
    assert.ok(oldest.notes.length > 0, 'truncation is explained, never silent');
  } finally {
    cleanup();
  }
});

test('stage builds a record without writing; commitMany writes the batch once', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const before = await memory.logStore.status();
    const plan = await memory.stage({ content: 'staged only', tags: ['batch'], salience: 0.5, happenedAt: T0 });
    assert.equal(plan.status, 'ready');
    assert.equal((await memory.logStore.status()).recordCount, before.recordCount, 'stage performs no log write');

    const [result] = await memory.commitMany([plan]);
    assert.equal(result.status, 'appended');
    assert.equal(result.eventId, plan.record.event_id);
    assert.equal((await memory.logStore.status()).recordCount, before.recordCount + 1);

    const duplicate = await memory.stage({ content: 'staged only', tags: ['batch'], salience: 0.5, happenedAt: T0 });
    assert.equal(duplicate.status, 'duplicate', 'staging is idempotent too');
    const [dup] = await memory.commitMany([duplicate]);
    assert.equal(dup.duplicate, true);
    assert.equal((await memory.logStore.status()).recordCount, before.recordCount + 1, 'a duplicate commits nothing');
  } finally {
    cleanup();
  }
});

test('bulkIngest commits per chunk, preserves results and is immediately readable', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const items = Array.from({ length: 120 }, (_, i) => ({
      content: `bulk fact ${i}`,
      tags: ['bulk'],
      salience: 0.5,
      happenedAt: T0 + i,
    }));
    const first = await memory.bulkIngest(items, { batchSize: 50 });
    assert.deepEqual(
      { batches: first.batches, created: first.created, skipped: first.skipped, failed: first.failed.length },
      { batches: 3, created: 120, skipped: 0, failed: 0 },
    );
    assert.equal((await memory.logStore.status()).recordCount, 120, 'every record reached the log');

    const recalled = await memory.recall({ text: 'bulk fact 119', topK: 5 });
    assert.ok(
      recalled.hits.some((hit) => hit.snippet.includes('bulk fact 119')),
      'read-your-writes: the lazy index fold covers the committed batch',
    );

    const replay = await memory.bulkIngest(items.slice(0, 4), { batchSize: 2 });
    assert.equal(replay.created, 0);
    assert.equal(replay.skipped, 4, 'replays are duplicates, not writes');
    assert.equal((await memory.logStore.status()).recordCount, 120);
  } finally {
    cleanup();
  }
});

test('bulkIngest isolates per-item failures and dead letters', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const result = await memory.bulkIngest(
      [
        { content: 'good one', tags: ['bulk'], happenedAt: T0 },
        { content: '   ', tags: ['bulk'], happenedAt: T0 },
        { content: 'good two', tags: ['bulk'], happenedAt: T0 + 1 },
      ],
      { batchSize: 10 },
    );
    assert.equal(result.created, 2);
    assert.equal(result.skipped, 1, 'empty content becomes a dead letter, not a thrown batch');
    assert.equal(result.failed.length, 0);
  } finally {
    cleanup();
  }
});

test('briefing is dirty-driven and still reflects the latest write', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    memory.briefing(); // warm the cache
    await memory.remember({ content: 'briefing fact', tags: ['brief'], salience: 0.5, happenedAt: T0 });
    const text = memory.briefing();
    assert.ok(text.includes('events=1'), text);
  } finally {
    cleanup();
  }
});

test('log append is buffered: close() checkpoints manifest and fsyncs the shard', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    await memory.remember({ content: 'checkpoint me', tags: ['log'], happenedAt: T0 });
    // Make the deferred window deterministic: cancel the timer, keep the dirty flag
    // (close() must still checkpoint it).
    if (memory.logStore._flushTimer) {
      clearTimeout(memory.logStore._flushTimer);
      memory.logStore._flushTimer = null;
    }
    assert.equal(readManifest(memory.dataDir).recordCount, 0, 'the deferred checkpoint has not run yet');
    memory.close();
    assert.equal(readManifest(memory.dataDir).recordCount, 1, 'close() checkpoints the manifest');
  } finally {
    cleanup();
  }
});

test('a mid-burst crash is visible: bytes beyond the manifest are detectable', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    await memory.remember({ content: 'crash window', tags: ['log'], happenedAt: T0 });
    // Cancel the deferred checkpoint, then simulate a fresh process: the manifest
    // read from disk is stale while the shard file already holds the record.
    const log = memory.logStore;
    if (log._flushTimer) {
      clearTimeout(log._flushTimer);
      log._flushTimer = null;
    }
    log._manifestCache.clear();
    const stale = await log.status();
    assert.equal(stale.recordCount, 0, 'the stale manifest claims nothing was written');
    assert.ok(stale.unflushedBytes > 0, 'the shard size reveals the unflushed tail');
  } finally {
    cleanup();
  }
});

test('a kill inside the 200ms checkpoint window: restart detects it and rebuilds the tail', async () => {
  const dir = tempDir('crash-restart');
  const policy = { activeSet: { minEvents: 1, minMass: 0.01 } };
  const first = await Memory.open({ dataDir: dir, clock: new FakeClock(T0), policy });
  try {
    await first.remember({ content: 'stable record one', tags: ['crash'], happenedAt: T0 });
    await first.maintain({ reason: 'baseline' });
    assert.equal(first.indexManager.snapshot().events.length, 1);

    // Two records land in the page cache after the index publish but before any
    // manifest checkpoint. Cancel the 200ms timer and DO NOT close(): that is the
    // kill window the handoff asked to prove.
    const late1 = await first.remember({ content: 'late record two', tags: ['crash'], happenedAt: T0 + 1 });
    const late2 = await first.remember({ content: 'late record three', tags: ['crash'], happenedAt: T0 + 2 });
    if (first.logStore._flushTimer) {
      clearTimeout(first.logStore._flushTimer);
      first.logStore._flushTimer = null;
    }

    // "Restart": a fresh Memory over the same directory. The persisted manifest still
    // says 1 record, and the persisted index matches it — only the byte-size probe
    // can reveal that two records are missing from both.
    const restarted = await Memory.open({ dataDir: dir, clock: new FakeClock(T0 + 1000), policy });
    try {
      const boot = restarted.bootReport();
      assert.equal(boot.before.status, 'stale', 'the restart must not trust the stale manifest');
      assert.match(boot.before.reason ?? '', /unflushed-bytes/, boot.before.reason ?? '');
      assert.equal(boot.after.status, 'ok');

      const view = restarted.indexManager.snapshot();
      assert.equal(view.events.length, 3, 'the rebuilt index includes the unflushed tail');
      assert.ok(view.events.some((event) => event.eventId === late1.eventId));
      assert.ok(view.events.some((event) => event.eventId === late2.eventId));

      const recalled = await restarted.recall({ text: 'late record three', tags: ['crash'], topK: 5 });
      assert.ok(
        recalled.hits.some((hit) => hit.eventId === late2.eventId),
        'the newest record is retrievable after the crash-restart',
      );
      // The LOG is the truth source: read the file, not the stale manifest. The
      // manifest is repaired by a normal shutdown checkpoint.
      assert.equal((await restarted.logStore.snapshot()).records.length, 3);
    } finally {
      restarted.close();
    }
    first.close();
    assert.equal(readManifest(dir).recordCount, 3, 'a normal shutdown checkpoints the recovered tail');
  } finally {
    first.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
