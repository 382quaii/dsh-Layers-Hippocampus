/**
 * Double-buffer tests: the barrier isolates readers from a half-built index,
 * and a rebuild from (log - tombstones) reproduces the published bindings.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndex, foldRecords } from '../src/index/buildIndex.js';
import { Memory } from '../src/memory.js';
import { FakeClock } from '../src/clock.js';
import { tempDir, T0, DAY_MS } from './helpers.js';

test('a suspended writer never exposes a partial index to readers', async () => {
  const dir = tempDir('barrier');
  const memory = await Memory.open({ dataDir: dir, clock: new FakeClock(T0) });
  try {
    await memory.remember({ content: 'baseline event', tags: ['base'], salience: 0.5, eventTime: T0 });
    await memory.maintain({ reason: 'baseline' });
    const before = memory.indexManager.snapshot();
    assert.equal(before.events.length, 1);

    // Park the writer exactly at the barrier, between BUILD and SWAP.
    let reachedBarrier;
    const atBarrier = new Promise((resolve) => {
      reachedBarrier = resolve;
    });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    memory.indexManager.hooks.beforeSwap = async () => {
      reachedBarrier();
      await gate;
    };

    const writing = memory.remember({ content: 'event arriving during the build', tags: ['new'], salience: 0.7, eventTime: T0 + 1000 });
    await atBarrier;

    // Reader path is lock-free: it resolves the pointer once, mid-build.
    const during = memory.indexManager.snapshot();
    assert.equal(during.events.length, 1, 'the old buffer is complete, not a partial merge');
    assert.ok(during.events.every((event) => event.eventId !== undefined));
    assert.ok(during.activeSet.entries.every((entry) => typeof entry.priority === 'number'));

    release();
    await writing;

    const after = memory.indexManager.snapshot();
    assert.equal(after.events.length, 2, 'after the swap the new buffer is complete');
    const newTag = after.tags.new;
    assert.ok(newTag, 'the tag table of the new buffer is complete');
    assert.equal(newTag.postings.length, 1, 'bindings are not half-applied');
  } finally {
    memory.close();
  }
});

test('rebuild source is the log minus tombstones, not the old index', async () => {
  const dir = tempDir('rebuild-set');
  const clock = new FakeClock(T0);
  const memory = await Memory.open({ dataDir: dir, clock });
  try {
    const ids = [];
    for (let i = 0; i < 6; i += 1) {
      const recorded = await memory.remember({
        content: `decision number ${i}`,
        tags: [`topic:${i % 2 === 0 ? 'even' : 'odd'}`, 'common'],
        salience: 0.4 + i * 0.05,
        eventTime: T0 + i * DAY_MS,
      });
      ids.push(recorded.eventId);
    }
    await memory.maintain({ reason: 'fixture' });

    // Two tombstones: the rebuild must exclude them or they would resurrect.
    const buried = ids.slice(0, 2);
    for (const eventId of buried) {
      memory.tombstones.mark({ eventId, at: T0 + 10 * DAY_MS, reason: 'test' });
    }
    await memory.maintain({ reason: 'with-tombstones' });
    const published = memory.indexRegistry ?? memory.indexStore.current();

    // Independent rebuild from (log - tombstones) at the same injected instant.
    const snapshot = await memory.logStore.snapshot();
    const filtered = snapshot.records.filter((record) => !memory.tombstones.has(record.event_id));
    const expected = buildIndex({
      records: filtered,
      policy: memory.policy,
      now: clock.now(),
      tombstones: memory.tombstones.ids(),
    });

    for (const [tag, posting] of Object.entries(expected.tags)) {
      const actual = published.tags[tag];
      assert.ok(actual, `rebuilt index keeps tag ${tag}`);
      const expectedIds = posting.postings.map((item) => item.eventId).sort();
      const actualIds = actual.postings.map((item) => item.eventId).sort();
      assert.deepEqual(actualIds, expectedIds, `tag ${tag} binds the same events (unordered)`);
      for (const item of posting.postings) {
        const match = actual.postings.find((candidate) => candidate.eventId === item.eventId);
        assert.ok(Math.abs(match.strength - item.strength) < 1e-9, 'strength agrees within epsilon');
      }
    }
    assert.ok(!published.events.some((event) => buried.includes(event.eventId)), 'tombstoned events never return');
    assert.equal(published.stats.suppressedByTombstone, 2);
    assert.equal(foldRecords(filtered).episodes.size, 4);
  } finally {
    memory.close();
  }
});
