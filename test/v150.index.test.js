/**
 * v1.5.0 module 1: tag-explosion defence.
 *
 * Three layers are pinned here:
 *   1. index: a per-tag posting cap that truncates POINTERS only, never counters;
 *   2. recall: an oversized explicit tag is refused with an actionable hint, and an
 *      insisting caller gets a bounded preview of the newest events instead;
 *   3. deep_raw: a super tag (>500 events) cannot be scanned without a time window.
 *
 * All times are injected (FakeClock / fixed T0 anchors); nothing reads the wall clock.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildIndex } from '../src/index/buildIndex.js';
import { resolvePolicy } from '../src/policy.js';
import {
  OVERSIZED_TAG_RECENT,
  SUPER_TAG_THRESHOLD,
  TAG_OVERFLOW_THRESHOLD,
  superTagAssociations,
} from '../src/retrieval.js';
import { DAY_MS, T0, makeMemory } from './helpers.js';

/**
 * Minimal episode record for a direct `buildIndex` call. Only the fields the pure
 * fold reads are set; ids are zero-padded so `localeCompare` ordering is obvious.
 */
function episodeRecord({ index, salience, eventTime, tag = 'big' }) {
  const eventId = `evt-${tag}-${String(index).padStart(4, '0')}`;
  return {
    v: 2,
    type: 'episode',
    event_id: eventId,
    entity_id: `ent-${eventId}`,
    content_hash: `hash-${eventId}`,
    occurrence_index: 0,
    event_time: eventTime,
    time_source: 'caller',
    time_uncertain: false,
    log_time: eventTime,
    content: `synthetic event ${index} for tag ${tag}`,
    salience,
    tags: [{ tag, strength: 0.7 }],
  };
}

test('config default caps postings per tag at 500', () => {
  assert.equal(DEFAULT_CONFIG.index.maxPostingsPerTag, 500);
  assert.equal(TAG_OVERFLOW_THRESHOLD, 50);
  assert.equal(OVERSIZED_TAG_RECENT, 3);
  assert.equal(SUPER_TAG_THRESHOLD, 500);
});

test('buildIndex truncates postings by salience but keeps true eventCount/mass', () => {
  const policy = resolvePolicy({});
  // Salience DECREASES with time: the newest 100 events are exactly the ones the cap
  // must drop, which proves retention rank is salience-first, not recency-first.
  const records = Array.from({ length: 600 }, (_, index) =>
    episodeRecord({
      index,
      salience: (600 - index) / 600,
      eventTime: T0 + index * 1000,
    }),
  );
  // One tiny tag proves normal tags keep the non-truncated flag values.
  records.push(episodeRecord({ index: 0, salience: 0.4, eventTime: T0, tag: 'small' }));

  const capped = buildIndex({ records, policy, now: T0 + 700_000, maxPostingsPerTag: 500 });
  const big = capped.tags.big;
  assert.equal(big.postings.length, 500, 'the posting list is physically capped');
  assert.equal(big.eventCount, 600, 'eventCount is the true total, not the posting count');
  assert.equal(big.postingsLimit, 500);
  assert.equal(big.postingsTruncated, true);
  assert.equal(big.postingsDropped, 100);
  assert.equal(capped.stats.postingsTruncated, 1, 'one tag was truncated');
  assert.equal(capped.stats.postingsDropped, 100);
  assert.equal(capped.tags.small.postingsTruncated, false);
  assert.equal(capped.tags.small.postingsDropped, 0);

  // Retained = the 500 highest-salience events (index 0..499); the newest 100
  // (500..599) are gone from the index even though they are the most recent.
  const expectedRetained = Array.from({ length: 500 }, (_, index) => 499 - index).map((index) =>
    episodeRecord({ index, salience: 0, eventTime: T0 }).event_id,
  );
  assert.deepEqual(
    big.postings.map((posting) => posting.eventId),
    expectedRetained,
    'retained postings: highest salience, then re-sorted newest-first',
  );

  // A wider cap changes only the pointer list: every aggregate stays identical.
  const full = buildIndex({ records, policy, now: T0 + 700_000, maxPostingsPerTag: 1000 });
  assert.equal(full.tags.big.postings.length, 600);
  assert.equal(full.tags.big.eventCount, capped.tags.big.eventCount);
  assert.equal(full.tags.big.mass, capped.tags.big.mass, 'mass is computed over ALL matching events');
  assert.equal(full.tags.big.lastSeen, capped.tags.big.lastSeen);
  assert.equal(full.stats.postingsTruncated, 0);
  assert.equal(full.stats.postingsDropped, 0);

  const narrower = buildIndex({ records, policy, now: T0 + 700_000, maxPostingsPerTag: 100 });
  assert.equal(narrower.tags.big.postings.length, 100);
  assert.equal(narrower.tags.big.postingsDropped, 500);
  assert.deepEqual(
    narrower.tags.big.postings.map((posting) => posting.eventId),
    Array.from({ length: 100 }, (_, index) => 99 - index).map(
      (index) => episodeRecord({ index, salience: 0, eventTime: T0 }).event_id,
    ),
  );
});

