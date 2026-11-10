/**
 * v1.6.1 — raw cold-tier archiving (zero external dependencies).
 *
 * Eligible daily shards are merged per calendar month into ONE gzip archive
 * (`raw-archive-YYYY-MM.jsonl.gz`), the plaintext shard is removed, and
 * `deep_raw` / hash restore keep working by streaming the archive with Node's
 * built-in zlib. Archiving runs at most once per month.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { RawStore, RAW_DIR } from '../src/rawStore.js';
import { FakeClock, T0, tempDir } from './helpers.js';

const DAY = 86_400_000;

function makeStore({ now = T0, config = {} } = {}) {
  const dir = tempDir('raw-archive');
  const clock = new FakeClock(now);
  const store = new RawStore({
    dataDir: dir,
    clock,
    getConfig: () => ({ raw: { mode: 'all', retentionDays: 90, archiveAfterDays: 7, maxResultTokens: 1000, ...config } }),
    getHotTags: () => [],
  });
  fs.mkdirSync(path.join(dir, RAW_DIR), { recursive: true });
  return { dir, clock, store };
}

function writeShard(dir, day, records) {
  const file = path.join(dir, RAW_DIR, `${day}.jsonl`);
  const lines = records
    .map((record) => JSON.stringify({ turn_id: record.turnId, timestamp: record.timestamp, role: 'user', content: record.content }))
    .join('\n');
  fs.writeFileSync(file, `${lines}\n`, 'utf8');
  return file;
}

test('eligible cold shards merge into one monthly gzip and plaintext is removed', async () => {
  const { dir, store } = makeStore({
    now: Date.UTC(2026, 2, 15), // 2026-03-15
  });
  try {
    writeShard(dir, '2026-01-05', [
      { turnId: 't1', timestamp: Date.UTC(2026, 0, 5), content: 'cold note alpha' },
      { turnId: 't2', timestamp: Date.UTC(2026, 0, 5), content: 'cold note beta' },
    ]);
    writeShard(dir, '2026-01-09', [{ turnId: 't3', timestamp: Date.UTC(2026, 0, 9), content: 'cold note gamma' }]);
    const result = await store.archiveCold({ now: Date.UTC(2026, 2, 15) });
    assert.deepEqual(result.archived, ['2026-01']);
    const gz = path.join(dir, RAW_DIR, 'raw-archive-2026-01.jsonl.br');
    assert.ok(fs.existsSync(gz), 'monthly archive exists');
    assert.ok(!fs.existsSync(path.join(dir, RAW_DIR, '2026-01-05.jsonl')), 'plaintext shard removed');
    assert.ok(!fs.existsSync(path.join(dir, RAW_DIR, '2026-01-09.jsonl')), 'second shard removed');
    assert.ok(fs.statSync(gz).size > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deep_raw streams a cold archive and still finds the target line', async () => {
  const { dir, store } = makeStore({ now: Date.UTC(2026, 2, 15) });
  try {
    writeShard(dir, '2026-01-05', [
      { turnId: 't1', timestamp: Date.UTC(2026, 0, 5), content: 'needle cold record' },
      { turnId: 't2', timestamp: Date.UTC(2026, 0, 5), content: 'unrelated cold record' },
    ]);
    await store.archiveCold({ now: Date.UTC(2026, 2, 15) });
    const result = await store.scan({
      text: 'needle',
      startTime: Date.UTC(2026, 0, 1),
      endTime: Date.UTC(2026, 0, 31),
      limit: 10,
    });
    assert.equal(result.hits.length, 1);
    assert.match(result.hits[0].snippet, /needle cold record/);
    assert.equal(result.hits[0].archive, 'raw-archive-2026-01.jsonl.br');
    assert.ok(result.scanned.shards >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hash restore also searches cold archives', async () => {
  const { dir, store } = makeStore({ now: Date.UTC(2026, 2, 15) });
  try {
    writeShard(dir, '2026-01-05', [{ turnId: 't1', timestamp: Date.UTC(2026, 0, 5), content: 'hash needle content' }]);
    await store.archiveCold({ now: Date.UTC(2026, 2, 15) });
    const { sha256 } = await import('../src/util.js');
    const hash = sha256('hash needle content').slice(0, 16);
    const restored = await store.restoreByHash(hash);
    assert.equal(restored.restored, true);
    assert.match(restored.hits[0].content, /hash needle content/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pinned and handoff shards are exempt from archiving', async () => {
  const { dir, store } = makeStore({ now: Date.UTC(2026, 2, 15) });
  try {
    writeShard(dir, '2026-01-05', [{ turnId: 't1', timestamp: Date.UTC(2026, 0, 5), content: 'pinned cold record' }]);
    writeShard(dir, '2026-01-06', [{ turnId: 't2', timestamp: Date.UTC(2026, 0, 6), content: 'handoff cold record' }]);
    // Rewrite with the fields the eligibility check inspects.
    const pinnedFile = path.join(dir, RAW_DIR, '2026-01-05.jsonl');
    fs.writeFileSync(
      pinnedFile,
      `${JSON.stringify({ turn_id: 't1', timestamp: Date.UTC(2026, 0, 5), role: 'user', content: 'pinned cold record', pinned: true })}\n`,
    );
    const handoffFile = path.join(dir, RAW_DIR, '2026-01-06.jsonl');
    fs.writeFileSync(
      handoffFile,
      `${JSON.stringify({ turn_id: 't2', timestamp: Date.UTC(2026, 0, 6), role: 'user', content: 'handoff cold record', tags: ['status:handoff'] })}\n`,
    );
    const result = await store.archiveCold({ now: Date.UTC(2026, 2, 15) });
    assert.deepEqual(result.archived, []);
    assert.ok(result.skipped.includes('2026-01-05:pinned'));
    assert.ok(result.skipped.includes('2026-01-06:handoff'));
    assert.ok(fs.existsSync(pinnedFile));
    assert.ok(fs.existsSync(handoffFile));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hot-tag shards are exempt from archiving', async () => {
  const dir = tempDir('raw-archive-hot');
  const store = new RawStore({
    dataDir: dir,
    clock: new FakeClock(Date.UTC(2026, 2, 15)),
    getConfig: () => ({ raw: { mode: 'all', retentionDays: 90, archiveAfterDays: 7 } }),
    getHotTags: () => ['topic:hot'],
  });
  try {
    fs.mkdirSync(path.join(dir, RAW_DIR), { recursive: true });
    const file = path.join(dir, RAW_DIR, '2026-01-05.jsonl');
    fs.writeFileSync(
      file,
      `${JSON.stringify({ turn_id: 't1', timestamp: Date.UTC(2026, 0, 5), role: 'user', content: 'hot tag record', tags: ['topic:hot'] })}\n`,
    );
    const result = await store.archiveCold({ now: Date.UTC(2026, 2, 15), hotTags: ['topic:hot'] });
    assert.deepEqual(result.archived, []);
    assert.ok(result.skipped.includes('2026-01-05:hot-tag'));
    assert.ok(fs.existsSync(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('archiving is monthly-gated: the second pass is a no-op', async () => {
  const { dir, store } = makeStore({ now: Date.UTC(2026, 2, 15) });
  try {
    writeShard(dir, '2026-01-05', [{ turnId: 't1', timestamp: Date.UTC(2026, 0, 5), content: 'cold' }]);
    const first = await store.archiveCold({ now: Date.UTC(2026, 2, 15) });
    assert.deepEqual(first.archived, ['2026-01']);
    writeShard(dir, '2026-01-20', [{ turnId: 't2', timestamp: Date.UTC(2026, 0, 20), content: 'cold later' }]);
    const second = await store.archiveCold({ now: Date.UTC(2026, 2, 20) });
    assert.equal(second.reason, 'monthly-gate');
    assert.deepEqual(second.archived, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recently-read shards are exempt from archiving', async () => {
  const { dir, clock, store } = makeStore({ now: Date.UTC(2026, 2, 15) });
  try {
    writeShard(dir, '2026-01-05', [{ turnId: 't1', timestamp: Date.UTC(2026, 0, 5), content: 'hot cold record' }]);
    store.archive.recordAccess('2026-01-05', Date.UTC(2026, 1, 20));
    const result = await store.archiveCold({ now: Date.UTC(2026, 2, 15) });
    assert.deepEqual(result.archived, []);
    assert.ok(result.skipped.some((entry) => entry.startsWith('2026-01-05:recent-access')));
    assert.ok(fs.existsSync(path.join(dir, RAW_DIR, '2026-01-05.jsonl')), 'hot shard stays plaintext');
    assert.ok(clock.now() > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
