/**
 * v1.6.1 — raw archive/index observability on /stats (panel.raw).
 *
 * The panel must always carry the raw archive + sparse-index fields, even when no
 * archive exists yet, and the settings card must render them without crashing on an
 * older host that omits them.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { RAW_DIR } from '../src/rawStore.js';
import { fakeCtx, tempDir } from './helpers.js';

test('panel.raw always reports archive + index fields', async () => {
  const dir = tempDir('stats-raw');
  const fixture = fakeCtx();
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    const payload = await runtime.uiPayload();
    const raw = payload.panel.raw;
    assert.equal(raw.shards, 0);
    assert.equal(raw.indexedShards, 0);
    assert.equal(raw.archiveCount, 0);
    assert.equal(raw.archivedBytes, 0);
    assert.equal(raw.totalBytes, 0);
    assert.deepEqual(raw.engines, { brotli: 0, gzip: 0, zstd: 0 });
    assert.equal(raw.compressionRatio, null, 'no archive yet = unknown, not 0');
    assert.ok(Array.isArray(raw.archiveMonths));
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an archived month and an indexed shard are visible on the panel', async () => {
  const dir = tempDir('stats-raw-2');
  const fixture = fakeCtx();
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    // Write one plaintext shard + build its sparse index.
    fs.mkdirSync(path.join(dir, RAW_DIR), { recursive: true });
    const day = '2026-01-05';
    fs.writeFileSync(
      path.join(dir, RAW_DIR, `${day}.jsonl`),
      `${JSON.stringify({ turn_id: 't1', timestamp: Date.UTC(2026, 0, 5), role: 'user', content: 'a' })}\n`,
    );
    await runtime.memory.raw.ensureIndexes();
    const payload = await runtime.uiPayload();
    const raw = payload.panel.raw;
    assert.equal(raw.shards, 1);
    assert.equal(raw.indexedShards, 1);
    assert.ok(raw.archiveCount >= 0);
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a real cold archive shows count, engine distribution and compression ratio', async () => {
  const dir = tempDir('stats-raw-3');
  const fixture = fakeCtx();
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    const realRaw = runtime.memory.raw;
    fs.mkdirSync(path.join(dir, RAW_DIR), { recursive: true });
    // 120 days before the injected clock: older than archiveAfterDays(90).
    const now = runtime.memory.clock.now();
    const day = new Date(now - 120 * 86_400_000).toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(dir, RAW_DIR, `${day}.jsonl`),
      `${JSON.stringify({ turn_id: 'old1', timestamp: now - 120 * 86_400_000, role: 'user', content: 'cold payload '.repeat(20) })}\n`,
    );
    const archived = await realRaw.archiveCold({ now });
    assert.ok(archived.archived.length === 1, `archived=${JSON.stringify(archived)}`);
    const payload = await runtime.uiPayload();
    const raw = payload.panel.raw;
    assert.equal(raw.archiveCount, 1);
    assert.equal(raw.engines.brotli, 1);
    assert.ok(raw.archivedBytes > 0);
    assert.ok(raw.compressionRatio !== null && raw.compressionRatio > 0);
    assert.ok(raw.savedBytes > 0, 'archive bytesBefore/bytesAfter are recorded');
    // Month-detail rows power the expandable list in the panel.
    assert.equal(raw.archiveMonths.length, 1);
    const monthRow = raw.archiveMonths[0];
    assert.equal(monthRow.month, day.slice(0, 7));
    assert.equal(monthRow.engine, 'brotli');
    assert.ok(monthRow.bytes > 0);
    assert.ok(Number.isFinite(monthRow.at), 'archive timestamp is reported');
    assert.ok(monthRow.bytesBefore > monthRow.bytesAfter, 'before/after bytes are reported per month');
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
