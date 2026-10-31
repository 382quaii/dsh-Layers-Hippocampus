/**
 * v1.4.0: raw-turn forensics, spaced repetition, two-phase delete, UI migration.
 * All time goes through FakeClock; migration uses injected copy functions.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { Memory } from '../src/memory.js';
import { MigrationRunner, validateMigrationPaths } from '../src/migrationRunner.js';
import { DAY_MS, FakeClock, makeMemory, T0, tempDir } from './helpers.js';

function rawConfig(rawOverrides = {}) {
  return {
    policy: { identity: { eventTimePolicy: 'explicit' } },
    config: {
      raw: {
        mode: 'salience',
        minSalience: 0.6,
        maxTurnKb: 64,
        maxBytesPerDay: 8,
        maxTotalMb: 256,
        retentionDays: 30,
        maxScanMb: 16,
        ...rawOverrides,
      },
    },
  };
}

// ---- raw turns -------------------------------------------------------------

test('raw gating: salience, code shape, force, and dedupe', async () => {
  const { memory, cleanup } = await makeMemory(rawConfig());
  try {
    const low = await memory.captureRaw({ content: 'just chatting about weather', role: 'user', kind: 'chat', salience: 0.2 });
    assert.equal(low.stored, false, 'low-salience chat is not stored');
    assert.equal(low.reason, 'below-threshold');

    const high = await memory.captureRaw({ content: 'release plan for v1.4.0', role: 'assistant', salience: 0.9 });
    assert.equal(high.stored, true);

    const dup = await memory.captureRaw({ content: 'release plan for v1.4.0', role: 'assistant', salience: 0.9 });
    assert.equal(dup.stored, false);
    assert.equal(dup.reason, 'duplicate');

    const code = await memory.captureRaw({ content: '```js\nconst x = 1;\n```', role: 'assistant', kind: 'chat', salience: 0.1 });
    assert.equal(code.stored, true, 'code shape bypasses the salience gate');
    assert.equal(code.gatedBy, 'code-shape');

    const forced = await memory.captureRaw({ content: 'keep me', kind: 'chat', salience: 0, force: true });
    assert.equal(forced.stored, true);
  } finally {
    cleanup();
  }
});

test('raw truncation and daily budget', async () => {
  const { memory, cleanup } = await makeMemory(rawConfig({ mode: 'all', maxTurnKb: 1024, maxBytesPerDay: 1 }));
  try {
    // No 120+ character alphanumeric runs: the redactor would collapse them and
    // the byte budget would never be reached.
    const big = await memory.captureRaw({ content: 'lorem ipsum '.repeat(60_000), kind: 'chat', force: true });
    assert.equal(big.stored, true);
    const again = await memory.captureRaw({ content: 'dolor sit amet '.repeat(50_000), kind: 'chat', force: true });
    assert.equal(again.stored, false);
    assert.equal(again.reason, 'daily-budget');
    // Truncation is a separate cap: with maxTurnKb far smaller than the content.
    const smallCap = await makeMemory(rawConfig({ mode: 'all', maxTurnKb: 8, maxBytesPerDay: 128 }));
    try {
      const truncated = await smallCap.memory.captureRaw({ content: 'z '.repeat(20_000), kind: 'chat', force: true });
      assert.equal(truncated.stored, true);
      assert.equal(truncated.truncated, true, 'oversized turns are head+tail truncated');
    } finally {
      smallCap.cleanup();
    }
  } finally {
    cleanup();
  }
});

test('deep_raw finds turns, respects the scan budget, and refuses when disabled', async () => {
  const { memory, cleanup } = await makeMemory(rawConfig());
  try {
    await memory.captureRaw({ content: 'alpha needle one', kind: 'chat', salience: 0.9 });
    await memory.captureRaw({ content: 'beta filler', kind: 'chat', salience: 0.9 });
    await memory.captureRaw({ content: 'gamma needle two', kind: 'chat', salience: 0.9 });

    const found = await memory.deepRaw({ text: 'needle', limit: 10 });
    assert.equal(found.mode, 'deep_raw');
    assert.equal(found.hits.length, 2);
    assert.equal(found.truncated, false);

    const windowed = await memory.deepRaw({ text: 'needle', timeFrom: T0 + DAY_MS, limit: 10 });
    assert.equal(windowed.hits.length, 0, 'time window filters shards');

    const tiny = await makeMemory(rawConfig({ maxScanMb: 1 }));
    try {
      // Many moderate turns: the shard exceeds the 1 MB scan budget.
      for (let i = 0; i < 420; i += 1) {
        await tiny.memory.captureRaw({ content: `${i} blah ${'lorem ipsum '.repeat(300)}`, kind: 'chat', force: true });
      }
      const bounded = await tiny.memory.deepRaw({ text: 'blah', limit: 10 });
      assert.equal(bounded.truncated, true, 'budget exhaustion is reported');
    } finally {
      tiny.cleanup();
    }
  } finally {
    cleanup();
  }
});

test('deep_raw is a loud error, not an empty list, when raw is off', async () => {
  const { memory, cleanup } = await makeMemory(rawConfig({ mode: 'off' }));
  try {
    await assert.rejects(() => memory.deepRaw({ text: 'anything' }), (error) => error.code === 'MEM_E_RAW_DISABLED');
  } finally {
    cleanup();
  }
});

// ---- spaced repetition -----------------------------------------------------

test('review schedule: due after each interval, advanced by reinforce', async () => {
  const { memory, clock, cleanup } = await makeMemory(rawConfig());
  try {
    const saved = await memory.remember({ content: 'durable fact', tags: ['topic'], salience: 0.9, happenedAt: T0 });
    let state = memory.reviews.status({ now: T0 });
    assert.equal(state.total, 0, 'no entry before maintenance reconciles');

    const first = memory.reviews.tick({ events: memory.indexManager.snapshot().events, now: T0 });
    assert.equal(first.due.length, 0);
    assert.equal(first.total, 1);

    clock.advance(DAY_MS);
    const due1 = memory.reviews.tick({ events: memory.indexManager.snapshot().events, now: clock.now() });
    assert.equal(due1.due.length, 1, 'due after 1 day');

    // A reinforcement advances to the next interval (2 days from now).
    await memory.reinforce({ eventIds: [saved.eventId] });
    const after = memory.reviews.status({ now: clock.now() });
    assert.equal(after.due, 0);
    assert.equal(after.items[0].step, 1);

    clock.advance(2 * DAY_MS);
    const due2 = memory.reviews.tick({ events: memory.indexManager.snapshot().events, now: clock.now() });
    assert.equal(due2.due.length, 1, 'second interval is 2 days');
  } finally {
    cleanup();
  }
});

// ---- two-phase delete ------------------------------------------------------

test('forget parks for the grace period; restore cancels; maintenance purges after it', async () => {
  const { memory, clock, cleanup } = await makeMemory(rawConfig());
  try {
    const saved = await memory.remember({ content: 'delete me later', tags: ['topic'], salience: 0.8, happenedAt: T0 });
    const parked = await memory.forget({ eventIds: [saved.eventId], reason: 'test' });
    assert.equal(parked.state, 'pending_delete');
    assert.equal(parked.graceHours, 24);

    // Still visible during the grace window.
    const before = await memory.recall({ text: 'delete me later' });
    assert.equal(before.hits.length, 1);

    const cancelled = await memory.restore({ eventIds: [saved.eventId] });
    assert.deepEqual(cancelled.cancelled, [saved.eventId]);

    // Park again and let the grace period expire.
    await memory.forget({ eventIds: [saved.eventId], reason: 'test-2' });
    clock.advance(25 * 60 * 60 * 1000);
    const report = await memory.maintain({ reason: 'purge' });
    assert.equal(report.pendingDeletes.promoted.length, 1);
    const after = await memory.indexManager.snapshot().events;
    assert.equal(after.length, 0, 'the event is gone after the grace period');
  } finally {
    cleanup();
  }
});

// ---- migration -------------------------------------------------------------

test('migration path validation rejects relative, equal, and nested targets', () => {
  assert.throws(() => validateMigrationPaths({ from: 'C:/a', to: 'relative/dir' }), (error) => error.code === 'MEM_E_MIGRATION_PATH');
  assert.throws(() => validateMigrationPaths({ from: 'C:/a', to: 'C:/a' }), (error) => error.code === 'MEM_E_MIGRATION_PATH');
  assert.throws(() => validateMigrationPaths({ from: 'C:/a', to: 'C:/a/nested' }), (error) => error.code === 'MEM_E_MIGRATION_PATH');
});

test('concurrent migrations are blocked by the lock, and a mismatch rolls back', async () => {
  const dir = tempDir('migration');
  const clock = new FakeClock(T0);
  try {
    const source = path.join(dir, 'source');
    const sourceMemory = await Memory.open({ dataDir: source, clock });
    await sourceMemory.remember({ content: 'migration source record', tags: ['topic'], salience: 0.8, happenedAt: T0 });
    await sourceMemory.maintain({ reason: 'seed' });
    sourceMemory.close();

    const target = path.join(dir, 'target');
    const stateFile = path.join(dir, 'state', 'migration.json');
    const runner = new MigrationRunner({ stateFile, clock });
    runner.start({ from: source, to: target, timeoutMs: 30_000 });
    assert.throws(() => runner.start({ from: source, to: target, timeoutMs: 30_000 }), (error) => error.code === 'MEM_E_MIGRATION_LOCKED');
    runner.release();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(fs.existsSync(target), 'the first migration still copies');

    // Mismatch: the copy produces an empty log, so record counts differ.
    const badTarget = path.join(dir, 'bad-target');
    const badRunner = new MigrationRunner({
      stateFile: path.join(dir, 'state', 'bad.json'),
      clock,
      copy: async (from, to) => {
        fs.mkdirSync(to, { recursive: true });
      },
    });
    const result = badRunner.start({ from: source, to: badTarget, timeoutMs: 30_000 });
    assert.equal(result.status, 'running');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const failed = badRunner.read();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, 'MEM_E_MIGRATION_MISMATCH');
    assert.equal(fs.existsSync(badTarget), false, 'the failed target is removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v1.4.0 config: defaults and fail-fast', () => {
  const config = resolveConfig({}, { env: { DSH_HOME: 'C:/dsh' } });
  assert.equal(config.raw.mode, 'salience');
  assert.equal(config.raw.maxTotalMb, 256);
  assert.equal(config.delete.graceHours, 24);
  assert.deepEqual(config.review.intervals, [1, 2, 4, 7, 15, 30]);
  assert.equal(config.migration.timeoutMs, 600_000);
  assert.throws(() => resolveConfig({ raw: { mode: 'sometimes' } }), (error) => error.code === 'MEM_E_CONFIG_UNKNOWN_ENUM');
  assert.throws(() => resolveConfig({ review: { intervals: [1, 4, 2] } }), (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE');
  assert.throws(() => resolveConfig({ delete: { graceHours: 200 } }), (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE');
});
