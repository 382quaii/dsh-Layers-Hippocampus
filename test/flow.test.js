/**
 * Memory flow: context folding, graph association, monthly memos.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { FOLDED_TAG, FOLD_BATCH, MONTHLY_TAG } from '../src/memory.js';
import { DAY_MS, makeMemory, T0 } from './helpers.js';

test('folding turns evicted context blocks into one status:folded episode', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    // Small window: two fat blocks force one eviction.
    for (let i = 0; i < 2; i += 1) {
      memory.context.inject({
        id: `block-${i}`,
        text: `任务：完成发布检查 ${i}。要点：@Alice 负责验证。`.repeat(20),
        tokens: 4000,
        salience: 0.1 + i * 0.01,
      });
    }
    const report = memory.context.enforce({ now: T0 });
    assert.ok(report.evicted.length > 0, 'the window really evicted a block');
    assert.ok(report.evicted[0].text, 'the eviction record carries the text');

    const folded = await memory.foldEvicted(report.evicted);
    assert.equal(folded.folded, Math.min(report.evicted.length, FOLD_BATCH));

    const view = memory.indexManager.snapshot();
    const memo = view.events.find((event) => event.tags.some((tag) => tag.tag === FOLDED_TAG));
    assert.ok(memo, 'the folded summary is a real event');
    assert.match(memo.content, /折叠摘要/);
    assert.match(memo.content, /Alice/);
    assert.match(memo.content, /完成发布检查/);

    // Folding twice must not duplicate: ids are remembered per process.
    const again = await memory.foldEvicted(report.evicted);
    assert.equal(again, null);
  } finally {
    cleanup();
  }
});

test('graph association recalls a neighbour event with a 0.5 penalty', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    await memory.remember({ content: 'alpha and beta met in the bridge event', tags: ['topic:a', 'topic:b'], salience: 0.8 });
    await memory.remember({ content: 'beta-only followup note', tags: ['topic:b'], salience: 0.8 });
    await memory.maintain({ reason: 'graph' });

    const graph = memory.graph.read();
    assert.ok(graph && graph.edges.some((edge) => [edge.source, edge.target].sort().join('|') === 'topic:a|topic:b'), 'graph has the a-b edge');

    const result = await memory.recall({ tags: ['topic:a'], topK: 10 });
    assert.ok(result.associations.length >= 1, 'the query woke a neighbour');

    const neighbour = result.hits.find((hit) => hit.snippet.includes('beta-only'));
    assert.ok(neighbour, 'the neighbour event was recalled');
    assert.equal(neighbour.association.via, 'topic:a');
    assert.equal(neighbour.association.penalty, 0.5);

    // A direct hit is never penalised.
    const direct = result.hits.find((hit) => hit.snippet.includes('bridge event'));
    assert.equal(direct.association, undefined);
    assert.ok(direct.score > neighbour.score, 'association ranks below a direct hit');
  } finally {
    cleanup();
  }
});

test('a completed month becomes a monthly memo once, and it does not decay', async () => {
  const { memory, clock, cleanup } = await makeMemory({
    policy: { activeSet: { minEvents: 1, minMass: 0.01 }, identity: { eventTimePolicy: 'explicit' } },
  });
  try {
    // Two October events, then "now" is November: October is complete.
    await memory.remember({ content: 'october kickoff meeting', tags: ['project:october'], eventTime: Date.UTC(2023, 9, 3), happenedAt: Date.UTC(2023, 9, 3) });
    await memory.remember({ content: 'october release shipped', tags: ['project:october'], eventTime: Date.UTC(2023, 9, 20), happenedAt: Date.UTC(2023, 9, 20) });
    clock.set(T0);

    const report = await memory.maintain({ reason: 'monthly' });
    assert.equal(report.monthly.generated, 1);
    assert.deepEqual(report.monthly.months, ['2023-10']);

    const view = memory.indexManager.snapshot();
    const memo = view.events.find((event) => event.tags.some((tag) => tag.tag === MONTHLY_TAG));
    assert.ok(memo, 'the memo is a durable event');
    assert.match(memo.content, /月度记忆 2023-10/);
    assert.match(memo.content, /project:october/);

    const state = JSON.parse(fs.readFileSync(memory.monthlyStatePath(), 'utf8'));
    assert.deepEqual(state.months, ['2023-10']);

    // Idempotent: a second maintenance does not write a second memo.
    const again = await memory.maintain({ reason: 'monthly-again' });
    assert.equal(again.monthly.generated, 0);
    assert.equal(view.events.filter((event) => event.tags.some((tag) => tag.tag === MONTHLY_TAG)).length, 1);

    // Fuzzy historical query pulls the memo in; monthly memos never decay.
    const fuzzy = await memory.recall({ text: '上个月做了什么', topK: 10 });
    const memoHit = fuzzy.hits.find((hit) => hit.monthly === true);
    assert.ok(memoHit, 'a fuzzy time query recalls the monthly memo');
    assert.equal(memoHit.decay, 1, 'monthly memos do not participate in daily decay');
  } finally {
    cleanup();
  }
});
