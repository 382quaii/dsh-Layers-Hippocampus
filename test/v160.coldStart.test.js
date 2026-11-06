/**
 * v1.6.0 — cold-start injection switches (user request 2026-11-06).
 *
 * Two independent flags control what a BRAND-NEW conversation inherits:
 *   - `context.coldStartInjectSummary`     → `[Cold-Start Summary]`  (default ON)
 *   - `context.coldStartInjectRecentTurns` → `[Previous Context Tail]` (default OFF)
 * Both OFF → no historical blocks at all; the static anti-customer-service policy
 * ("状态唤醒") still ships in `memory:policy`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { resolveConfig } from '../src/config.js';
import { EDITABLE_CONFIG_KEYS } from '../src/webRoutes.js';
import { fakeCtx, tempDir, T0 } from './helpers.js';

async function boot({ context = {}, prepare = null } = {}) {
  const dir = tempDir('cold-start');
  const fixture = fakeCtx();
  await apply(fixture.ctx, {
    dataDir: dir,
    maintenanceCron: '0 */6 * * *',
    autoMaintainOnBoot: false,
    context,
  });
  const runtime = getRuntime(fixture.ctx);
  await runtime.ready;
  if (prepare) await prepare(runtime);
  runtime.coldStartPending = true;
  const text = runtime.promptState();
  return { ...fixture, dir, runtime, text };
}

test('cold-start switches are fail-fast booleans and HTTP-editable', () => {
  const defaults = resolveConfig({});
  assert.equal(defaults.context.coldStartInjectSummary, true);
  assert.equal(defaults.context.coldStartInjectRecentTurns, false);
  assert.throws(
    () => resolveConfig({ context: { coldStartInjectSummary: 'yes' } }),
    (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE',
  );
  assert.throws(
    () => resolveConfig({ context: { coldStartInjectRecentTurns: 1 } }),
    (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE',
  );
  assert.ok(EDITABLE_CONFIG_KEYS.includes('context.coldStartInjectSummary'));
  assert.ok(EDITABLE_CONFIG_KEYS.includes('context.coldStartInjectRecentTurns'));
});

test('summary ON: first assembly injects detection + summary exactly once', async () => {
  const booted = await boot({
    prepare: async (runtime) => {
      await runtime.memory.remember({
        content: 'cold start alpha fact',
        tags: ['topic:alpha'],
        eventTime: T0,
      });
      await runtime.memory.maintain({ reason: 'cold-start-test' });
      runtime.memory.semanticStore.upsert({
        clock: runtime.memory.clock,
        title: 'Preference',
        text: 'User prefers architecture talk over small talk.',
        confidence: 0.9,
        tags: ['persona:traits'],
      });
    },
  });
  try {
    assert.match(booted.text, /\[Cold-Start Detected: Active Space=default, Recent Topic=topic:alpha\]/);
    assert.match(booted.text, /\[Cold-Start Summary\]/);
    assert.match(booted.text, /User prefers architecture talk/);
    assert.equal(booted.runtime.coldStartPending, false, 'pending flag is consumed');
    const second = booted.runtime.promptState();
    assert.doesNotMatch(second, /\[Cold-Start Detected/, 'never injected twice');
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('both OFF: no historical block, but the static wake-up policy still exists', async () => {
  const booted = await boot({
    context: { coldStartInjectSummary: false, coldStartInjectRecentTurns: false },
    prepare: async (runtime) => {
      await runtime.memory.remember({ content: 'cold start alpha fact', tags: ['topic:alpha'], eventTime: T0 });
      await runtime.memory.maintain({ reason: 'cold-start-test' });
    },
  });
  try {
    assert.doesNotMatch(booted.text, /\[Cold-Start/);
    assert.doesNotMatch(booted.text, /\[Previous Context Tail\]/);
    const policy = booted.sections.find((section) => section.name === 'memory:policy');
    assert.ok(policy, 'memory:policy section is registered');
    assert.match(policy.text(), /状态唤醒/);
    assert.match(policy.text(), /不是.*客服/);
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('recent-turns ON: last episodes appear in [Previous Context Tail]', async () => {
  const booted = await boot({
    context: { coldStartInjectSummary: false, coldStartInjectRecentTurns: true },
    prepare: async (runtime) => {
      for (let index = 0; index < 6; index += 1) {
        await runtime.memory.remember({
          content: `recent turn number ${index}`,
          tags: ['topic:recent'],
          eventTime: T0 + index * 60_000,
        });
      }
      await runtime.memory.maintain({ reason: 'cold-start-test' });
    },
  });
  try {
    assert.match(booted.text, /\[Previous Context Tail\]/);
    assert.match(booted.text, /recent turn number 5/, 'newest first');
    assert.doesNotMatch(booted.text, /\[Cold-Start Summary\]/, 'summary switch is OFF');
    const tailLines = booted.text.split('\n').filter((line) => line.startsWith('- recent turn number'));
    assert.ok(tailLines.length <= 5, 'at most five episodes');
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('summary OFF + recent ON still emits the detection line but no summary', async () => {
  const booted = await boot({
    context: { coldStartInjectSummary: false, coldStartInjectRecentTurns: true },
    prepare: async (runtime) => {
      await runtime.memory.remember({ content: 'one recent fact', tags: ['topic:recent'], eventTime: T0 });
      await runtime.memory.maintain({ reason: 'cold-start-test' });
    },
  });
  try {
    assert.match(booted.text, /\[Cold-Start Detected:/);
    assert.doesNotMatch(booted.text, /\[Cold-Start Summary\]/);
    assert.match(booted.text, /\[Previous Context Tail\]\n- one recent fact/);
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});
