/**
 * v1.5.6 — read-time merge: a recalled monthly memo wins over the events it owns.
 *
 * The write-time claim lives in `generateMonthlyMemos`; this locks the READ side:
 * when the memo and its source events are both recalled, the owned events are
 * dropped and duplicate content collapses. Without the Orchestrator dedupe service
 * the payload shape is unchanged.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { Memory } from '../src/memory.js';
import { ContentRegistry } from '../../dsh-orchestrator/src/dedupe.js';
import { FakeClock, SMALL_POLICY, T0, tempDir } from './helpers.js';

const DAY = 86_400_000;

async function seed(memory, { monthly = true } = {}) {
  const a = await memory.remember({ content: 'shared recall token A', tags: ['topic:merge'], salience: 0.9, eventTime: T0 - 20 * DAY });
  const b = await memory.remember({ content: 'shared recall token B', tags: ['topic:merge'], salience: 0.8, eventTime: T0 - 19 * DAY });
  let memo = null;
  if (monthly) {
    memo = await memory.remember({
      content: 'shared recall token monthly summary',
      tags: ['status:monthly', 'month:2023-10'],
      salience: 0.95,
      eventTime: T0 - 10 * DAY,
      meta: { source_event_ids: [a.eventId, b.eventId].sort() },
    });
  }
  return { a, b, memo };
}

test('the memo wins over owned events and reports merge stats', async () => {
  const dir = tempDir('read-merge');
  const clock = new FakeClock(T0);
  const dedupe = new ContentRegistry();
  const memory = await Memory.open({ dataDir: dir, clock, policy: SMALL_POLICY, dedupe });
  try {
    const seeded = await seed(memory);
    await memory.maintain({ reason: 'read-merge' });
    const result = await memory.recall({ text: 'shared recall token', topK: 10 });
    assert.ok(result.merge, 'the merged payload carries stats');
    assert.ok(result.merge.droppedOwnedByMonthly >= 1, 'at least one owned event was dropped');
    assert.ok(result.merge.total >= 1);
    assert.ok(result.hits.some((hit) => hit.eventId === seeded.memo.eventId), 'the monthly memo survives');
    assert.ok(!result.hits.some((hit) => hit.eventId === seeded.a.eventId || hit.eventId === seeded.b.eventId), 'owned events are hidden');
  } finally {
    memory.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without the Orchestrator dedupe service the recall payload is unchanged', async () => {
  const dir = tempDir('read-merge-plain');
  const clock = new FakeClock(T0);
  const memory = await Memory.open({ dataDir: dir, clock, policy: SMALL_POLICY });
  try {
    await seed(memory);
    await memory.maintain({ reason: 'read-merge' });
    const result = await memory.recall({ text: 'shared recall token', topK: 10 });
    assert.equal(result.merge, undefined, 'no merge field without the service');
    assert.ok(result.hits.length >= 1);
  } finally {
    memory.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
