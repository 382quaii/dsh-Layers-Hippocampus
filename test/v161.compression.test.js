/**
 * v1.6.1 — compression-engine selection (gzip default, zstd optional).
 *
 * Zstd is NOT a dependency: modern Node exposes it in `node:zlib`. The plugin
 * probes the runtime, falls back to gzip when unavailable, and keeps archives of
 * BOTH formats readable (dispatch is by extension).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { RawStore, RAW_DIR } from '../src/rawStore.js';
import { COMPRESSION_ENGINES, probeCompression, resolveEngine } from '../src/compression.js';
import { FakeClock, T0, tempDir } from './helpers.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 2, 15);

function makeStore({ engine = 'gzip' } = {}) {
  const dir = tempDir('compression');
  const clock = new FakeClock(NOW);
  const store = new RawStore({
    dataDir: dir,
    clock,
    getConfig: () => ({ raw: { mode: 'all', retentionDays: 90, archiveAfterDays: 7, compressionEngine: engine } }),
  });
  fs.mkdirSync(path.join(dir, RAW_DIR), { recursive: true });
  return { dir, store };
}

function writeShard(dir, day, content) {
  const file = path.join(dir, RAW_DIR, `${day}.jsonl`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ turn_id: 't1', timestamp: Date.parse(day), role: 'user', content })}\n`,
  );
  return file;
}

test('the runtime probe reports which engines this Node can do', () => {
  const probe = probeCompression();
  assert.equal(probe.gzip, true);
  assert.equal(typeof probe.zstd, 'boolean');
  assert.match(String(probe.node), /^v\d+/);
  const fallback = resolveEngine('zstd', { gzip: true, zstd: false, node: 'v20.0.0' });
  assert.equal(fallback.engine, 'gzip');
  assert.equal(fallback.fallback, true);
  assert.ok(COMPRESSION_ENGINES.includes('gzip') && COMPRESSION_ENGINES.includes('zstd'));
});

test('zstd archives are written with .jsonl.zst and read back by extension', async (t) => {
  if (!probeCompression().zstd) {
    t.skip('this Node runtime has no built-in zstd');
    return;
  }
  const { dir, store } = makeStore({ engine: 'zstd' });
  try {
    writeShard(dir, '2026-01-05', 'zstd cold needle');
    const result = await store.archiveCold({ now: NOW });
    assert.deepEqual(result.archived, ['2026-01']);
    assert.equal(result.engine, 'zstd');
    const archive = path.join(dir, RAW_DIR, 'raw-archive-2026-01.jsonl.zst');
    assert.ok(fs.existsSync(archive), 'zstd archive exists');
    assert.ok(!fs.existsSync(path.join(dir, RAW_DIR, '2026-01-05.jsonl')), 'plaintext removed');
    const scan = await store.scan({
      text: 'needle',
      startTime: Date.UTC(2026, 0, 1),
      endTime: Date.UTC(2026, 0, 31),
      limit: 5,
    });
    assert.equal(scan.hits.length, 1);
    assert.equal(scan.hits[0].archive, 'raw-archive-2026-01.jsonl.zst');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy gzip archive stays readable after switching to zstd', async (t) => {
  if (!probeCompression().zstd) {
    t.skip('this Node runtime has no built-in zstd');
    return;
  }
  const { dir, store } = makeStore({ engine: 'gzip' });
  try {
    writeShard(dir, '2026-01-05', 'legacy gzip needle');
    await store.archiveCold({ now: NOW });
    // Simulate a later engine switch on the same store: the old .gz must still read.
    const zstdStore = new RawStore({
      dataDir: dir,
      clock: new FakeClock(NOW + 40 * DAY),
      getConfig: () => ({ raw: { mode: 'all', retentionDays: 180, archiveAfterDays: 7, compressionEngine: 'zstd' } }),
    });
    const scan = await zstdStore.scan({
      text: 'needle',
      startTime: Date.UTC(2026, 0, 1),
      endTime: Date.UTC(2026, 0, 31),
      limit: 5,
    });
    assert.equal(scan.hits.length, 1);
    assert.equal(scan.hits[0].archive, 'raw-archive-2026-01.jsonl.gz');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config rejects an unknown compression engine', async () => {
  const { resolveConfig } = await import('../src/config.js');
  assert.throws(
    () => resolveConfig({ raw: { compressionEngine: 'lz4' } }),
    (error) => error.code === 'MEM_E_CONFIG_UNKNOWN_ENUM',
  );
  assert.equal(resolveConfig({}).raw.compressionEngine, 'gzip');
  assert.equal(resolveConfig({ raw: { compressionEngine: 'zstd' } }).raw.compressionEngine, 'zstd');
});
