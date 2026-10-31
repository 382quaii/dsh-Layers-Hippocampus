/**
 * v1.4.0: minimal raw black box, spaced repetition, two-phase delete, migration.
 * All time goes through FakeClock; migration uses injected copy functions.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { Memory } from '../src/memory.js';
import { MemoryError } from '../src/errors.js';
import { MigrationRunner, validateMigrationPaths } from '../src/migrationRunner.js';

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const T0 = NOW;

function rawConfig(rawOverrides = {}) {
  return {
    policy: { identity: { eventTimePolicy: 'explicit' }, delete: { graceHours: 0 } },
    config: {
      raw: {
        mode: 'salience',
        autoCapture: true,
        captureTools: false,
        minSalience: 0.6,
        maxTurnKb: 64,
        maxBytesPerDay: 8,
        maxTotalMb: 256,
        retentionDays: 30,
        maxScanMb: 16,
        maxResultTokens: 1000,
        ...rawOverrides,
      },
    },
  };
}

/** Read raw turns of a data dir (skip tombstone lines). */
function readRawTurns(dir) {
  const rawDir = path.join(dir, 'raw');
  if (!fs.existsSync(rawDir)) return [];
  const turns = [];
  for (const name of fs.readdirSync(rawDir).filter((file) => file.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(rawDir, name), 'utf8').split('\n')) {
      if (!line) continue;
      const record = JSON.parse(line);
      if (record.turn_id && record.content !== undefined) turns.push({ ...record, file: name });
    }
  }
  return turns;
}

