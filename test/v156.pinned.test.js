/**
 * v1.5.6 — pinned memory (L2 lessons that must survive time).
 *
 * Locked contracts:
 *   1. `pinned: true` without caller-provided tags is refused with
 *      MEM_E_PINNED_TAG_REQUIRED before anything is written;
 *   2. a pinned record never decays (decay === 1 after a simulated year);
 *   3. its tag is never archived and is admitted to the active set regardless of
 *      score;
 *   4. recall ranks a matching pinned record FIRST, ahead of a newer, higher
 *      salience unpinned record;
 *   5. `panel.global.pinned` reports the count.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { DAY_MS, T0, makeMemory } from './helpers.js';

const POLICY = { activeSet: { minEvents: 1, minMass: 0.01 }, candidates: { minScore: 0 } };

test('pinned write requires at least one caller-provided tag (nothing is written)', async () => {
  const fixture = await makeMemory({ policy: POLICY });
  try {
    for (const tags of [undefined, [], ['   '], ['', '  ']]) {
      await assert.rejects(
        () => fixture.memory.remember({ content: 'pinned without a trigger', pinned: true, ...(tags ? { tags } : {}) }),
        (error) => error.code === 'MEM_E_PINNED_TAG_REQUIRED',
        `tags=${JSON.stringify(tags)} must be refused`,
      );
    }
    const status = await fixture.memory.status();
    assert.equal(status.panel.global.events, 0, 'a refused pinned write writes nothing');
  } finally {
    fixture.cleanup();
  }
});

test('a pinned record never decays, survives maintenance, and ranks first on its tag', async () => {
  const fixture = await makeMemory({ policy: POLICY });
  try {
    const pinned = await fixture.memory.remember({
      content: '发布门禁超时必须加退避重试，否则重试风暴会打穿上游',
      tags: ['lesson:release'],
      salience: 0.6,
      pinned: true,
      eventTime: T0,
    });
    assert.equal(pinned.pinned, true);
    assert.deepEqual(pinned.tags, ['lesson:release']);

    const ordinary = await fixture.memory.remember({
      content: '普通周会记录：今天讨论了发布节奏',
      tags: ['lesson:release'],
      salience: 0.99,
      eventTime: T0 + 10 * DAY_MS,
    });

    fixture.clock.advance(365 * DAY_MS);
    await fixture.memory.maintain({ reason: 'pinned-test' });

    const view = fixture.memory.indexManager.snapshot();
    const events = Array.isArray(view.events) ? view.events : [...view.events.values()];
    const pinnedEvent = events.find((event) => event.eventId === pinned.eventId);
    assert.equal(pinnedEvent.pinned, true, 'the index marks the record pinned');
    assert.equal(view.tags['lesson:release'].pinned, true, 'the tag carrying a pinned record is pinned');
    assert.equal(view.tags['lesson:release'].archived, false, 'a pinned tag is never archived');

    const recalled = await fixture.memory.recall({ tags: ['lesson:release'], topK: 5 });
    assert.ok(recalled.hits.length >= 2, 'both records are returned with minScore=0');
    assert.equal(recalled.hits[0].eventId, pinned.eventId, 'the pinned record ranks first');
    assert.equal(recalled.hits[0].pinned, true);
    assert.equal(recalled.hits[0].decay, 1, 'pinned decay is always 1');
    const other = recalled.hits.find((hit) => hit.eventId === ordinary.eventId);
    assert.equal(other.pinned, undefined);
    assert.ok(other.decay < 1, 'the ordinary record decayed over the simulated year');

    const status = await fixture.memory.status();
    assert.equal(status.panel.global.pinned, 1);
  } finally {
    fixture.cleanup();
  }
});

test('pinned records survive a small active-set cap and stay recallable', async () => {
  const fixture = await makeMemory({
    policy: { activeSet: { cap: 100, minEvents: 1, minMass: 0.01 }, candidates: { minScore: 0 } },
  });
  try {
    await fixture.memory.remember({
      content: '踩坑教训：native 模块重编译后必须重启宿主',
      tags: ['lesson:native'],
      salience: 0.5,
      pinned: true,
      eventTime: T0,
    });
    // A flood of unrelated tags would normally compete for the cap; the pinned tag
    // is admitted regardless (cap stays 100 here, but the pinned entry is not in
    // belowThreshold and is never archived).
    for (let index = 0; index < 5; index += 1) {
      await fixture.memory.remember({
        content: `filler note ${index}`,
        tags: [`noise:${index}`],
        eventTime: T0 + index * 1000,
      });
    }
    fixture.clock.advance(400 * DAY_MS);
    await fixture.memory.maintain({ reason: 'pinned-cap-test' });

    const view = fixture.memory.indexManager.snapshot();
    assert.ok(view.activeSet.entries.some((entry) => entry.tag === 'lesson:native'));
    assert.equal(view.activeSet.belowThreshold.some((entry) => entry.tag === 'lesson:native'), false);
    const recalled = await fixture.memory.recall({ tags: ['lesson:native'], topK: 3 });
    assert.equal(recalled.hits[0]?.pinned, true);
  } finally {
    fixture.cleanup();
  }
});
