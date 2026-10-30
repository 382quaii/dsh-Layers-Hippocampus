/**
 * Checkpoints (one active task, direct index lookup, engine-side demotion) and
 * multimodal guards (media_url shape, base64 threshold).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { BASE64_RUN_LIMIT, Memory } from '../src/memory.js';
import { resolveConfig } from '../src/config.js';
import { DAY_MS, FakeClock, makeMemory, tempDir, T0 } from './helpers.js';

test('checkpoint stores one active task and a new one demotes the previous', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const first = await memory.checkpoint({ taskId: 'task-a', progress: 10 });
    assert.equal(first.status, 'active');
    assert.equal(first.demotedEventId, null);
    assert.equal(memory.activeTask().status, 'active');
    assert.equal(memory.activeTask().taskId, 'task-a');

    const second = await memory.checkpoint({ taskId: 'task-b', progress: 55 });
    assert.equal(second.demotedEventId, first.eventId, 'writing a new checkpoint demotes the old one');
    const current = memory.activeTask();
    assert.equal(current.taskId, 'task-b');
    assert.equal(current.progress, 55);
  } finally {
    cleanup();
  }
});

test('active task is read straight from the index and survives an evicted active set', async () => {
  const dir = tempDir('checkpoint-cap');
  const clock = new FakeClock(T0);
  // Tiny active-set cap: tags get evicted from the resident set, but the index
  // keeps every event — that is what the direct lookup relies on.
  const memory = await Memory.open({ dataDir: dir, clock, policy: { activeSet: { cap: 1, minEvents: 1, minMass: 0.01 } } });
  try {
    await memory.checkpoint({ taskId: 'long-refactor', progress: 40 });
    for (let i = 0; i < 30; i += 1) {
      await memory.remember({ content: `filler ${i}`, tags: [`filler:${i}`], eventTime: T0 + i });
    }
    const view = memory.indexManager.snapshot();
    assert.ok(view.activeSet.entries.length <= 1, 'the active set really is capped');
    const active = memory.activeTask();
    assert.equal(active.status, 'active', 'direct lookup ignores the active-set cap');
    assert.equal(active.taskId, 'long-refactor');
    assert.match(active.content, /long-refactor/);
  } finally {
    memory.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('maintain demotes a checkpoint that was not refreshed for 7 days', async () => {
  const { memory, clock, cleanup } = await makeMemory();
  try {
    const saved = await memory.checkpoint({ taskId: 'stale-task', progress: 90 });
    assert.equal(memory.activeTask().status, 'active');

    clock.advance(7 * DAY_MS + 1);
    assert.equal(memory.activeTask().status, 'stale', 'read reports staleness before maintenance runs');

    const report = await memory.maintain({ reason: 'test' });
    assert.equal(report.activeTask.demoted, true);
    assert.equal(report.activeTask.reason, 'stale');
    assert.equal(memory.activeTask().status, 'none');
    const pointer = JSON.parse(fs.readFileSync(memory.activeTaskPath(), 'utf8'));
    assert.equal(pointer.active, false);
    assert.equal(pointer.demotedEventId, saved.eventId);
  } finally {
    cleanup();
  }
});

test('a fresh checkpoint is NOT demoted by maintenance', async () => {
  const { memory, clock, cleanup } = await makeMemory();
  try {
    await memory.checkpoint({ taskId: 'fresh', progress: 5 });
    clock.advance(DAY_MS);
    const report = await memory.maintain({ reason: 'test' });
    assert.equal(report.activeTask.demoted, false);
    assert.equal(memory.activeTask().status, 'active');
  } finally {
    cleanup();
  }
});

test('base64: 300 characters are rejected, 200 are ordinary text', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const payload = 'A'.repeat(300);
    assert.ok(payload.length >= BASE64_RUN_LIMIT);
    await assert.rejects(
      () => memory.remember({ content: `screenshot: ${payload}`, tags: ['media'] }),
      (error) => error.code === 'MEM_E_INVALID_MEDIA',
    );

    const short = 'A'.repeat(200);
    const stored = await memory.remember({ content: `checksum ${short}`, tags: ['media'] });
    assert.equal(stored.status, 'appended');
  } finally {
    cleanup();
  }
});

test('media_url accepts only http(s) or absolute paths, and media_type is required', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    await assert.rejects(
      () => memory.remember({ content: 'relative', mediaUrl: 'assets/a.png', mediaType: 'image' }),
      (error) => error.code === 'MEM_E_INVALID_MEDIA',
    );
    await assert.rejects(
      () => memory.remember({ content: 'no type', mediaUrl: 'https://example.com/a.png' }),
      (error) => error.code === 'MEM_E_INVALID_MEDIA',
    );
    await assert.rejects(
      () => memory.remember({ content: 'bad type', mediaUrl: 'https://example.com/a.png', mediaType: 'hologram' }),
      (error) => error.code === 'MEM_E_INVALID_MEDIA',
    );
    const okHttp = await memory.remember({ content: 'http', mediaUrl: 'https://example.com/a.png', mediaType: 'image' });
    assert.equal(okHttp.status, 'appended');
    const okPath = await memory.remember({ content: 'path', mediaUrl: 'C:\\media\\clip.mp4', mediaType: 'video' });
    assert.equal(okPath.status, 'appended');
  } finally {
    cleanup();
  }
});

test('decay.halfLifeDays and activeSet.cap are config, validated fail-fast', () => {
  const config = resolveConfig({}, { env: { DSH_HOME: 'C:/dsh' } });
  assert.equal(config.decay.halfLifeDays, 30);
  assert.equal(config.activeSet.cap, 200);
  assert.equal(resolveConfig({ decay: { halfLifeDays: 7 } }).decay.halfLifeDays, 7);
  assert.equal(resolveConfig({ activeSet: { cap: 1000 } }).activeSet.cap, 1000);
  for (const bad of [6, 366]) {
    assert.throws(() => resolveConfig({ decay: { halfLifeDays: bad } }), (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE');
  }
  for (const bad of [99, 1001]) {
    assert.throws(() => resolveConfig({ activeSet: { cap: bad } }), (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE');
  }
});