async function withMemory(rawOverrides = {}, policyOverrides = {}, run) {
  if (typeof policyOverrides === 'function') {
    run = policyOverrides;
    policyOverrides = {};
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v14-'));
  const { FakeClock } = await import('./helpers.js');
  const clock = new FakeClock(NOW);
  const config = rawConfig(rawOverrides);
  const policy = { ...config.policy, ...policyOverrides };
  const memory = await Memory.open({ dataDir: dir, clock, policy, config: config.config });
  try {
    return await run({ memory, dir, clock });
  } finally {
    memory.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- raw: minimal schema ---------------------------------------------------

test('raw_turn is exactly four fields: turn_id, timestamp, role, content', async () => {
  await withMemory({}, async ({ memory, dir }) => {
    const result = await memory.captureRaw({ content: 'exactly four fields', role: 'assistant', force: true });
    assert.equal(result.stored, true);
    assert.equal(result.queued, true);
    await memory.raw.flush();
    const turns = readRawTurns(dir);
    assert.equal(turns.length, 1);
    assert.deepEqual(Object.keys(turns[0]).filter((key) => key !== 'file').sort(), ['content', 'role', 'timestamp', 'turn_id']);
    assert.equal(turns[0].content, 'exactly four fields');
    assert.equal(turns[0].role, 'assistant');
  });
});

test('raw gating: salience, code shape, force, dedupe, truncation', async () => {
  await withMemory({}, async ({ memory }) => {
    const low = await memory.captureRaw({ content: 'just chatting about weather', role: 'user', kind: 'chat', salience: 0.2 });
    assert.equal(low.stored, false);
    assert.equal(low.reason, 'below-threshold');

    const high = await memory.captureRaw({ content: 'release plan for v1.4.0', role: 'assistant', salience: 0.9 });
    assert.equal(high.stored, true);
    const dup = await memory.captureRaw({ content: 'release plan for v1.4.0', role: 'assistant', salience: 0.9 });
    assert.equal(dup.stored, false);
    assert.equal(dup.reason, 'duplicate');

    const code = await memory.captureRaw({ content: '```js\nconst x = 1;\n```', role: 'assistant', kind: 'chat', salience: 0.1 });
    assert.equal(code.stored, true);
    const forced = await memory.captureRaw({ content: 'keep me', kind: 'chat', salience: 0, force: true });
    assert.equal(forced.stored, true);
    await memory.raw.flush();
  });
});

test('oversized turns keep head+tail under the marker', async () => {
  await withMemory({ maxTurnKb: 8 }, async ({ memory, dir }) => {
    await memory.captureRaw({ content: `${'a '.repeat(20_000)}TAIL`, kind: 'chat', force: true });
    await memory.raw.flush();
    const [turn] = readRawTurns(dir);
    assert.match(turn.content, /…\[truncated\]…/);
    assert.ok(turn.content.endsWith('TAIL'));
  });
});

test('daily budget rejects further turns with a reason', async () => {
  await withMemory({ maxTurnKb: 1024, maxBytesPerDay: 1 }, async ({ memory }) => {
    const first = await memory.captureRaw({ content: 'lorem ipsum '.repeat(60_000), kind: 'chat', force: true });
    assert.equal(first.stored, true);
    const second = await memory.captureRaw({ content: 'dolor sit amet '.repeat(50_000), kind: 'chat', force: true });
    assert.equal(second.stored, false);
    assert.equal(second.reason, 'daily-budget');
    await memory.raw.flush();
  });
});

// ---- raw: deep_raw constraints --------------------------------------------

test('deep_raw requires start_time and end_time (fail-fast)', async () => {
  await withMemory({}, async ({ memory }) => {
    await assert.rejects(
      () => memory.deepRaw({ text: 'anything' }),
      (error) => error.code === 'MEM_E_INVALID_INPUT' && /start_time/.test(error.message),
    );
  });
});

test('deep_raw finds turns with line addressing and a time window', async () => {
  await withMemory({}, async ({ memory }) => {
    await memory.captureRaw({ content: 'alpha needle one', kind: 'chat', salience: 0.9 });
    await memory.captureRaw({ content: 'beta filler', kind: 'chat', salience: 0.9 });
    await memory.captureRaw({ content: 'gamma needle two', kind: 'chat', salience: 0.9 });

    const found = await memory.deepRaw({ text: 'needle', startTime: T0 - DAY_MS, endTime: T0 + DAY_MS, limit: 10 });
    assert.equal(found.hits.length, 2);
    assert.equal(found.truncated, false);
    assert.ok(found.hits.every((hit) => Number.isInteger(hit.line) && hit.line > 0));
    assert.equal(found.hits[0].shard.endsWith('.jsonl'), true);

    const windowed = await memory.deepRaw({ text: 'needle', startTime: T0 + 1, endTime: T0 + 2, limit: 10 });
    assert.equal(windowed.hits.length, 0, 'timestamp outside the window is not returned');
  });
});

test('deep_raw token budget truncates and says so', async () => {
  await withMemory({ maxResultTokens: 50 }, async ({ memory }) => {
    for (let index = 0; index < 5; index += 1) {
      await memory.captureRaw({ content: `${index} ${'needle detail '.repeat(100)}`, kind: 'chat', force: true });
    }
    const result = await memory.deepRaw({ text: 'needle', startTime: T0 - DAY_MS, endTime: T0 + DAY_MS, limit: 100 });
    assert.equal(result.truncated, true);
    assert.ok(result.notes.some((note) => note.includes('预算限制')));
    assert.ok(result.budget.tokensUsed <= 50 + 1);
  });
});

test('deep_raw is a loud error, not an empty list, when raw is off', async () => {
  await withMemory({ mode: 'off' }, async ({ memory }) => {
    await assert.rejects(
      () => memory.deepRaw({ text: 'anything', startTime: 0, endTime: T0 }),
      (error) => error.code === 'MEM_E_RAW_DISABLED',
    );
  });
});

// ---- raw: read-side redaction ---------------------------------------------

test('disk keeps plaintext, deep_raw returns redacted snippets', async () => {
  await withMemory({ mode: 'all' }, async ({ memory, dir }) => {
    const secret = 'sk-1234567890abcdefghijklmnop';
    await memory.captureRaw({ content: `api key is ${secret} keep it local`, kind: 'chat', force: true });
    await memory.raw.flush();
    const raw = fs.readFileSync(path.join(dir, 'raw', fs.readdirSync(path.join(dir, 'raw'))[0]), 'utf8');
    assert.ok(raw.includes(secret), 'black box stores plaintext');

    const result = await memory.deepRaw({ text: 'api key', startTime: T0 - DAY_MS, endTime: T0 + DAY_MS });
    assert.equal(result.hits.length, 1);
    assert.ok(result.hits[0].snippet.includes('[redacted]'));
    assert.equal(result.hits[0].snippet.includes(secret), false);
  });
});

// ---- raw: tombstones -------------------------------------------------------

test('forget appends a raw tombstone and deep_raw can no longer return the text', async () => {
  await withMemory({ mode: 'all' }, { delete: { graceHours: 0 } }, async ({ memory, dir }) => {
    const saved = await memory.remember({ content: 'the deploy window is friday night', tags: ['ops'], salience: 0.9, happenedAt: T0 });
    await memory.captureRaw({ content: 'the deploy window is friday night', role: 'assistant', kind: 'chat', force: true });
    await memory.raw.flush();

    const before = await memory.deepRaw({ text: 'deploy window', startTime: T0 - DAY_MS, endTime: T0 + DAY_MS });
    assert.equal(before.hits.length, 1);

    await memory.forget({ eventIds: [saved.eventId], reason: 'tombstone-test' });
    const raws = fs.readFileSync(path.join(dir, 'raw', fs.readdirSync(path.join(dir, 'raw'))[0]), 'utf8');
    assert.match(raws, /raw_tombstone/);

    const after = await memory.deepRaw({ text: 'deploy window', startTime: T0 - DAY_MS, endTime: T0 + DAY_MS });
    assert.equal(after.hits.length, 0, 'tombstoned content is skipped');
    assert.ok(after.scanned.tombstonesSkipped >= 1);
  });
});

// ---- raw: TTL --------------------------------------------------------------

test('TTL removes old shards but never today, even at the edge', async () => {
  await withMemory({ retentionDays: 1 }, async ({ memory, dir }) => {
    const rawDir = path.join(dir, 'raw');
    fs.mkdirSync(rawDir, { recursive: true });
    const today = new Date(T0).toISOString().slice(0, 10);
    const oldDay = new Date(T0 - 2 * DAY_MS).toISOString().slice(0, 10);
    const todayFile = path.join(rawDir, `${today}.jsonl`);
    const oldFile = path.join(rawDir, `${oldDay}.jsonl`);
    fs.writeFileSync(todayFile, '{"turn_id":"t1","timestamp":1,"role":"user","content":"today"}\n');
    fs.writeFileSync(oldFile, '{"turn_id":"t2","timestamp":1,"role":"user","content":"old"}\n');

    const report = await memory.raw.prune({ now: T0 });
    assert.deepEqual(report.removed, [oldDay]);
    assert.ok(fs.existsSync(todayFile), 'the file being written today is never deleted');
    assert.equal(fs.existsSync(oldFile), false);
  });
});

// ---- spaced repetition -----------------------------------------------------

test('review schedule: due after each interval, advanced by reinforce', async () => {
  await withMemory({}, async ({ memory, clock }) => {
    const saved = await memory.remember({ content: 'durable fact', tags: ['topic'], salience: 0.9, happenedAt: T0 });
    const first = memory.reviews.tick({ events: memory.indexManager.snapshot().events, now: T0 });
    assert.equal(first.due.length, 0);
    assert.equal(first.total, 1);

    clock.advance(DAY_MS);
    const due1 = memory.reviews.tick({ events: memory.indexManager.snapshot().events, now: clock.now() });
    assert.equal(due1.due.length, 1, 'due after 1 day');

    await memory.reinforce({ eventIds: [saved.eventId] });
    const after = memory.reviews.status({ now: clock.now() });
    assert.equal(after.due, 0);
    assert.equal(after.items[0].step, 1);

    clock.advance(2 * DAY_MS);
    const due2 = memory.reviews.tick({ events: memory.indexManager.snapshot().events, now: clock.now() });
    assert.equal(due2.due.length, 1, 'second interval is 2 days');
  });
});

// ---- two-phase delete ------------------------------------------------------

test('forget parks for the grace period; restore cancels; maintenance purges after it', async () => {
  await withMemory({}, { delete: { graceHours: 24 } }, async ({ memory, clock }) => {
    const saved = await memory.remember({ content: 'delete me later', tags: ['topic'], salience: 0.8, happenedAt: T0 });
    const parked = await memory.forget({ eventIds: [saved.eventId], reason: 'test' });
    assert.equal(parked.state, 'pending_delete');
    assert.equal(parked.graceHours, 24);

    const cancelled = await memory.restore({ eventIds: [saved.eventId] });
    assert.deepEqual(cancelled.cancelled, [saved.eventId]);

    await memory.forget({ eventIds: [saved.eventId], reason: 'test-2' });
    clock.advance(25 * HOUR_MS);
    const report = await memory.maintain({ reason: 'purge' });
    assert.equal(report.pendingDeletes.promoted.length, 1);
    const after = await memory.indexManager.snapshot().events;
    assert.equal(after.length, 0, 'the event is gone after the grace period');
  });
});

// ---- migration -------------------------------------------------------------

test('migration path validation rejects relative, equal, and nested targets', () => {
  assert.throws(() => validateMigrationPaths({ from: 'C:/a', to: 'relative/dir' }), (error) => error.code === 'MEM_E_MIGRATION_PATH');
  assert.throws(() => validateMigrationPaths({ from: 'C:/a', to: 'C:/a' }), (error) => error.code === 'MEM_E_MIGRATION_PATH');
  assert.throws(() => validateMigrationPaths({ from: 'C:/a', to: 'C:/a/nested' }), (error) => error.code === 'MEM_E_MIGRATION_PATH');
});

test('concurrent migrations are blocked by the lock, and a mismatch rolls back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mig-'));
  try {
    const { FakeClock } = await import('./helpers.js');
    const clock = new FakeClock(T0);
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
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.ok(fs.existsSync(target), 'the first migration still copies');

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
    await new Promise((resolve) => setTimeout(resolve, 250));
    const failed = badRunner.read();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.code, 'MEM_E_MIGRATION_MISMATCH');
    assert.equal(fs.existsSync(badTarget), false, 'the failed target is removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- config ----------------------------------------------------------------

test('v1.4.0 config: defaults and fail-fast', () => {
  const config = resolveConfig({}, { env: { DSH_HOME: 'C:/dsh' } });
  assert.equal(config.raw.mode, 'salience');
  assert.equal(config.raw.maxTotalMb, 256);
  assert.equal(config.raw.maxResultTokens, 1000);
  assert.equal(config.delete.graceHours, 24);
  assert.deepEqual(config.review.intervals, [1, 2, 4, 7, 15, 30]);
  assert.equal(config.migration.timeoutMs, 600_000);
  assert.throws(() => resolveConfig({ raw: { mode: 'sometimes' } }), (error) => error.code === 'MEM_E_CONFIG_UNKNOWN_ENUM');
  assert.throws(() => resolveConfig({ review: { intervals: [1, 4, 2] } }), (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE');
  assert.throws(() => resolveConfig({ delete: { graceHours: 200 } }), (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE');
});
