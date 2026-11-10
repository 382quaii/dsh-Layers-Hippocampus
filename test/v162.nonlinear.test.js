/**
 * v1.6.1 — "打破日志线性增长" three-layer tests (TDD lock).
 *
 * 1. COMPRESSION: a 120-day-old, zero-access shard is Brotli-11 compressed; an
 *    equally old shard with a recent access stays PLAINTEXT (multi-dimensional
 *    cold/hot decision, never age alone).
 * 2. ENCODING: repeated long content (tool schemas / prompts) is stored ONCE in the
 *    index template table and referenced, so the read model stops duplicating it.
 * 3. SEMANTICS: after distillation covers a day, raw bytes may be physically
 *    cleaned — through the tombstone path, so they cannot resurrect.
 * 4. SEMANTICS: L3 has a hard capacity breaker with LRU retirement.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { RawStore, RAW_DIR } from '../src/rawStore.js';
import { archiveExtension } from '../src/compression.js';
import { dedupeTemplates, resolveTemplates, templateRefFor } from '../src/index/templates.js';
import { SemanticStore } from '../src/semantic/semanticStore.js';
import { buildIndex } from '../src/index/buildIndex.js';
import { FakeClock, T0, tempDir } from './helpers.js';
import { sha256 } from '../src/util.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1);

function makeRawStore({ now = NOW, config = {} } = {}) {
  const dir = tempDir('nonlinear');
  const clock = new FakeClock(now);
  const store = new RawStore({
    dataDir: dir,
    clock,
    getConfig: () => ({ raw: { mode: 'all', retentionDays: 365, archiveAfterDays: 90, coldAccessWindowDays: 90, ...config } }),
  });
  fs.mkdirSync(path.join(dir, RAW_DIR), { recursive: true });
  return { dir, store, clock };
}

function writeShard(dir, day, rows) {
  const file = path.join(dir, RAW_DIR, `${day}.jsonl`);
  fs.writeFileSync(
    file,
    `${rows.map((row) => JSON.stringify({ turn_id: row.id, timestamp: row.at, role: 'user', content: row.content })).join('\n')}\n`,
  );
  return file;
}

// ---------------------------------------------------------------------------
// 1. compression layer
// ---------------------------------------------------------------------------
test('120-day-old zero-access shard is brotli-compressed to max, recently accessed old shard stays plaintext', async () => {
  const { dir, store } = makeRawStore();
  try {
    const coldDay = '2026-01-20'; // ~132 days before NOW
    const hotDay = '2026-01-21';
    writeShard(dir, coldDay, [{ id: 'c1', at: Date.UTC(2026, 0, 20), content: 'cold payload '.repeat(60) }]);
    writeShard(dir, hotDay, [{ id: 'h1', at: Date.UTC(2026, 0, 21), content: 'warm payload '.repeat(60) }]);
    // The old-but-recently-read shard must NOT be archived.
    store.archive.recordAccess(hotDay, NOW - 3 * DAY);

    const result = await store.archiveCold({ now: NOW });
    assert.deepEqual(result.archived, ['2026-01']);
    assert.equal(result.engine, 'brotli');
    assert.ok(!fs.existsSync(path.join(dir, RAW_DIR, `${coldDay}.jsonl`)), 'cold shard physically archived');
    assert.ok(fs.existsSync(path.join(dir, RAW_DIR, `${hotDay}.jsonl`)), 'recently-read shard stays plaintext');
    const archive = path.join(dir, RAW_DIR, `raw-archive-2026-01${archiveExtension('brotli')}`);
    assert.ok(fs.existsSync(archive), 'brotli archive exists');

    // Reading the archive still works, and it reports the brotli engine.
    assert.equal(archiveExtension('brotli'), '.jsonl.br');
    const scan = await store.scan({ text: 'cold payload', startTime: Date.UTC(2026, 0, 1), endTime: Date.UTC(2026, 0, 31), limit: 5 });
    assert.equal(scan.hits.length, 1);
    assert.ok(scan.hits[0].archive.endsWith('.jsonl.br'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an old shard that is still being read is exempt (age alone is never enough)', async () => {
  const { dir, store } = makeRawStore();
  try {
    const day = '2026-01-20';
    writeShard(dir, day, [{ id: 'c1', at: Date.UTC(2026, 0, 20), content: 'kept hot' }]);
    store.archive.recordAccess(day, NOW - 5 * DAY); // inside coldAccessWindowDays(90)
    const result = await store.archiveCold({ now: NOW });
    assert.deepEqual(result.archived, []);
    assert.ok(result.skipped.includes(`${day}:recent-access`));
    assert.ok(fs.existsSync(path.join(dir, RAW_DIR, `${day}.jsonl`)), 'stays plaintext for O(1) cursor scan');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. encoding layer: referential dedup
// ---------------------------------------------------------------------------
test('repeated long content is stored once and referenced, shrinking the read model', () => {
  const longPrompt = `SYSTEM TOOL SCHEMA ${'x'.repeat(700)}`;
  const events = [
    { eventId: 'ev1', content: longPrompt },
    { eventId: 'ev2', content: longPrompt },
    { eventId: 'ev3', content: longPrompt },
    { eventId: 'ev4', content: 'short unique' },
  ];
  const deduped = dedupeTemplates(events);
  assert.equal(deduped.stats.templates, 1);
  assert.equal(deduped.stats.refs, 3);
  assert.ok(deduped.stats.savedChars > 0, 'characters removed from the read model');
  const ref = templateRefFor(longPrompt);
  assert.equal(deduped.templates[ref], longPrompt);
  for (const event of deduped.events.slice(0, 3)) {
    assert.equal(event.content, '');
    assert.equal(event.contentRef, ref);
  }
  assert.equal(deduped.events[3].content, 'short unique');
  assert.equal(deduped.events[3].contentRef, undefined);

  // Readers get exact content back; the log itself was never touched.
  const resolved = resolveTemplates(deduped.events, deduped.templates);
  assert.equal(resolved[0].content, longPrompt);

  // On-disk index events are materially smaller than the raw projection.
  const before = JSON.stringify(events).length;
  const after = JSON.stringify({ events: deduped.events, templates: deduped.templates }).length;
  assert.ok(after < before, `deduped index must be smaller (${after} < ${before})`);
});

test('a single occurrence of long content is NOT rewritten', () => {
  const once = [{ eventId: 'ev1', content: 'y'.repeat(800) }];
  const deduped = dedupeTemplates(once);
  assert.equal(deduped.stats.templates, 0);
  assert.equal(deduped.events[0].content, 'y'.repeat(800));
  assert.equal(deduped.events[0].contentRef, undefined);
});

test('buildIndex dedups repeated long prompts and keeps content recoverable', async () => {
  const longPrompt = `tool schema ${'z'.repeat(700)}`;
  const records = [1, 2].map((index) => ({
    type: 'episode',
    event_id: `ev_${index}`,
    content: longPrompt,
    content_hash: sha256(longPrompt),
    event_time: T0 + index,
    log_time: T0 + index,
    tags: ['topic:tools'],
  }));
  const { resolvePolicy } = await import('../src/policy.js');
  const policy = resolvePolicy({});
  const built = await buildIndex({ records, policy, now: T0 + 10, semantic: [] });
  assert.equal(built.stats.templates, 1);
  assert.equal(built.stats.templateRefs, 2);
  assert.ok(built.events.every((event) => event.contentRef), 'events point at the template');
  assert.ok(built.events.every((event) => event.content === ''));
});

// ---------------------------------------------------------------------------
// 3. semantic layer: raw cleanup after distillation, tombstone-protected
// ---------------------------------------------------------------------------
test('distilled raw shards are physically cleaned and tombstoned (no resurrection)', async () => {
  const { dir, store } = makeRawStore({ config: { distillPrune: true, hotWindowDays: 30 } });
  try {
    const day = '2026-01-20';
    const content = 'distilled raw payload';
    const file = writeShard(dir, day, [{ id: 'd1', at: Date.UTC(2026, 0, 20), content }]);
    assert.ok(fs.existsSync(file));

    const pruned = await store.pruneDistilled({ now: NOW, hotWindowDays: 30, distilledDays: new Set([day]) });
    assert.deepEqual(pruned.removed, [day]);
    assert.ok(pruned.tombstoned >= 1);
    assert.ok(!fs.existsSync(file), 'raw bytes physically removed');
    assert.ok(!fs.existsSync(`${file}.idx.json`), 'side-car index removed too');

    // Tombstone: the content is now dead for scans even if it reappears.
    const tombstones = store._loadTombstones();
    assert.ok(tombstones.has(sha256(content)), 'content hash tombstoned');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('distill prune does nothing without opt-in or without distillation proof', async () => {
  const disabled = makeRawStore({ config: { distillPrune: false } });
  try {
    const day = '2026-01-20';
    writeShard(disabled.dir, day, [{ id: 'd1', at: Date.UTC(2026, 0, 20), content: 'keep me' }]);
    const result = await disabled.store.pruneDistilled({ now: NOW, distilledDays: new Set([day]) });
    assert.equal(result.enabled, false);
    assert.deepEqual(result.removed, []);
    assert.ok(fs.existsSync(path.join(disabled.dir, RAW_DIR, `${day}.jsonl`)));
  } finally {
    fs.rmSync(disabled.dir, { recursive: true, force: true });
  }

  const enabled = makeRawStore({ config: { distillPrune: true } });
  try {
    const day = '2026-01-20';
    writeShard(enabled.dir, day, [{ id: 'd1', at: Date.UTC(2026, 0, 20), content: 'keep me' }]);
    const result = await enabled.store.pruneDistilled({ now: NOW, distilledDays: new Set() });
    assert.equal(result.reason, 'no-distilled-days');
    assert.ok(fs.existsSync(path.join(enabled.dir, RAW_DIR, `${day}.jsonl`)), 'no proof = no deletion');
  } finally {
    fs.rmSync(enabled.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. semantic layer: L3 capacity breaker with LRU
// ---------------------------------------------------------------------------
test('L3 capacity breaker retires the LRU summaries and stays bounded', () => {
  const dir = tempDir('l3-cap');
  try {
    const store = new SemanticStore({ root: dir });
    const clock = new FakeClock(T0);
    let tick = 0;
    for (let index = 0; index < 5; index += 1) {
      tick += 1000;
      clock.set(T0 + tick);
      store.upsert({
        clock,
        title: `trait-${index}`,
        text: `trait text ${index}`,
        confidence: 0.5,
        tags: ['persona:traits'],
        sourceEvents: [`ev_${index}`],
      });
    }
    assert.equal(store.list().length, 5);

    const capped = store.enforceCapacity({ clock, maxEntries: 3, lruOnCap: true });
    assert.equal(capped.capped, true);
    assert.equal(capped.retired.length, 2);
    const left = store.list();
    assert.equal(left.length, 3, 'hard cap holds');
    // Newest survive; the two oldest (LRU) are retired.
    assert.deepEqual(left.map((summary) => summary.title).sort(), ['trait-2', 'trait-3', 'trait-4']);
    assert.equal(capped.retired.length, 2);

    // Retire is append-only: the semantic log keeps the evidence of the decision.
    const raw = fs.readFileSync(path.join(dir, 'sem.log.jsonl'), 'utf8').trim().split('\n');
    assert.ok(raw.length > 5, 'retire records appended, not deletions');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('L3 capacity is a no-op when under the cap or disabled', () => {
  const dir = tempDir('l3-cap-2');
  try {
    const store = new SemanticStore({ root: dir });
    const clock = new FakeClock(T0);
    store.upsert({ clock, title: 'only', text: 'one trait', confidence: 0.5, tags: ['persona:traits'], sourceEvents: ['ev_1'] });
    assert.deepEqual(store.enforceCapacity({ clock, maxEntries: 10 }).retired, []);
    assert.deepEqual(store.enforceCapacity({ clock, maxEntries: 1, lruOnCap: false }).retired, []);
    assert.equal(store.list().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
