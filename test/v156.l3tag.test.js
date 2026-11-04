/**
 * v1.5.6 — L3 semantic tag invariant.
 *
 * Locked contracts:
 *   1. the explicit `SemanticStore.upsert` refuses untagged summaries with
 *      MEM_E_SEMANTIC_TAG_REQUIRED (tag-driven retrieval could never reach them);
 *   2. the OFFLINE paths never fail maintenance: delete-consolidation derives tags
 *      from content heuristics, then falls back to a provenance anchor;
 *   3. trend promotion does the same before writing L3;
 *   4. historical untagged summaries stay readable but are marked `degraded: true`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DAY_MS, T0, makeMemory } from './helpers.js';

test('the explicit L3 upsert refuses untagged summaries', async () => {
  const fixture = await makeMemory();
  try {
    const store = fixture.memory.semanticStore;
    assert.throws(
      () => store.upsert({ clock: fixture.clock, title: 'Pattern: none', text: 'text', tags: [] }),
      (error) => error.code === 'MEM_E_SEMANTIC_TAG_REQUIRED' && error.details?.title === 'Pattern: none',
    );
    const ok = store.upsert({ clock: fixture.clock, title: 'Pattern: release', text: 'text', tags: ['Lesson:Release'] });
    assert.deepEqual(ok.tags, ['lesson:release'], 'tags are normalised');
    assert.equal(ok.degraded, false);
  } finally {
    fixture.cleanup();
  }
});

test('delete-consolidation derives tags instead of writing dead knowledge', async () => {
  const fixture = await makeMemory();
  try {
    const store = fixture.memory.semanticStore;
    const derived = store.ensureForEvent({
      nextId: store,
      clock: fixture.clock,
      event: { event_id: 'ev_type_error', content: 'TypeError: querySelector is not a function', salience: 0.9, tags: [] },
    });
    assert.deepEqual(derived.tags, ['error:typeerror'], 'content heuristics provide the anchor');
    assert.match(derived.title, /\(derived\)/);

    const fallback = store.ensureForEvent({
      nextId: store,
      clock: fixture.clock,
      event: { event_id: 'ev_plain', content: '随便聊聊天气', salience: 0.8, tags: [] },
    });
    assert.deepEqual(fallback.tags, ['origin:unlabelled-episode'], 'an explicit provenance anchor is better than nothing');
    assert.equal(store.covers('ev_plain').length, 1, 'the delete pipeline coverage gate still passes');
  } finally {
    fixture.cleanup();
  }
});

test('trend promotion with no tags derives them before writing L3', async () => {
  const fixture = await makeMemory();
  try {
    const trend = 'TypeError: 上游超时';
    await fixture.memory.extractTrend({ content: trend, sourceEvents: ['ev_trend_1'], tags: [], occurredAt: T0, ttlDays: 30 });
    fixture.clock.advance(25 * DAY_MS);
    await fixture.memory.extractTrend({
      content: trend,
      sourceEvents: ['ev_trend_2'],
      tags: [],
      occurredAt: fixture.clock.now(),
      ttlDays: 30,
    });
    fixture.clock.advance(6 * DAY_MS);
    await fixture.memory.maintain({ reason: 'l3-promote' });

    const summaries = fixture.memory.semanticSummaries();
    const promoted = summaries.find((summary) => summary.title.startsWith('Trend:'));
    assert.ok(promoted, 'the confirmed trend was promoted to L3');
    assert.ok(promoted.tags.length > 0, 'promotion never writes an untagged summary');
    assert.ok(promoted.tags.includes('error:typeerror'), 'content heuristics supplied the anchor');
    assert.equal(promoted.degraded, false);
  } finally {
    fixture.cleanup();
  }
});

test('historical untagged summaries are readable but flagged degraded', async () => {
  const fixture = await makeMemory();
  try {
    const file = path.join(fixture.dir, 'semantic', 'sem.log.jsonl');
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        v: 1,
        type: 'semantic_upsert',
        summary_id: 'sm_legacy',
        title: 'Pattern: legacy',
        text: 'written before the tag invariant',
        confidence: 0.5,
        tags: [],
        source_events: [],
        first_seen_at: T0,
        event_time: T0,
        log_time: T0,
        event_id: 'ev_legacy_summary',
      })}\n`,
      'utf8',
    );
    const listed = fixture.memory.semanticStore.list().find((summary) => summary.summaryId === 'sm_legacy');
    assert.ok(listed, 'the historical summary is readable');
    assert.equal(listed.degraded, true, 'it is marked degraded, not silently rewritten');
    const viaMemory = fixture.memory.semanticSummaries().find((summary) => summary.summaryId === 'sm_legacy');
    assert.equal(viaMemory.degraded, true);
  } finally {
    fixture.cleanup();
  }
});
