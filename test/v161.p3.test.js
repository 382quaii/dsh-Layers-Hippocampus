/**
 * v1.6.1 — P3 token-leak tightenings.
 *
 *  P3-1: an `[Active Task]` event must not ALSO be injected as a `[Memory Blocks]`
 *        entry (block ids are event ids, so the bare id joins the dedup pool).
 *  P3-2: `[Persona & Traits]` is memoized by the L3 shape (summaryId + updatedAt +
 *        count) instead of being re-rendered on every assembly.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { fakeCtx, tempDir, T0 } from './helpers.js';

async function boot() {
  const dir = tempDir('p3-token');
  const fixture = fakeCtx();
  await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
  const runtime = getRuntime(fixture.ctx);
  await runtime.ready;
  return { ...fixture, dir, runtime };
}

function upsertTrait(runtime, index, confidence = 0.5) {
  runtime.memory.semanticStore.upsert({
    clock: runtime.memory.clock,
    title: `trait-${index}`,
    text: `trait text ${index}`,
    confidence,
    tags: ['persona:traits'],
  });
}

test('P3-2: persona text is memoized until the L3 shape changes', async () => {
  const booted = await boot();
  try {
    upsertTrait(booted.runtime, 1, 0.9);
    const first = booted.runtime.personaTraitsText();
    assert.match(first, /trait-1/);
    const cached = booted.runtime._personaCache;
    assert.ok(cached, 'cache is populated');

    const second = booted.runtime.personaTraitsText();
    assert.equal(second, first);
    assert.equal(booted.runtime._personaCache, cached, 'cache object reused, no re-render');

    upsertTrait(booted.runtime, 2, 0.95);
    const third = booted.runtime.personaTraitsText();
    assert.notEqual(third, first, 'new L3 entry invalidates the memo');
    assert.match(third, /trait-2/);
    assert.notEqual(booted.runtime._personaCache, cached, 'cache replaced');
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('P3-1: the Active Task event id joins the block dedup pool', async () => {
  const booted = await boot();
  try {
    const written = await booted.runtime.memory.remember({
      content: 'active task body for P3',
      tags: ['task:p3'],
      eventTime: T0,
    });
    await booted.runtime.memory.maintain({ reason: 'p3-test' });
    const task = booted.runtime.memory.promptActiveTask();
    assert.equal(task?.eventId, written.eventId, 'promptActiveTask points at the task event');

    const text = booted.runtime.promptState();
    // The event body appears through [Active Task]; it must not be rendered again as
    // a `- [memory <id>]` block line.
    assert.match(text, /\[Active Task\]/);
    assert.doesNotMatch(text, new RegExp(`\\[memory ${written.eventId}\\]`));
    assert.ok(
      booted.runtime.injection.ids.has(written.eventId),
      'bare event id is registered in the dedup pool',
    );
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});
