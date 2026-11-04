/**
 * v1.5.6 — L2 multi-merge ("多合一蒸馏").
 *
 * Locked contracts:
 *   1. pinned records merge ONLY with pinned; ordinary ONLY with ordinary;
 *   2. merged text = earliest/latest + deduped core text, capped by
 *      `l2Merge.maxSummaryChars`;
 *   3. the pinned merge keeps `pinned:true` and inherits tags;
 *   4. `meta.global_tags` is copied as META and never becomes a tag (no sub-space
 *      inverted index pollution);
 *   5. originals are marked in engine state; a second maintain merges nothing
 *      (idempotent) and originals stay in the append-only log;
 *   6. `l2Merge.enabled=false` disables the pass; config is fail-fast.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { T0, logRecords, makeMemory } from './helpers.js';

const POLICY = { activeSet: { minEvents: 1, minMass: 0.01 } };

async function seed(memory) {
  const pinnedA = await memory.remember({
    content: '固定教训 A：发布门禁超时必须退避重试',
    tags: ['lesson:deploy'],
    salience: 0.9,
    pinned: true,
    meta: { global_tags: ['domain:fe'] },
    eventTime: T0,
  });
  const pinnedB = await memory.remember({
    content: '固定教训 B：发布门禁超时必须退避重试（再次踩坑）',
    tags: ['lesson:deploy'],
    salience: 0.8,
    pinned: true,
    meta: { global_tags: ['domain:fe'] },
    eventTime: T0 + 1_000,
  });
  const ordinaryA = await memory.remember({
    content: '普通记录 A：今天聊了发布节奏',
    tags: ['lesson:deploy'],
    eventTime: T0 + 2_000,
  });
  const ordinaryB = await memory.remember({
    content: '普通记录 B：今天聊了发布节奏（重复）',
    tags: ['lesson:deploy'],
    eventTime: T0 + 3_000,
  });
  return { pinnedA, pinnedB, ordinaryA, ordinaryB };
}

test('pinned and ordinary groups merge separately, with global-tag metadata preserved as meta', async () => {
  const fixture = await makeMemory({ policy: POLICY, config: { l2Merge: { enabled: true, minGroupSize: 2 } } });
  try {
    const ids = await seed(fixture.memory);
    const view = fixture.memory.indexManager.snapshot();
    const events = Array.isArray(view.events) ? view.events : [...view.events.values()];
    const pinnedEvent = events.find((event) => event.eventId === ids.pinnedA.eventId);
    assert.deepEqual(pinnedEvent.globalTags, ['domain:fe'], 'the index exposes federated metadata');

    const report = await fixture.memory.maintain({ reason: 'l2-merge' });
    assert.equal(report.l2Merge.merged, 2, 'one pinned group + one ordinary group');
    assert.equal(report.l2Merge.status, 'ok');

    const records = logRecords(fixture.dir);
    const merged = records.filter((record) => record.meta?.l2_merged === true);
    assert.equal(merged.length, 2);
    const pinnedMerged = merged.find((record) => record.meta.merged_pinned === true);
    const ordinaryMerged = merged.find((record) => record.meta.merged_pinned === false);
    assert.ok(pinnedMerged && ordinaryMerged);

    // Pinned merge keeps pinned + inherits tags + carries federated metadata as META.
    assert.equal(pinnedMerged.meta.pinned, true);
    const pinnedTags = pinnedMerged.tags.map((tag) => tag.tag ?? tag);
    assert.ok(pinnedTags.includes('lesson:deploy'));
    assert.ok(pinnedTags.includes('status:l2-merged'));
    assert.ok(!pinnedTags.includes('domain:fe'), 'global tags never become a sub-space tag');
    assert.deepEqual(pinnedMerged.meta.global_tags, ['domain:fe']);
    assert.deepEqual([...pinnedMerged.meta.source_event_ids].sort(), [ids.pinnedA.eventId, ids.pinnedB.eventId].sort());
    assert.equal(pinnedMerged.meta.merged_count, 2);

    // Ordinary merge has no pinned flag and no federated metadata.
    assert.notEqual(ordinaryMerged.meta.pinned, true);
    assert.equal(ordinaryMerged.meta.global_tags, undefined);
    assert.deepEqual([...ordinaryMerged.meta.source_event_ids].sort(), [ids.ordinaryA.eventId, ids.ordinaryB.eventId].sort());

    // Originals stay in the append-only log (recoverable), the state marks them merged.
    assert.ok(records.some((record) => record.event_id === ids.pinnedA.eventId));
    const status = await fixture.memory.status();
    assert.equal(status.panel.l2Merge.mergedSources, 4);
    assert.equal(status.panel.l2Merge.stats.mergedGroups, 2);

    // Idempotent: a second maintenance merges nothing.
    const second = await fixture.memory.maintain({ reason: 'l2-merge-again' });
    assert.equal(second.l2Merge.merged, 0);
  } finally {
    fixture.cleanup();
  }
});

test('a lone ordinary record is not dragged into the pinned group', async () => {
  const fixture = await makeMemory({ policy: POLICY, config: { l2Merge: { enabled: true, minGroupSize: 2 } } });
  try {
    await fixture.memory.remember({ content: '固定教训 A', tags: ['lesson:x'], pinned: true, meta: {}, eventTime: T0 });
    await fixture.memory.remember({ content: '固定教训 B', tags: ['lesson:x'], pinned: true, meta: {}, eventTime: T0 + 1 });
    const lonely = await fixture.memory.remember({ content: '唯一一条普通记录', tags: ['lesson:x'], eventTime: T0 + 2 });

    const report = await fixture.memory.maintain({ reason: 'l2-pinned-only' });
    assert.equal(report.l2Merge.merged, 1, 'only the pinned pair merges');
    const merged = logRecords(fixture.dir).filter((record) => record.meta?.l2_merged === true);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].meta.merged_pinned, true);
    assert.ok(!merged[0].meta.source_event_ids.includes(lonely.eventId), 'ordinary record untouched');
  } finally {
    fixture.cleanup();
  }
});

test('maxSummaryChars caps the merged text and enabled=false disables the pass', async () => {
  const capped = await makeMemory({ policy: POLICY, config: { l2Merge: { enabled: true, minGroupSize: 2, maxSummaryChars: 100 } } });
  try {
    await capped.memory.remember({ content: '很长的经验内容'.repeat(60), tags: ['lesson:long'], eventTime: T0 });
    await capped.memory.remember({ content: '另一段很长的经验内容'.repeat(60), tags: ['lesson:long'], eventTime: T0 + 1 });
    const report = await capped.memory.maintain({ reason: 'l2-cap' });
    assert.equal(report.l2Merge.merged, 1);
    const merged = logRecords(capped.dir).find((record) => record.meta?.l2_merged === true);
    assert.ok(merged.content.length <= 100, `merged text ${merged.content.length} must obey the cap`);
    assert.ok(merged.content.endsWith('...'));
  } finally {
    capped.cleanup();
  }

  const disabled = await makeMemory({ policy: POLICY, config: { l2Merge: { enabled: false } } });
  try {
    await disabled.memory.remember({ content: 'one', tags: ['lesson:off'], eventTime: T0 });
    await disabled.memory.remember({ content: 'two', tags: ['lesson:off'], eventTime: T0 + 1 });
    const report = await disabled.memory.maintain({ reason: 'l2-off' });
    assert.equal(report.l2Merge.status, 'disabled');
    assert.equal(report.l2Merge.merged, 0);
    assert.equal(logRecords(disabled.dir).filter((record) => record.meta?.l2_merged === true).length, 0);
  } finally {
    disabled.cleanup();
  }
});

test('l2Merge config is fail-fast validated', () => {
  const defaults = resolveConfig({});
  assert.deepEqual(defaults.l2Merge, { enabled: true, minGroupSize: 2, maxGroupsPerRun: 5, maxSummaryChars: 400 });
  assert.equal(resolveConfig({ l2Merge: { enabled: false, maxSummaryChars: 200 } }).l2Merge.maxSummaryChars, 200);
  for (const bad of [{ minGroupSize: 1 }, { maxGroupsPerRun: 0 }, { maxSummaryChars: 50 }]) {
    assert.throws(
      () => resolveConfig({ l2Merge: bad }),
      (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
      `${JSON.stringify(bad)} must be out of range`,
    );
  }
  assert.throws(
    () => resolveConfig({ l2Merge: { enabled: 'yes' } }),
    (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE',
  );
});
