/**
 * Data-directory migration: marker-guarded, count-verified, never destructive.
 *
 * The interrupted case is the important one: a target with data and NO
 * `.migration-complete` marker must refuse to run again, because a second copy over
 * a half-written directory silently blends two stores.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { MIGRATION_MARKER, dataDirHasData, logRecordCount, migrateDataDir, readMigrationState } from '../src/migration.js';
import { Memory } from '../src/memory.js';
import { FakeClock, T0, tempDir } from './helpers.js';

async function sourceStore() {
  const dir = tempDir('mig-src');
  const clock = new FakeClock(T0);
  const memory = await Memory.open({ dataDir: dir, clock });
  await memory.remember({ content: 'first record', happenedAt: T0 - 1000 });
  await memory.remember({ content: 'second record', happenedAt: T0 - 500 });
  memory.close();
  return dir;
}

test('a legacy directory is copied, verified and marked complete', async () => {
  const source = await sourceStore();
  const parent = tempDir('mig-dst');
  const target = path.join(parent, 'memory');
  const clock = new FakeClock(T0);

  const before = await logRecordCount(source);
  assert.equal(before.recordCount, 2);

  const result = await migrateDataDir({ from: source, to: target, clock });
  assert.equal(result.status, 'migrated');
  assert.equal(result.recordCount, 2);

  // Marker written last and carries the same count the business code reports.
  const state = readMigrationState(target);
  assert.equal(state.complete, true);
  assert.equal(state.marker.recordCount, 2);
  assert.equal(state.marker.from, source);
  assert.equal(existsSync(path.join(target, MIGRATION_MARKER)), true);

  const after = await logRecordCount(target);
  assert.equal(after.recordCount, before.recordCount, 'the copy keeps every record');
  assert.equal(after.generation, before.generation, 'the generation pointer is preserved');

  assert.equal(existsSync(source), true, 'the source is kept as a backup');
  rmSync(source, { recursive: true, force: true });
  rmSync(parent, { recursive: true, force: true });
});

test('a completed migration is idempotent (no second copy)', async () => {
  const source = await sourceStore();
  const parent = tempDir('mig-idem');
  const target = path.join(parent, 'memory');
  const clock = new FakeClock(T0);

  await migrateDataDir({ from: source, to: target, clock });
  const again = await migrateDataDir({ from: source, to: target, clock });
  assert.equal(again.status, 'already-migrated');
  assert.equal(dataDirHasData(target), true);

  rmSync(source, { recursive: true, force: true });
  rmSync(parent, { recursive: true, force: true });
});

test('data without a marker is an interrupted migration and refuses to continue', async () => {
  const source = await sourceStore();
  const parent = tempDir('mig-broken');
  const target = path.join(parent, 'memory');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'junk.txt'), 'a half-written copy', 'utf8');
  const clock = new FakeClock(T0);

  await assert.rejects(
    () => migrateDataDir({ from: source, to: target, clock }),
    (error) => error.code === 'MEM_E_CONFIG_MIGRATION_INTERRUPTED',
  );
  assert.equal(existsSync(path.join(target, MIGRATION_MARKER)), false, 'no marker is invented');
  assert.equal(existsSync(path.join(target, 'junk.txt')), true, 'the half-written target is left untouched for inspection');

  rmSync(source, { recursive: true, force: true });
  rmSync(parent, { recursive: true, force: true });
});

test('a source without a log is a mismatch, not an empty success', async () => {
  const source = tempDir('mig-empty');
  const parent = tempDir('mig-nolog');
  const target = path.join(parent, 'memory');
  await assert.rejects(
    () => migrateDataDir({ from: source, to: target, clock: new FakeClock(T0) }),
    (error) => error.code === 'MEM_E_CONFIG_MIGRATION_MISMATCH',
  );
  rmSync(source, { recursive: true, force: true });
  rmSync(parent, { recursive: true, force: true });
});

test('a fresh lock blocks a concurrent migration', async () => {
  const source = await sourceStore();
  const parent = tempDir('mig-lock');
  const target = path.join(parent, 'memory');
  writeFileSync(`${target}.migration.lock`, JSON.stringify({ pid: process.pid, at: T0 }), { flag: 'w' });

  await assert.rejects(
    () => migrateDataDir({ from: source, to: target, clock: new FakeClock(T0) }),
    (error) => error.code === 'MEM_E_CONFIG_MIGRATION_LOCKED',
  );

  rmSync(`${target}.migration.lock`, { force: true });
  rmSync(source, { recursive: true, force: true });
  rmSync(parent, { recursive: true, force: true });
});

test('migration is disabled when no legacy directory is configured', async () => {
  const result = await migrateDataDir({ from: null, to: tempDir('mig-none'), clock: new FakeClock(T0) });
  assert.equal(result.status, 'disabled');
});
