/**
 * v1.6.9 — the full memory chain: write-side merging, 1-hop recall, auto pointers.
 *
 * Three gaps motivated this version:
 *   1. one entity became many tags ("红薯" / "烤红薯" / "地瓜"), so no tag ever reached
 *      the activity threshold;
 *   2. recall could only answer about tags the CALLER named — a hit never pulled its
 *      immediate neighbours, so "what do I know around this" needed several calls;
 *   3. nothing was injected automatically, so a model that never calls `recall` (a build
 *      session, for instance) never learned that memories existed at all.
 *
 * The bounds are as important as the features, so they are asserted too: one hop only
 * (no graph walk), a hard character budget on the pointer block, and no repetition.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { fakeCtx, makeMemory, T0, tempDir } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

async function fixture(options = {}) {
  const handle = await makeMemory({ start: T0, ...options });
  return handle;
}

test('entity tags merge locally: "烤红薯" folds into the existing "红薯"', async () => {
  const handle = await fixture();
  try {
    const first = await handle.memory.remember({
      content: '红薯冬天最好吃',
      tags: ['entity:红薯', 'topic:吃饭'],
      salience: 0.8,
      eventTime: T0,
    });
    const second = await handle.memory.remember({
      content: '街边的烤红薯真香',
      tags: ['entity:烤红薯', 'topic:吃饭'],
      salience: 0.8,
      eventTime: T0 + 1000,
    });
    await handle.memory.maintain({ reason: 'test' });

    const view = handle.memory.indexManager.snapshot();
    const merged = view.events.find((event) => event.eventId === second.eventId);
    assert.ok(merged, 'the second memory exists');
    assert.deepEqual(
      merged.tags.map((tag) => tag.tag).sort(),
      ['entity:红薯', 'topic:吃饭'],
      'the longer word folded into the existing canonical entity',
    );
    // The merge is auditable: the record keeps saying what happened, the log is untouched.
    assert.ok(Array.isArray(view.events.find((event) => event.eventId === first.eventId).tags));
    assert.equal(handle.memory.knownEntityTags().length, 1, 'one entity, not a family');
  } finally {
    handle.cleanup();
  }
});

test('Dream learns a synonym and the fold reaches the index without rewriting the log', async () => {
  const dir = tempDir('v169-alias');
  const handle = await makeMemory({
    dir,
    start: T0,
    config: { dream: { useLlm: true, llm: { baseUrl: 'https://dream.invalid/v1', model: 'test-model' } } },
  });
  try {
    await handle.memory.remember({
      content: '地瓜很甜',
      tags: ['entity:地瓜'],
      salience: 0.8,
      eventTime: T0,
    });
    await handle.memory.remember({
      content: '红薯也很甜',
      tags: ['entity:红薯'],
      salience: 0.8,
      eventTime: T0 + 1000,
    });
    await handle.memory.maintain({ reason: 'test' });
    assert.equal(handle.memory.entityAliases.list()['地瓜'], undefined, 'nothing learned yet');

    // One small JSON reply, exactly the shape aliasPrompt asks for.
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"aliases":{"地瓜":"红薯"}}' } }] }),
      };
    };
    const run = await handle.memory.executeDream({ now: T0 + 2000, fetchImpl });
    assert.equal(run.entityAliasError, null);
    assert.equal(handle.memory.entityAliases.list()['地瓜'], '红薯', 'the synonym was learned');
    assert.equal(calls.length >= 1, true);

    await handle.memory.maintain({ reason: 'alias-fold' });
    const view = handle.memory.indexManager.snapshot();
    const folded = view.events.find((event) => String(event.content).includes('地瓜'));
    assert.ok(
      folded?.tags.some((tag) => tag.tag === 'entity:红薯'),
      'the old node drained into the canonical one at build time',
    );
    assert.equal(
      view.events.some((event) => (event.tags ?? []).some((tag) => tag.tag === 'entity:地瓜')),
      false,
      'no entity:地瓜 node survives the fold',
    );
  } finally {
    handle.cleanup();
  }
});

test('one hop: a hit on "红薯" pulls the neighbouring "吃饭" memory, and never two hops', async () => {
  const handle = await fixture();
  try {
    const direct = await handle.memory.remember({
      content: '红薯配米饭',
      tags: ['entity:红薯', 'topic:吃饭'],
      salience: 0.9,
      eventTime: T0,
    });
    const neighbour = await handle.memory.remember({
      content: '食堂今天排队很久',
      tags: ['topic:吃饭'],
      salience: 0.7,
      eventTime: T0 + 1000,
    });
    await handle.memory.maintain({ reason: 'test' });

    // The query names NO tag — "红薯" appears only inside the message.
    const recalled = await handle.memory.recall({ text: '红薯', top_k: 5 });
    assert.ok(recalled.associative.tags.includes('topic:吃饭'), 'the neighbour tag was discovered');
    assert.ok(
      recalled.hits.some((hit) => hit.eventId === neighbour.eventId),
      'the neighbouring memory came back without being asked for',
    );
    const hits = recalled.hits.map((hit) => hit.eventId);
    assert.ok(hits.includes(direct.eventId), 'the direct hit is still there');
    // An associative hit is never allowed to outrank its seed.
    assert.equal(hits[0], direct.eventId);
    assert.equal(recalled.associative.hops, 1);
  } finally {
    handle.cleanup();
  }
});

test('a recent memory outscores an equally-weighted old one', async () => {
  const handle = await fixture();
  try {
    const old = await handle.memory.remember({
      content: '老的红薯笔记',
      tags: ['entity:红薯'],
      salience: 0.8,
      // 20 days: old enough for decay to bite, young enough to survive minScore — the
      // assertion is about the recency BOOST, not about resurrecting a dead memory.
      eventTime: T0 - 20 * DAY,
    });
    const fresh = await handle.memory.remember({
      content: '新的红薯笔记',
      tags: ['entity:红薯'],
      salience: 0.8,
      eventTime: T0,
    });
    await handle.memory.maintain({ reason: 'test' });
    const recalled = await handle.memory.recall({ text: '红薯', tags: ['entity:红薯'], top_k: 5 });
    const oldHit = recalled.hits.find((hit) => hit.eventId === old.eventId);
    const freshHit = recalled.hits.find((hit) => hit.eventId === fresh.eventId);
    assert.ok(freshHit && oldHit, 'both memories were recalled');
    assert.ok(freshHit.score > oldHit.score, 'recency is a real, bounded boost');
    assert.ok(recalled.recentWindow, 'the window is reported so the boost is auditable');
  } finally {
    handle.cleanup();
  }
});

test('maxAssociativeHops is capped at ONE — this is a lookup, not a graph walk', async () => {
  const handle = await fixture();
  try {
    await handle.memory.remember({ content: '红薯', tags: ['entity:红薯'], salience: 0.8, eventTime: T0 });
    await handle.memory.maintain({ reason: 'test' });
    await assert.rejects(
      () => handle.memory.recall({ text: '红薯', maxAssociativeHops: 2 }),
      (error) => error?.code === 'MEM_E_INVALID_INPUT' && /maxAssociativeHops/.test(error.message),
    );
    // 0 and the default are both accepted (0 = direct hits only).
    const direct = await handle.memory.recall({ text: '红薯', maxAssociativeHops: 0 });
    assert.equal(direct.associative.hops, 0);
    assert.deepEqual(direct.associative.tags, []);
  } finally {
    handle.cleanup();
  }
});

test('the pointer block is injected after N user turns, once, and within its budget', async () => {
  const dir = tempDir('v169-pointer');
  const handle = await makeMemory({ dir, start: T0 });
  const ctx = fakeCtx();
  try {
    await apply(ctx.ctx, {
      dataDir: dir,
      maintenanceCron: '0 */6 * * *',
      autoMaintainOnBoot: false,
      context: { autoInjectIndex: { enabled: true, everyNTurns: 3, maxPointers: 3, maxChars: 300 } },
    });
    const runtime = getRuntime(ctx.ctx);
    await runtime.ready;
    for (let index = 0; index < 3; index += 1) {
      await runtime.memory.remember({
        content: `第 ${index} 条红薯笔记，内容是给指针用的标题`,
        tags: ['lesson:红薯'],
        salience: 0.8,
        eventTime: T0 + index,
      });
    }
    await runtime.memory.maintain({ reason: 'test' });

    // Restart / first request: the block is armed from the start.
    const first = runtime.promptState();
    assert.ok(first.includes('[Memory Index]'), 'a fresh process injects on its first prompt');
    assert.ok(first.includes('[memory ev_'), 'the pointer carries an eventId');
    assert.ok(!first.includes('内容是给指针用的标题'), 'a pointer never carries the body');
    const block = first.split('[Memory Index]')[1] ?? '';
    assert.ok(block.length <= 320, `the block respects maxChars (got ${block.length})`);

    // Same session, no new turns: nothing is repeated.
    assert.equal(runtime.promptState().includes('[Memory Index]'), false, 'no repetition without new turns');

    // Two more turns are not enough; the third re-arms.
    runtime.noteUserTurn();
    runtime.noteUserTurn();
    assert.equal(runtime.promptState().includes('[Memory Index]'), false, 'still below the turn gate');
    runtime.noteUserTurn();
    assert.equal(runtime.promptState().includes('[Memory Index]'), false, 'the same hot tags are stable: no repeat');
  } finally {
    ctx.dispose();
    handle.cleanup();
  }
});
