/**
 * L2.5 — trend quarantine.
 *
 * The scenario these tests encode: a model fed a large conversation corpus picks
 * up period "hot words" (a meme, a catchphrase, a crowd register) and hardens them
 * into user traits. The layer under test must make that impossible:
 *
 *   - a burst creates a quarantine entry, never an L3 pattern;
 *   - only late, aggregation-confirmed recurrence promotes (during maintenance);
 *   - everything else is physically purged at expiry;
 *   - recall may serve a quarantined entry, but marked `priority: 'temp'` and
 *     penalised, so it can never pass for a distilled trait.
 *
 * Every test injects FakeClock: no assertion depends on the wall clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DAY_MS, T0, makeMemory } from './helpers.js';

function tempLog(dir) {
  return path.join(dir, 'semantic', 'temp.log.jsonl');
}

test('a one-off burst is quarantined, never promoted to a trait', async () => {
  const { memory, clock, dir, cleanup } = await makeMemory();
  try {
    for (let day = 0; day < 3; day += 1) {
      clock.set(T0 + day * DAY_MS);
      await memory.remember({ content: 'everyone keeps saying "rizz" right now', tags: ['slang'], salience: 0.4, eventTime: clock.now() });
    }

    const report = await memory.maintain({ reason: 'test' });
    assert.equal(report.temp.bursts.length, 1, 'burst detection must find exactly one group');
    assert.equal(report.temp.bursts[0].count, 3);
    assert.equal(report.temp.promoted.length, 0);

    const quarantine = memory.trends({ status: 'temp' });
    assert.equal(quarantine.length, 1);
    assert.equal(quarantine[0].hitCount, 3);
    assert.equal(memory.semanticSummaries().length, 0, 'a trend must not become an L3 pattern by repetition');

    // Recall still serves it — but as a hypothesis, on a clock, and penalised.
    const result = await memory.recall({ text: 'rizz', topK: 5 });
    assert.equal(result.tempSemantic.length, 1);
    assert.equal(result.tempSemantic[0].priority, 'temp');
    assert.equal(result.tempSemantic[0].penalty, memory.policy.temp.retrievalPenalty);
    assert.equal(result.tempSemantic[0].ttlDays, memory.policy.temp.ttlDays);

    // Idempotent: re-running maintenance over the same episodes must not inflate hits.
    const again = await memory.maintain({ reason: 'test' });
    assert.equal(again.temp.promoted.length, 0);
    assert.equal(memory.trends({ status: 'temp' })[0].hitCount, 3);
    assert.equal(fs.existsSync(tempLog(dir)), true);
  } finally {
    cleanup();
  }
});

test('only late reinforcement promotes; early-only reinforcement is purged', async () => {
  const { memory, clock, dir, cleanup } = await makeMemory();
  try {
    // A: recurs on day 15 — inside the promotion window (expiry - 20d = day 10).
    await memory.remember({ content: 'trend A: "delulu"', tags: ['slang'], isTransientTrend: true, eventTime: clock.now() });
    clock.set(T0 + 15 * DAY_MS);
    await memory.remember({ content: 'trend A: "delulu"', tags: ['slang'], isTransientTrend: true, eventTime: clock.now() });

    // B: recurs on day 2 — aggregation-confirmed, but far too early to count.
    clock.set(T0 + 1 * DAY_MS);
    await memory.remember({ content: 'trend B: "skibidi"', tags: ['slang'], isTransientTrend: true, eventTime: clock.now() });
    clock.set(T0 + 2 * DAY_MS);
    await memory.remember({ content: 'trend B: "skibidi"', tags: ['slang'], isTransientTrend: true, eventTime: clock.now() });

    clock.set(T0 + 31 * DAY_MS);
    const report = await memory.maintain({ reason: 'test' });

    assert.equal(report.temp.promoted.length, 1);
    assert.equal(report.temp.purged.length, 1);

    const summaries = memory.semanticSummaries();
    assert.equal(summaries.length, 1);
    assert.match(summaries[0].title, /^Trend: /);

    const all = memory.trends();
    assert.equal(all.length, 1, 'the purged trend must be gone from the quarantine journal');
    assert.equal(all[0].status, 'permanent');
    assert.equal(all[0].promotedSummaryId, summaries[0].summaryId);
    assert.equal(all[0].promotedAt, T0 + 31 * DAY_MS);
    assert.match(fs.readFileSync(tempLog(dir), 'utf8'), /"temp_promote"/);
  } finally {
    cleanup();
  }
});

test('an unreinforced trend is deleted at expiry, leaving no trace', async () => {
  const { memory, clock, dir, cleanup } = await makeMemory();
  try {
    const opened = await memory.extractTrend({ content: 'meme: "no cap fr fr"', tags: ['slang'] });
    assert.equal(opened.action, 'observed');
    const tempId = opened.tempId;

    clock.set(T0 + 30 * DAY_MS + 1);
    const report = await memory.maintain({ reason: 'test' });

    assert.equal(report.temp.promoted.length, 0);
    assert.deepEqual(report.temp.purged, [tempId]);
    assert.equal(memory.trends().length, 0);
    assert.equal(memory.semanticSummaries().length, 0);
    assert.equal(fs.readFileSync(tempLog(dir), 'utf8').includes(tempId), false, 'purge must rewrite the journal');
  } finally {
    cleanup();
  }
});

test('a persisted trait is not resurrected as a trend by later mentions', async () => {
  const { memory, clock, cleanup } = await makeMemory();
  try {
    await memory.remember({ content: 'trend C: "aura points"', tags: ['slang'], isTransientTrend: true, eventTime: clock.now() });
    clock.set(T0 + 15 * DAY_MS);
    await memory.remember({ content: 'trend C: "aura points"', tags: ['slang'], isTransientTrend: true, eventTime: clock.now() });
    clock.set(T0 + 31 * DAY_MS);
    await memory.maintain({ reason: 'test' });
    assert.equal(memory.semanticSummaries().length, 1);

    // Months later the same phrasing shows up again: it must stay a trait and must
    // not re-enter quarantine (a promoted trend is frozen).
    clock.set(T0 + 120 * DAY_MS);
    const again = await memory.extractTrend({ content: 'trend C: "aura points"', tags: ['slang'] });
    assert.equal(again.action, 'ignored');
    assert.equal(again.reason, 'status:permanent');
    assert.equal(memory.trends({ status: 'temp' }).length, 0);
  } finally {
    cleanup();
  }
});
