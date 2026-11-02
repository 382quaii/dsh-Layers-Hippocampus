/**
 * Ghost-mid recall degradation (anti-hallucination contract).
 *
 * The tag tree is a derived CACHE written by maintenance. Between two passes the
 * index can already hold new events whose tag path overlaps a subtree the cache
 * still calls a ghost. That window is exactly where a broad mid-level memory must
 * not be injected as if its detail still existed: recall replaces it with metadata
 * and points at deep_raw.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { DAY_MS, makeMemory } from './helpers.js';

async function purge(memory, eventIds) {
  return memory.deletePipeline.request({ eventIds, mode: 'purge', reason: 'ghost-recall-test' });
}

/** Baseline has a live leaf under tech/frontend; purging it ghosts the mid. */
async function makeGhostMid() {
  const cage = await makeMemory();
  const old = await cage.memory.remember({
    content: 'Vue3 构建链使用 vite 插件完成打包',
    tags: ['tech/frontend/vue3'],
    salience: 0.8,
  });
  await cage.memory.maintain({ reason: 'baseline' });
  await purge(cage.memory, [old.eventId]);
  await cage.memory.maintain({ reason: 'ghost' });
  assert.equal(cage.memory.ghostHints().length, 1, 'the mid is inside its grace window');
  return { ...cage, old };
}

test('a fading mid degrades its hit to metadata while concrete hits keep their body', async () => {
  const { memory, cleanup } = await makeGhostMid();
  try {
    const keep = await memory.remember({
      content: '项目资料：DSH 插件的发布约定',
      tags: ['project:dsh'],
      salience: 0.6,
    });
    const broad = await memory.remember({
      content: '前端体系涉及 Vue3 与构建链的约定',
      tags: ['tech/frontend'],
      salience: 0.9,
    });

    const result = await memory.recall({ text: '约定', topK: 5 });

    assert.deepEqual(
      result.hits.map((hit) => hit.eventId),
      [keep.eventId],
      'the concrete flat hit survives; the fading mid-level hit does not',
    );
    assert.equal(result.ghostHints.length, 1);
    const hint = result.ghostHints[0];
    assert.equal(hint.mid, 'frontend');
    assert.equal(hint.path, 'tech/frontend');
    assert.equal(hint.count, 1);
    assert.equal(hint.graceDaysLeft, 30, 'the grace clock started on the death pass');
    const dayStart = Date.parse('2023-11-14T00:00:00.000Z');
    assert.deepEqual(hint.window, { start: dayStart, end: dayStart + DAY_MS - 1 }, 'deep_raw window = the diary day, not the event_time coordinate');
    assert.match(hint.hint, /模糊记忆/);
    assert.match(hint.hint, /共 1 条/);
    assert.match(hint.hint, /deep_raw/);
    assert.ok(result.notes.includes('ghost-degraded:1:mids=1'));

    // The body must be ABSENT, not merely flag-hidden: nothing in the payload may
    // carry the fading summary text into the model context.
    assert.equal(JSON.stringify(result).includes('体系涉及'), false);
    assert.deepEqual(result.hits[0].tags, ['project:dsh']);

    const panel = (await memory.status()).panel;
    assert.equal(panel.tagTree.available, true);
    assert.equal(panel.tagTree.ghostCount, 1, 'the panel exposes the ghost count');
  } finally {
    cleanup();
  }
});

test('a tag-filtered recall aggregates every fading hit into one hint, with no hits', async () => {
  const { memory, cleanup } = await makeGhostMid();
  try {
    // Naming the fading mid itself is not an empty answer: count 0, metadata only.
    const empty = await memory.recall({ tags: ['tech/frontend'], text: '前端体系', topK: 5 });
    assert.deepEqual(empty.hits, []);
    assert.equal(empty.ghostHints.length, 1, 'naming a fading mid returns metadata, not silence');
    assert.equal(empty.ghostHints[0].count, 0);
    assert.match(empty.ghostHints[0].hint, /模糊记忆/);
    assert.ok(empty.notes.includes('ghost-hints:1'));

    await memory.remember({ content: '前端体系第一条约定', tags: ['tech/frontend'], salience: 0.9 });
    await memory.remember({ content: '前端体系第二条约定', tags: ['tech/frontend'], salience: 0.7 });

    const result = await memory.recall({ tags: ['tech/frontend'], text: '前端体系', topK: 5 });

    assert.deepEqual(result.hits, [], 'nothing concrete is served for a ghost mid');
    assert.equal(result.ghostHints.length, 1);
    assert.equal(result.ghostHints[0].count, 2);
    assert.deepEqual(result.ghostHints[0].tags, ['tech/frontend']);
    assert.equal(JSON.stringify(result).includes('第一条约定'), false);
    assert.equal(JSON.stringify(result).includes('第二条约定'), false);
    assert.ok(result.notes.includes('ghost-degraded:2:mids=1'));
  } finally {
    cleanup();
  }
});

test('the next maintenance revives the mid and the body is served again', async () => {
  const { memory, cleanup } = await makeGhostMid();
  try {
    const broad = await memory.remember({
      content: '前端体系涉及 Vue3 与构建链的约定',
      tags: ['tech/frontend'],
      salience: 0.9,
    });
    const degraded = await memory.recall({ tags: ['tech/frontend'], topK: 5 });
    assert.deepEqual(degraded.hits, []);

    await memory.maintain({ reason: 'revive' });

    assert.deepEqual(memory.ghostHints(), [], 'a mounted memory revives the mid');
    const after = await memory.recall({ tags: ['tech/frontend'], topK: 5 });
    assert.deepEqual(after.ghostHints, []);
    assert.equal(after.hits.length, 1);
    assert.equal(after.hits[0].eventId, broad.eventId);
    assert.match(after.hits[0].snippet, /前端体系/);
    assert.equal((await memory.status()).panel.tagTree.ghostCount, 0);

    // The fading leaf's old window is gone with the ghost: no stale hint is served.
    assert.equal(after.notes.some((note) => note.startsWith('ghost-degraded:')), false);
  } finally {
    cleanup();
  }
});
