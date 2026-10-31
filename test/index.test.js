/**
 * Index-layer tests: rebuildability, pointer stability, tag adjudication, budgets.
 * All clocks are injected; nothing here reads the wall clock.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FakeClock } from '../src/clock.js';
import { indexDigest } from '../src/index/buildIndex.js';
import { Memory } from '../src/memory.js';
import {
  DAY_MS,
  T0,
  lineOfEvent,
  logText,
  makeMemory,
  tempDir,
} from './helpers.js';

test('index is rebuildable: a wiped index rebuilds to an identical digest', async () => {
  const { memory, dir, cleanup } = await makeMemory({ config: { delete: { graceHours: 0 } } });
  try {
    await memory.remember({ content: 'pnpm is preferred for monorepos', tags: ['preference:tooling'], salience: 0.8 });
    await memory.remember({ content: 'the deploy step needs a manual approval', tags: ['project:dsh'], salience: 0.6 });
    await memory.remember({ content: 'daily standup is at 09:30', tags: ['habit'], salience: 0.3 });
    await memory.maintain({ reason: 'fixture' });

    const original = indexDigest(memory.indexStore.current());
    const indexDir = path.join(dir, 'index');

    // Destroy every derived file. The log is untouched.
    fs.rmSync(indexDir, { recursive: true, force: true });

    const clock = new FakeClock(T0); // same instant: rebuild must be deterministic
    const rebuilt = await Memory.open({ dataDir: dir, clock, policy: memory.policy });
    assert.equal(rebuilt.bootReport().before.status, 'missing', 'a missing index is detected at boot');
    assert.equal(rebuilt.bootReport().after.status, 'ok', 'boot recovered it without operator help');

    const report = await rebuilt.maintain({ reason: 'rebuild' });
    assert.equal(indexDigest(rebuilt.indexStore.current()), original);

    // The log digest is unchanged by a rebuild: only derived state was written.
    assert.equal(report.stats.recordCount, 3);
    rebuilt.close();
  } finally {
    cleanup();
  }
});

test('no line-number pointers: eventIds survive a rewrite while line positions drift', async () => {
  const { memory, dir, cleanup } = await makeMemory({ policy: { delete: { graceHours: 0 } } });
  try {
    const first = await memory.remember({ content: 'first episode', tags: ['stream'], salience: 0.4 });
    const second = await memory.remember({ content: 'second episode', tags: ['stream'], salience: 0.5 });
    const third = await memory.remember({ content: 'third episode', tags: ['stream'], salience: 0.6 });
    await memory.maintain({ reason: 'fixture' });

    const lineBefore = lineOfEvent(dir, second.eventId);
    assert.ok(lineBefore > 0);

    // Purge the first record: every following record moves up a line.
    await memory.forget({ eventIds: [first.eventId], reason: 'line-drift' });

    const lineAfter = lineOfEvent(dir, second.eventId);
    assert.notEqual(lineAfter, lineBefore, 'the physical position moved...');
    assert.equal(lineAfter, 1, '...and the log was rewritten without the deleted record');

    // ...yet the handle still resolves, because handles are eventIds, not positions.
    const hits = await memory.recall({ text: 'second third episode', tags: ['stream'], topK: 5 });
    const ids = hits.hits.map((hit) => hit.eventId);
    assert.deepEqual(ids.sort(), [second.eventId, third.eventId].sort());

    const indexRoot = path.join(dir, 'index');
    const gen = fs.readFileSync(path.join(indexRoot, 'CURRENT'), 'utf8').trim();
    const genDir = path.join(indexRoot, gen);
    for (const name of fs.readdirSync(genDir)) {
      const body = fs.readFileSync(path.join(genDir, name), 'utf8');
      assert.ok(!/"line"\s*:/.test(body), `${name} must not carry line pointers`);
    }
  } finally {
    cleanup();
  }
});

test('synonym groups merge into one canonical tag posting', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    await memory.remember({ content: 'compiles with ts strict mode', tags: ['ts'], salience: 0.6 });
    await memory.remember({ content: 'tsx components live in src/ui', tags: ['tsx'], salience: 0.5 });
    await memory.remember({ content: 'typescript types are erased at runtime', tags: ['typescript'], salience: 0.4 });
    await memory.maintain({ reason: 'synonyms' });

    const index = memory.indexStore.current();
    assert.ok(index.tags.typescript, 'canonical tag exists');
    assert.equal(index.tags.ts, undefined, 'alias does not get its own posting list');
    assert.equal(index.tags.tsx, undefined);
    assert.equal(index.tags.typescript.eventCount, 3);
    assert.equal(index.aliases.ts, 'typescript');
    assert.equal(index.aliases.tsx, 'typescript');

    const entries = index.activeSet.entries.filter((entry) => entry.tag === 'typescript');
    assert.equal(entries.length, 1, 'one resident task, not three');
    assert.equal(entries[0].eventCount, 3);

    // Prefix matching still finds it through the canonical name.
    const hits = await memory.recall({ tags: ['typescript'], topK: 5 });
    assert.equal(hits.hits.length, 3);
  } finally {
    cleanup();
  }
});

test('active set enforces its cap and evicts the lowest priority × decay', async () => {
  const { memory, cleanup } = await makeMemory({
    policy: { activeSet: { cap: 2, minEvents: 1, minMass: 0.01 } },
  });
  try {
    await memory.remember({ content: 'critical preference', tags: ['rank:critical'], salience: 0.95 });
    await memory.remember({ content: 'useful habit', tags: ['rank:useful'], salience: 0.7 });
    await memory.remember({ content: 'minor note', tags: ['rank:minor'], salience: 0.4 });
    await memory.remember({ content: 'noise', tags: ['rank:noise'], salience: 0.2 });
    await memory.maintain({ reason: 'cap' });

    const index = memory.indexStore.current();
    const kept = index.activeSet.entries;
    assert.equal(kept.length, 2, 'budget is measured in resident entries and is hard');
    assert.deepEqual(kept.map((entry) => entry.tag).sort(), ['rank:critical', 'rank:useful']);
    assert.equal(index.activeSet.evicted.length, 2);
    assert.ok(index.activeSet.evicted.every((entry) => entry.reason === 'over-cap'));

    const key = (entry) => entry.priority * entry.decayScore;
    const minKept = Math.min(...kept.map(key));
    const maxEvicted = Math.max(...index.activeSet.evicted.map(key));
    assert.ok(minKept >= maxEvicted, 'eviction order is priority × decay ascending');
    assert.ok(index.activeSet.budgetUsed >= kept.length, 'each entry carries a derived candidate budget');
  } finally {
    cleanup();
  }
});

test('changing adjudication rules re-derives the active set without rewriting the log', async () => {
  const { memory, dir, cleanup } = await makeMemory();
  try {
    await memory.remember({ content: 'one mention of the cache', tags: ['topic:cache'], salience: 0.5 });
    await memory.remember({ content: 'another cache mention', tags: ['topic:cache'], salience: 0.5 });
    await memory.remember({ content: 'single mention of retries', tags: ['topic:retries'], salience: 0.5 });
    await memory.maintain({ reason: 'before-policy-change' });

    const logBefore = logText(dir);
    const activeBefore = memory.indexStore.current().activeSet.entries.map((entry) => entry.tag).sort();
    assert.deepEqual(activeBefore, ['topic:cache', 'topic:retries']);

    // Rule change only: a tag now needs two events to stay resident.
    const hash = memory.setPolicy({ activeSet: { minEvents: 2, minMass: 0.01 } });
    const report = await memory.maintain({ reason: 'policy-change' });

    assert.equal(logText(dir), logBefore, 'the truth source is byte-identical after a rule change');
    const activeAfter = memory.indexStore.current().activeSet.entries.map((entry) => entry.tag);
    assert.deepEqual(activeAfter, ['topic:cache']);
    assert.equal(report.activeSet.before, 2);
    assert.equal(report.activeSet.after, 1);
    assert.deepEqual(report.activeSet.churn.dropped, ['topic:retries']);
    assert.ok(
      memory.indexStore.current().activeSet.belowThreshold.some((entry) => entry.tag === 'topic:retries'),
      'the dropped tag is reported as below-threshold, not deleted',
    );
    assert.equal(memory.indexStore.current().policyHash, hash);
  } finally {
    cleanup();
  }
});

test('an empty active set degrades to recent day blocks with an explicit mode', async () => {
  const { memory, clock, cleanup } = await makeMemory({
    // No tag can ever qualify: the resident set stays empty on purpose.
    policy: { activeSet: { minEvents: 99, minMass: 99 }, retrieval: { degradedRecentBlocks: 2 } },
  });
  try {
    await memory.remember({ content: 'alpha decision was recorded today', tags: ['topic:alpha'], salience: 0.7 });
    clock.set(T0 - DAY_MS);
    await memory.remember({ content: 'beta decision from yesterday', tags: ['topic:beta'], salience: 0.5 });
    clock.set(T0 - 30 * DAY_MS);
    await memory.remember({ content: 'ancient gamma decision', tags: ['topic:gamma'], salience: 0.9 });
    clock.set(T0);
    await memory.maintain({ reason: 'degrade' });

    assert.equal(memory.indexStore.current().activeSet.entries.length, 0);

    // No tag filter at all: the degraded path must find candidates on its own.
    const result = await memory.recall({ text: 'decision', topK: 10 });
    assert.equal(result.mode, 'degraded');
    assert.equal(result.degradedReason, 'empty-active-set');
    assert.ok(result.hits.length > 0, 'never silently empty');
    assert.ok(
      result.notes.some((note) => note.startsWith('degraded:')),
      'the fallback is announced, not silent',
    );
    // Only the two most recent day blocks are scanned; the 30-day-old one is not.
    assert.ok(!result.hits.some((hit) => hit.snippet.includes('ancient')), 'no full scan of the log');
  } finally {
    cleanup();
  }
});

test('top-k is bounded, sorted and deduplicated', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    for (let i = 0; i < 6; i += 1) {
      await memory.remember({ content: `event number ${i} about the queue`, tags: ['queue'], salience: 0.3 + i * 0.1 });
    }
    await memory.maintain({ reason: 'topk' });

    const result = await memory.recall({ text: 'queue', tags: ['queue'], topK: 3 });
    assert.equal(result.hits.length, 3);
    const scores = result.hits.map((hit) => hit.score);
    assert.deepEqual(scores, scores.slice().sort((a, b) => b - a), 'descending score');
    assert.equal(new Set(result.hits.map((hit) => hit.eventId)).size, 3, 'no duplicate episodes');

    const wide = await memory.recall({ text: 'queue', tags: ['queue'], topK: 500 });
    assert.ok(wide.hits.length <= 6);
    assert.ok(wide.hits.length <= memory.policy.candidates.maxTopK, 'hard cap applies');

    const zero = await memory.recall({ text: 'queue', tags: ['queue'], topK: 0 });
    assert.ok(
      zero.hits.length <= memory.policy.candidates.topK,
      'top-k=0 falls back to the configured default budget, not to "everything"',
    );
  } finally {
    cleanup();
  }
});
