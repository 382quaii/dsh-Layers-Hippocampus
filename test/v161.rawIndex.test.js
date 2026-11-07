/**
 * v1.6.1 — sparse line index for raw shards (performance audit item C).
 *
 * The index is a side-car: `<day>.jsonl.idx.json`, sampled every 64 lines, used to
 * skip shards whose [minTs, maxTs] cannot overlap the window and to reuse
 * `lineCount` for absolute hit.line numbers. It must degrade silently when missing,
 * stale (bytes/mtime), corrupt, or non-monotonic.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { RawStore, RAW_DIR } from '../src/rawStore.js';
import { buildIndex, indexFileFor, readIndex, shardOverlapsWindow, DEFAULT_INDEX_STEP } from '../src/rawIndex.js';
import { FakeClock, tempDir } from './helpers.js';

const NOW = Date.UTC(2026, 0, 20);

function makeStore() {
  const dir = tempDir('raw-index');
  const clock = new FakeClock(NOW);
  const store = new RawStore({
    dataDir: dir,
    clock,
    getConfig: () => ({ raw: { mode: 'all', retentionDays: 90, archiveAfterDays: 80 } }),
  });
  fs.mkdirSync(path.join(dir, RAW_DIR), { recursive: true });
  return { dir, store };
}

function writeShard(dir, day, rows) {
  const file = path.join(dir, RAW_DIR, `${day}.jsonl`);
  fs.writeFileSync(
    file,
    `${rows.map((row) => JSON.stringify({ turn_id: row.id, timestamp: row.at, role: 'user', content: row.text })).join('\n')}\n`,
  );
  return file;
}

test('buildIndex samples every 64th line with byte offsets and a line count', async () => {
  const { dir } = makeStore();
  try {
    const rows = Array.from({ length: 130 }, (_, index) => ({
      id: `t${index}`,
      at: Date.UTC(2026, 0, 5) + index * 1000,
      text: `row ${index} needle`,
    }));
    const file = writeShard(dir, '2026-01-05', rows);
    const index = await buildIndex({ shardFile: file, day: '2026-01-05' });
    assert.equal(index.schema, 1);
    assert.equal(index.lineCount, 130);
    assert.equal(index.step, DEFAULT_INDEX_STEP);
    assert.equal(index.entries.length, Math.ceil(130 / DEFAULT_INDEX_STEP));
    assert.equal(index.entries[0].line, 1);
    assert.equal(index.entries[0].offset, 0);
    assert.equal(index.entries[1].line, 1 + DEFAULT_INDEX_STEP);
    assert.ok(index.entries[1].offset > 0);
    assert.ok(index.entries.every((entry) => Number.isFinite(entry.timestamp)));
    assert.equal(index.sorted, true);
    assert.equal(index.minTimestamp, rows[0].at);
    assert.equal(index.maxTimestamp, rows[129].at);
    assert.equal(shardOverlapsWindow(index, Date.UTC(2025, 11, 1), Date.UTC(2025, 11, 31)), false);
    assert.equal(shardOverlapsWindow(index, Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 6)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deep_raw skips a shard via the index and reuses lineCount for hit.line', async () => {
  const { dir, store } = makeStore();
  try {
    const inside = Array.from({ length: 70 }, (_, index) => ({
      id: `in${index}`,
      at: Date.UTC(2026, 0, 5) + index,
      text: index === 65 ? 'target needle row' : `row ${index}`,
    }));
    writeShard(dir, '2026-01-05', inside);
    // Same DAY as the window (so the day filter keeps it) but its timestamps fall
    // before the requested hour window: only the sparse index can prove "no overlap".
    const sameDayOutside = Array.from({ length: 8 }, (_, index) => ({
      id: `out${index}`,
      at: Date.UTC(2026, 0, 5, 1) + index,
      text: 'outside needle row',
    }));
    writeShard(dir, '2026-01-05', [
      ...sameDayOutside,
      ...inside.map((row) => ({ ...row, at: Date.UTC(2026, 0, 5, 12) + row.at % 1000 })),
    ]);
    const ensured = await store.ensureIndexes();
    assert.ok(ensured.indexed >= 1);

    const scan = await store.scan({
      text: 'needle',
      startTime: Date.UTC(2026, 0, 5, 10),
      endTime: Date.UTC(2026, 0, 5, 23),
      limit: 5,
    });
    assert.equal(scan.hits.length, 1);
    assert.equal(scan.hits[0].line, sameDayOutside.length + 66, 'absolute line from the index lineCount');
    assert.equal(scan.scanned.indexedShards, 1);
    assert.ok(scan.notes.every((note) => !note.startsWith('index-skip:')), 'shard overlaps, no skip');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale or missing index degrades to a sequential scan', async () => {
  const { dir, store } = makeStore();
  try {
    const file = writeShard(dir, '2026-01-05', [{ id: 't1', at: Date.UTC(2026, 0, 5), text: 'fresh needle' }]);
    await store.ensureIndexes();
    const indexFile = indexFileFor(file);
    assert.ok(fs.existsSync(indexFile));
    // Append without touching the index: bytes/mtime no longer match.
    fs.appendFileSync(file, `${JSON.stringify({ turn_id: 't2', timestamp: Date.UTC(2026, 0, 5) + 1, role: 'user', content: 'appended needle' })}\n`);
    assert.equal(readIndex(file), null, 'stale index is rejected');
    const scan = await store.scan({
      text: 'needle',
      startTime: Date.UTC(2026, 0, 1),
      endTime: Date.UTC(2026, 0, 31),
      limit: 5,
    });
    assert.equal(scan.hits.length, 2);
    // Corrupt index must not break scans either.
    fs.writeFileSync(indexFile, '{not json', 'utf8');
    const again = await store.scan({
      text: 'needle',
      startTime: Date.UTC(2026, 0, 1),
      endTime: Date.UTC(2026, 0, 31),
      limit: 5,
    });
    assert.equal(again.hits.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the index proves a shard cannot overlap and skips opening it', async () => {
  const { dir, store } = makeStore();
  try {
    // Shard DAY is inside the requested range, but every record is earlier than the
    // requested start time: the sparse index can prove no overlap without scanning.
    writeShard(dir, '2026-01-05', [
      { id: 'e1', at: Date.UTC(2026, 0, 5, 1), text: 'early needle' },
      { id: 'e2', at: Date.UTC(2026, 0, 5, 2), text: 'early needle two' },
    ]);
    await store.ensureIndexes();
    const scan = await store.scan({
      text: 'needle',
      startTime: Date.UTC(2026, 0, 5, 10),
      endTime: Date.UTC(2026, 0, 5, 23),
      limit: 5,
    });
    assert.equal(scan.hits.length, 0);
    assert.ok(scan.notes.includes('index-skip:2026-01-05.jsonl'), `notes=${JSON.stringify(scan.notes)}`);
    assert.equal(scan.scanned.shards, 0, 'the shard was never opened for scanning');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prune deletes the side-car index together with its shard', async () => {
  const { dir, store } = makeStore();
  try {
    const file = writeShard(dir, '2025-06-01', [{ id: 't1', at: Date.UTC(2025, 5, 1), text: 'old needle' }]);
    await store.ensureIndexes();
    assert.ok(fs.existsSync(indexFileFor(file)));
    const pruned = await store.prune({ now: NOW });
    assert.ok(pruned.removed.includes('2025-06-01'));
    assert.ok(!fs.existsSync(file));
    assert.ok(!fs.existsSync(indexFileFor(file)), 'index removed with the shard');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stats exposes how many shards are indexed', async () => {
  const { dir, store } = makeStore();
  try {
    writeShard(dir, '2026-01-05', [{ id: 't1', at: Date.UTC(2026, 0, 5), text: 'a' }]);
    writeShard(dir, '2026-01-06', [{ id: 't2', at: Date.UTC(2026, 0, 6), text: 'b' }]);
    await store.ensureIndexes();
    assert.equal(store.stats().shards, 2);
    assert.equal(store.stats().indexedShards, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
