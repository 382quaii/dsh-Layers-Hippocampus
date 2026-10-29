/**
 * Maintenance tests: atomic publication, boot check, compaction, single-flight.
 * The clock is injected; nothing sleeps or measures wall time.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeMemory } from './helpers.js';

test('maintenance publishes a new generation and leaves the previous snapshot intact', async () => {
  const { memory, dir, cleanup } = await makeMemory();
  try {
    await memory.remember({ content: 'first', tags: ['t'], salience: 0.5 });
    await memory.remember({ content: 'second', tags: ['t'], salience: 0.5 });
    const first = await memory.maintain({ reason: 'one' });
    const snapshot = memory.indexStore.current();
    const generationFile = path.join(dir, 'index', 'CURRENT');

    await memory.remember({ content: 'third', tags: ['t'], salience: 0.5 });
    const second = await memory.maintain({ reason: 'two' });

    assert.notEqual(first.indexGen, second.indexGen);
    assert.equal(second.previousIndexGen, first.indexGen);
    // A reader that resolved the old generation still holds a complete view.
    assert.equal(snapshot.events.length, 2);
    assert.equal(snapshot.generation, first.indexGen);
    assert.equal(memory.indexStore.current().events.length, 3);

    assert.equal(fs.readFileSync(generationFile, 'utf8').trim(), second.indexGen);
    const entries = fs.readdirSync(path.join(dir, 'index'));
    assert.ok(!entries.some((name) => name.startsWith('.tmp-')), 'no half-written generations left behind');
    assert.ok(entries.filter((name) => name.startsWith('gen-')).every((name) => fs.existsSync(path.join(dir, 'index', name, 'manifest.json'))));
  } finally {
    cleanup();
  }
});

test('boot check detects a stale index without rebuilding it', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    await memory.remember({ content: 'only episode', tags: ['t'], salience: 0.5 });
    await memory.maintain({ reason: 'clean' });
    assert.equal((await memory.maintenance.bootCheck()).status, 'ok');

    await memory.remember({ content: 'appended after the index was built', tags: ['t'], salience: 0.5 });
    const stale = await memory.maintenance.bootCheck();
    assert.equal(stale.status, 'stale');
    assert.match(stale.reason, /records index=/);

    // The published index is not silently rewritten by a boot check...
    assert.equal(memory.indexStore.status().stats.episodes, 1);
    // ...but the foreground buffer (A/B swap) serves the new episode immediately.
    const result = await memory.recall({ text: 'appended', tags: ['t'], topK: 5 });
    assert.ok(result.hits.some((hit) => hit.snippet.includes('appended')));

    await memory.maintain({ reason: 'rebuild' });
    assert.equal((await memory.maintenance.bootCheck()).status, 'ok');
  } finally {
    cleanup();
  }
});

test('compaction merges segments and preserves every record', async () => {
  const { memory, cleanup } = await makeMemory({
    config: { maxSegmentRecords: 2 },
    policy: { maintenance: { compactAfterSegments: 2 } },
  });
  try {
    for (let i = 0; i < 5; i += 1) {
      await memory.remember({ content: `episode ${i}`, tags: ['t'], salience: 0.5 });
    }
    const before = await memory.logStore.status();
    assert.equal(before.segments, 3);
    assert.equal(before.recordCount, 5);

    const report = await memory.maintain({ reason: 'compact' });
    assert.ok(report.compaction, 'compaction was triggered');
    assert.equal(report.compaction.from, 3);
    assert.equal(report.compaction.kept, 5);

    const after = await memory.logStore.status();
    assert.equal(after.recordCount, 5, 'no record lost');
    assert.ok(after.segments <= 3, 'compaction rewrites bounded segments');
    assert.ok(report.notes.some((note) => note.startsWith('compacted:')));
    assert.equal(memory.indexStore.current().events.length, 5);
  } finally {
    cleanup();
  }
});

test('concurrent maintenance runs are serialised by the store lock', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    await memory.remember({ content: 'alpha', tags: ['t'], salience: 0.5 });
    const [a, b] = await Promise.all([
      memory.maintain({ reason: 'concurrent-a' }),
      memory.maintain({ reason: 'concurrent-b' }),
    ]);
    assert.ok(a.indexGen && b.indexGen);
    assert.notEqual(a.indexGen, b.indexGen, 'each pass publishes its own generation');
    const current = memory.indexStore.currentGeneration();
    assert.ok([a.indexGen, b.indexGen].includes(current));
    assert.equal(memory.indexStore.current().events.length, 1);
    assert.equal(memory.indexStore.status().generations, 2);
  } finally {
    cleanup();
  }
});
