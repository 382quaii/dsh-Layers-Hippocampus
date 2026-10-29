/**
 * Retrieval tests: decay arithmetic, reinforcement anchoring, coarse recall.
 * Time is always injected; the half-life assertions are exact arithmetic.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
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