test('index manager passes the configured cap to rebuild and to the lazy fold', async () => {
  const { memory, cleanup } = await makeMemory({ config: { index: { maxPostingsPerTag: 50 } } });
  try {
    const items = Array.from({ length: 120 }, (_, index) => ({
      content: `capped event ${index}`,
      tags: ['big'],
      salience: 0.5,
      eventTime: T0 - (120 - index) * 1000,
    }));
    const bulk = await memory.bulkIngest(items);
    assert.equal(bulk.created, 120, 'fixture really wrote 120 episodes');

    await memory.maintain({ reason: 'cap' });
    assert.equal(memory.indexManager.status().maxPostingsPerTag, 50, 'status reports the live cap');

    let tag = memory.indexManager.snapshot().tags.big;
    assert.equal(tag.postings.length, 50, 'rebuild honours the configured cap');
    assert.equal(tag.eventCount, 120);
    assert.equal(tag.postingsTruncated, true);
    assert.equal(tag.postingsDropped, 70);

    // Lazy fold path: remember appends and marks the view dirty; the next snapshot
    // rebuilds in-process and must apply the same cap.
    await memory.remember({ content: 'capped event 120', tags: ['big'], salience: 0.9, eventTime: T0 });
    tag = memory.indexManager.snapshot().tags.big;
    assert.equal(tag.eventCount, 121);
    assert.equal(tag.postings.length, 50, 'lazy fold keeps the cap');
    assert.equal(tag.postingsTruncated, true);
    assert.equal(tag.postingsDropped, 71);
    assert.equal(tag.postingsLimit, 50);
    assert.equal(memory.indexManager.snapshot().stats.postingsTruncated, 1);
  } finally {
    cleanup();
  }
});

test('recall refuses an oversized explicit tag, then honours insistence with 3 recent', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const bigIds = [];
    for (let index = 0; index < 60; index += 1) {
      const recorded = await memory.remember({
        content: `big recall event ${index}`,
        tags: ['big'],
        salience: 0.5 + index / 200,
        eventTime: T0 - (60 - index) * 1000,
      });
      bigIds.push(recorded.eventId);
    }
    const small = await memory.remember({
      content: 'small precise note',
      tags: ['small'],
      salience: 0.9,
      eventTime: T0,
    });
    await memory.maintain({ reason: 'fixture' });

    // First call: refused, with an actionable hint and a real time window.
    const first = await memory.recall({ tags: ['big'] });
    assert.equal(first.hits.length, 0, 'an oversized tag is not expanded into hits');
    assert.equal(first.oversizedTagHints.length, 1);
    const hint = first.oversizedTagHints[0];
    assert.equal(hint.tag, 'big');
    assert.equal(hint.total, 60);
    assert.equal(hint.code, 'MEM_E_TAG_OVERFLOW');
    assert.match(hint.hint, /数据量过大/);
    assert.match(hint.hint, /startTime\/endTime/);
    assert.ok(hint.window && hint.window.start <= hint.window.end, 'the hint carries a usable window');
    assert.ok(first.notes.includes('oversized-tag:1'));

    // Second, identical call: the caller insisted -> bounded preview of the newest 3.
    const second = await memory.recall({ tags: ['big'] });
    assert.equal(second.hits.length, 3, 'insistence returns exactly the bounded preview');
    assert.ok(second.hits.every((hit) => hit.oversizedRecent === true));
    assert.deepEqual(
      second.hits.map((hit) => hit.eventId),
      bigIds.slice(-3).reverse(),
      'the preview is the 3 most recent events, newest first',
    );
    assert.equal(second.oversizedTagHints[0].recent, true);
    assert.ok(second.notes.some((note) => note.startsWith('oversized-tag-recent:3')));

    // A normal tag is untouched by the guard.
    const normal = await memory.recall({ tags: ['small'] });
    assert.equal(normal.hits.length, 1);
    assert.equal(normal.hits[0].eventId, small.eventId);
    assert.deepEqual(normal.oversizedTagHints, []);
    assert.ok(!normal.hits.some((hit) => hit.oversizedRecent === true));
  } finally {
    cleanup();
  }
});

test('deep_raw requires a window for a super tag but keeps plain validation', async () => {
  // v1.5.6: disable L2 multi-merge here — the fixture's 501 same-tag episodes are
  // the point of the test, and a merged record would add one more index event.
  const { memory, cleanup } = await makeMemory({ config: { l2Merge: { enabled: false } } });
  try {
    const items = Array.from({ length: 501 }, (_, index) => ({
      content: `super event ${index}`,
      tags: ['big'],
      salience: 0.5,
      eventTime: T0,
    }));
    const bulk = await memory.bulkIngest(items, { batchSize: 100 });
    assert.equal(bulk.created, 501, 'fixture really wrote 501 episodes');
    await memory.maintain({ reason: 'fixture' });

    await assert.rejects(
      () => memory.deepRaw({ text: 'big' }),
      (error) => error.code === 'MEM_E_TIME_RANGE_REQUIRED',
      'a super-tag deep_raw without a window is refused with the dedicated code',
    );

    // The exported detector is a pure read and names the offending tag from text or
    // from explicit tags (the alias table is the only canonicaliser).
    const view = memory.indexManager.snapshot();
    assert.deepEqual(superTagAssociations({ index: view, text: 'big' }), [{ tag: 'big', eventCount: 501 }]);
    assert.deepEqual(superTagAssociations({ index: view, tags: ['big'] }), [{ tag: 'big', eventCount: 501 }]);
    assert.deepEqual(superTagAssociations({ index: view, text: 'big', threshold: 10_000 }), []);
    assert.deepEqual(superTagAssociations({ index: null, text: 'big' }), [], 'a missing index never throws');

    // With a window the forensic scan resolves normally (empty here: no raw turns).
    const windowed = await memory.deepRaw({ text: 'big', startTime: T0 - DAY_MS, endTime: T0 + DAY_MS });
    assert.equal(windowed.mode, 'deep_raw');
    assert.ok(Array.isArray(windowed.hits));

    // v1.4 contract preserved: a non-super text query without a window is still a
    // plain invalid-input error, not the super-tag one.
    await assert.rejects(
      () => memory.deepRaw({ text: 'nothing-super-here' }),
      (error) => error.code === 'MEM_E_INVALID_INPUT',
    );
  } finally {
    cleanup();
  }
});
