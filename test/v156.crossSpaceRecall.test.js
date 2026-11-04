/**
 * v1.5.6 — cross-space recall aggregation.
 *
 * With the Orchestrator dedupe service installed, one recall queries every open
 * space, tags each hit with its `spaceId`, and folds the union through the same
 * `mergeForRead()` used by the single-space path (a monthly memo hides the events
 * it owns, even when the memo and the events live in different spaces).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentRegistry } from '../../dsh-orchestrator/src/dedupe.js';
import { makeMemory, T0 } from './helpers.js';

const DAY = 86_400_000;

test('recallAcrossSpaces returns hits from every space with provenance', async () => {
  const dedupe = new ContentRegistry();
  const fixture = await makeMemory({ dedupe });
  try {
    const { memory } = fixture;
    await memory.createSpace('work');
    await memory.remember({ content: 'shared recall token default', tags: ['topic:cross'], eventTime: T0 - 20 * DAY });
    await memory.remember({ targetSpaceId: 'work', content: 'shared recall token work', tags: ['topic:cross'], eventTime: T0 - 19 * DAY });
    await memory.maintain({ reason: 'cross-space' });
    await memory.spaces.run('work', (target) => target.maintain({ reason: 'cross-space' }));

    const result = await memory.recallAcrossSpaces({ text: 'shared recall token', topK: 10 });
    assert.equal(result.crossSpace, true);
    assert.ok(result.spaces.includes('default') && result.spaces.includes('work'));
    assert.ok(result.hits.length >= 2);
    assert.ok(result.hits.some((hit) => hit.spaceId === 'work'), 'the work-space hit is included');
    assert.ok(result.hits.some((hit) => hit.spaceId === 'default'), 'the default-space hit is included');
  } finally {
    fixture.cleanup();
  }
});

test('a monthly memo hides its owned events across spaces', async () => {
  const dedupe = new ContentRegistry();
  const fixture = await makeMemory({ dedupe });
  try {
    const { memory } = fixture;
    await memory.createSpace('work');
    const owned = await memory.remember({ content: 'shared recall token owned record', tags: ['topic:cross'], eventTime: T0 - 20 * DAY });
    await memory.remember({
      content: 'shared recall token monthly summary',
      tags: ['status:monthly', 'month:2023-10', 'topic:cross'],
      eventTime: T0 - 10 * DAY,
      meta: { source_event_ids: [owned.eventId] },
    });
    await memory.remember({ targetSpaceId: 'work', content: 'shared recall token work record', tags: ['topic:cross'], eventTime: T0 - 19 * DAY });
    await memory.maintain({ reason: 'cross-space' });
    await memory.spaces.run('work', (target) => target.maintain({ reason: 'cross-space' }));

    const result = await memory.recallAcrossSpaces({ text: 'shared recall token', topK: 10 });
    assert.ok(result.merge, 'merge stats are reported');
    assert.ok(result.merge.droppedOwnedByMonthly >= 1);
    assert.ok(!result.hits.some((hit) => hit.eventId === owned.eventId), 'owned event is hidden');
    assert.ok(result.hits.some((hit) => hit.spaceId === 'work'), 'the other space still contributes');
  } finally {
    fixture.cleanup();
  }
});
