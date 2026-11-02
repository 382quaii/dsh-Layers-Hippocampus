/**
 * Retrieval tests: decay arithmetic, reinforcement anchoring, coarse recall.
 * Time is always injected; the half-life assertions are exact arithmetic.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { degradeGhostHits } from '../src/retrieval.js';
import { DAY_MS, T0, makeMemory } from './helpers.js';

test('decay follows the 30-day half-life from event_time', async () => {
  const { memory, clock, cleanup } = await makeMemory({ start: T0 - 60 * DAY_MS });
  try {
    const old = await memory.remember({
      content: 'an old decision about the schema',
      tags: ['topic:schema'],
      salience: 0.5,
      eventTime: clock.now(),
    });
    clock.advance(60 * DAY_MS);
    const fresh = await memory.remember({
      content: 'a fresh decision about the schema',
      tags: ['topic:schema'],
      salience: 0.5,
      eventTime: clock.now(),
    });
    await memory.maintain({ reason: 'decay' });

    const result = await memory.recall({ text: 'decision schema', tags: ['topic:schema'], topK: 5 });
    const byId = new Map(result.hits.map((hit) => [hit.eventId, hit]));

    // 60 days = two half-lives -> 0.5^2 = 0.25.
    assert.equal(byId.get(old.eventId).decay, 0.25);
    assert.equal(byId.get(fresh.eventId).decay, 1);
    assert.ok(byId.get(fresh.eventId).score > byId.get(old.eventId).score);
    assert.equal(result.hits[0].eventId, fresh.eventId, 'decay orders the hits, not insertion order');
  } finally {
    cleanup();
  }
});

test('reinforcement moves the decay anchor without storing a field', async () => {
  const { memory, clock, cleanup } = await makeMemory({ start: T0 - 90 * DAY_MS });
  try {
    const older = await memory.remember({
      content: 'the release checklist lives in docs/release.md',
      tags: ['process:release'],
      salience: 0.6,
      eventTime: clock.now(),
    });
    await memory.maintain({ reason: 'before-reinforce' });

    clock.advance(90 * DAY_MS); // now == T0, i.e. three half-lives after the event
    const before = await memory.recall({ text: 'release checklist', tags: ['process:release'], topK: 1 });
    assert.equal(before.hits[0].decay, 0.125, '90 days = three half-lives');

    const reinforced = await memory.reinforce({ eventIds: [older.eventId] });
    assert.equal(reinforced.anchor, T0);

    const after = await memory.recall({ text: 'release checklist', tags: ['process:release'], topK: 1 });
    assert.equal(after.hits[0].eventId, older.eventId);
    assert.equal(after.hits[0].decay, 1, 'anchor = max(event_time, last reinforce log_time)');

    // The log, not a record field, is where the anchor comes from.
    const log = await memory.logStore.snapshot();
    const episode = log.records.find((record) => record.event_id === older.eventId);
    assert.equal(episode.last_reinforced_at, undefined, 'no denormalised anchor on the episode');
    assert.ok(log.records.some((record) => record.type === 'reinforce' && record.target === older.eventId));
  } finally {
    cleanup();
  }
});

test('text-only recall uses the day-block coarse stage and still ranks lexically', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    await memory.remember({ content: 'the migration runner now locks per table', tags: ['topic:db'], salience: 0.6 });
    await memory.remember({ content: 'the dashboard uses a dark theme by default', tags: ['topic:ui'], salience: 0.9 });
    await memory.maintain({ reason: 'coarse' });

    const result = await memory.recall({ text: 'migration runner table locks', topK: 5 });
    assert.equal(result.mode, 'active');
    assert.ok(
      result.notes.some((note) => note.startsWith('no-tag-match:coarse-blocks=')),
      'stage 1 announces the coarse block scan',
    );
    const migrationHit = result.hits.find((hit) => hit.snippet.includes('migration runner'));
    assert.ok(migrationHit, 'the lexically relevant episode is recalled');
    assert.ok(migrationHit.lexical > 0.3);
    const byLexical = result.hits.slice().sort((a, b) => b.lexical - a.lexical);
    assert.equal(byLexical[0].eventId, migrationHit.eventId, 'lexical similarity orders the block candidates');
    assert.ok(result.scanned.blocks <= memory.policy.candidates.blockTopK, 'only the top blocks are considered');
  } finally {
    cleanup();
  }
});

test('tag filters exclude non-matching episodes even when they score well', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    await memory.remember({ content: 'pnpm workspace protocol is required', tags: ['topic:build'], salience: 0.4 });
    await memory.remember({ content: 'pnpm has a global store setting', tags: ['topic:tooling'], salience: 0.9 });
    await memory.maintain({ reason: 'tag-filter' });

    const result = await memory.recall({ text: 'pnpm store', tags: ['topic:build'], topK: 5 });
    assert.ok(result.hits.length >= 1);
    assert.ok(result.hits.every((hit) => hit.tags.includes('topic:build')), 'tag filter is a filter, not a boost');
  } finally {
    cleanup();
  }
});

test('ghost-mid hits lose their body entirely and become one metadata hint per mid', () => {
  const ghost = {
    id: 'mid:frontend',
    name: 'frontend',
    parentId: 'root:tech',
    graceUntil: T0 + 10 * DAY_MS,
    refCount: 0,
  };
  const hits = [
    { eventId: 'e1', eventTime: T0 - 3 * DAY_MS, score: 0.9, tags: ['tech/frontend'], snippet: 'THE FADING SUMMARY TEXT' },
    { eventId: 'e2', eventTime: T0 - DAY_MS, score: 0.8, tags: ['tech/frontend'], snippet: 'ANOTHER FADING BODY' },
    { eventId: 'e3', eventTime: T0 - 2 * DAY_MS, score: 0.7, tags: ['tech/frontend/vue3'], snippet: 'a concrete leaf detail' },
    { eventId: 'e4', eventTime: T0 - 4 * DAY_MS, score: 0.6, tags: ['project:dsh'], snippet: 'a concrete flat detail' },
    { eventId: 'e5', eventTime: T0 - 5 * DAY_MS, score: 0.5, tags: ['web/frontend'], snippet: 'a different namespace, same mid name' },
  ];

  const out = degradeGhostHits(hits, [ghost], { now: T0 });

  assert.deepEqual(
    out.hits.map((hit) => hit.eventId),
    ['e3', 'e4', 'e5'],
    'direct leaf/flat/other-namespace hits survive untouched',
  );
  assert.equal(out.ghostHints.length, 1);
  const hint = out.ghostHints[0];
  assert.equal(hint.mid, 'frontend');
  assert.equal(hint.path, 'tech/frontend');
  assert.equal(hint.count, 2, 'both fading hits are counted, not listed');
  assert.equal(hint.graceDaysLeft, 10);
  assert.deepEqual(hint.tags, ['tech/frontend']);
  assert.deepEqual(hint.window, { start: T0 - 3 * DAY_MS, end: T0 - DAY_MS });
  assert.match(hint.hint, /模糊记忆/);
  assert.match(hint.hint, /共 2 条/);
  assert.match(hint.hint, /deep_raw/);
  assert.match(hint.hint, /start_time="2\d{3}-/);
  assert.equal(JSON.stringify(out).includes('FADING'), false, 'the body is REMOVED, not merely hidden');
  assert.deepEqual(out.notes, ['ghost-degraded:2:mids=1']);
});

test('ghost degradation is byte-identical when there is no ghost', () => {
  const hits = [{ eventId: 'e1', tags: ['tech/frontend'], snippet: 'kept' }];
  const out = degradeGhostHits(hits, [], { now: T0 });
  assert.equal(out.hits, hits, 'the same array is returned, no copy, no rewrite');
  assert.deepEqual(out.ghostHints, []);
  assert.deepEqual(out.notes, []);
});

test('a query that names a fading mid gets a count-0 hint instead of silence', () => {
  const ghost = {
    id: 'mid:frontend',
    name: 'frontend',
    parentId: 'root:tech',
    graceUntil: T0 + 5 * DAY_MS,
    refCount: 0,
  };
  const out = degradeGhostHits([], [ghost], { now: T0, queryTags: ['tech/frontend'] });

  assert.deepEqual(out.hits, []);
  assert.equal(out.ghostHints.length, 1);
  assert.equal(out.ghostHints[0].count, 0);
  assert.equal(out.ghostHints[0].graceDaysLeft, 5);
  assert.deepEqual(out.ghostHints[0].tags, ['tech/frontend']);
  assert.match(out.ghostHints[0].hint, /模糊记忆/);
  assert.match(out.ghostHints[0].hint, /索引中已无实体命中/);
  assert.match(out.ghostHints[0].hint, /deep_raw/);
  assert.deepEqual(out.notes, ['ghost-hints:1']);

  // Naming a path whose mid is NOT fading must stay silent.
  assert.deepEqual(degradeGhostHits([], [ghost], { now: T0, queryTags: ['tech/backend'] }).ghostHints, []);
});
