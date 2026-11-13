/**
 * v1.6.0 cold-start injection — rewritten for the v1.6.3 bug fix.
 *
 * Reported bug (2026-11-13): "a newly opened conversation does not load the summary
 * or the first few turns". Root cause: the injection was a single process-wide
 * boolean consumed by the FIRST prompt assembly of the WHOLE process, so any agent
 * that assembled first (a delegated sub-agent, a title generator) swallowed it.
 *
 * The contract now:
 *   - an injection is armed per conversation (session id or agent id) and keyed by
 *     the handoff epoch, so each conversation gets at most ONE injection;
 *   - a different agent assembling first cannot consume it;
 *   - `[Cold-Start Summary]` ← handoff summary (fallback: top L3 semantic summaries);
 *   - `[Previous Context Tail]` ← the handoff marker's `tailTurns` (last ≤5 turns),
 *     falling back to the newest episodes;
 *   - both switches default ON (`coldStartInjectRecentTurns` changed to true in
 *     1.6.3: a summary alone left the new conversation unable to continue the thread).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { resolveConfig } from '../src/config.js';
import { EDITABLE_CONFIG_KEYS } from '../src/webRoutes.js';
import { fakeCtx, tempDir, T0 } from './helpers.js';

/** Write a handoff marker straight into state/handoff.json (the engine's own format). */
function writeMarker(dir, { at = T0, sessionId = null, summaryEventId = null, tailTurns = [] } = {}) {
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'handoff.json'),
    JSON.stringify({
      schema: 1,
      active: true,
      state: 'active',
      degraded: false,
      at,
      sessionId,
      tokens: 1,
      nativeTokenLimit: 8000,
      ratio: 0.9,
      threshold: 0.85,
      summaryEventId,
      tailTurns,
      note: 'test marker',
    }),
    'utf8',
  );
}

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
  if (prepare) await prepare(runtime, dir);
  return { ...fixture, dir, runtime };
}

test('both switches default ON, fail-fast booleans, HTTP-editable', () => {
  const defaults = resolveConfig({});
  assert.equal(defaults.context.coldStartInjectSummary, true);
  assert.equal(defaults.context.coldStartInjectRecentTurns, true, 'v1.6.3: turns default ON');
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

test('nothing is armed without a handoff summary (a fresh install stays silent)', async () => {
  const booted = await boot();
  try {
    assert.equal(booted.runtime.noteColdStart({ sessionId: 'sess-fresh' }), null);
    const text = booted.runtime.promptState();
    assert.doesNotMatch(text, /\[Cold-Start/);
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('summary ON: the new conversation gets detection + summary exactly once', async () => {
  const booted = await boot({
    prepare: async (runtime, dir) => {
      const event = await runtime.memory.remember({
        content: '交接摘要（测试）：用户正在做海马体插件的 v1.6.3 修复。',
        tags: ['folded_summary', 'status:handoff'],
        eventTime: T0,
      });
      await runtime.memory.maintain({ reason: 'cold-start-test' });
      writeMarker(dir, { summaryEventId: event?.eventId ?? null, tailTurns: [{ role: 'user', text: '继续修 bug' }] });
      runtime.memory.observeSessionTurn('sess-A', '继续修 bug');
      runtime.noteColdStart({ sessionId: 'sess-A' });
    },
  });
  try {
    const text = booted.runtime.promptState();
    assert.match(text, /\[Cold-Start Detected: Active Space=default/);
    assert.match(text, /\[Cold-Start Summary\]/);
    assert.match(text, /v1\.6\.3 修复/);
    assert.match(text, /\[Previous Context Tail\]\n- user: 继续修 bug/, 'tail turns are replayed verbatim');
    assert.equal(booted.runtime.coldStart.pending.size, 0, 'pending is consumed');
    const second = booted.runtime.promptState();
    assert.doesNotMatch(second, /\[Cold-Start Detected/, 'never injected twice in one conversation');
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('a sibling agent assembling first cannot swallow the injection', async () => {
  const booted = await boot({
    prepare: async (runtime, dir) => {
      const event = await runtime.memory.remember({ content: 'handoff body', tags: ['topic:alpha'], eventTime: T0 });
      await runtime.memory.maintain({ reason: 'cold-start-test' });
      writeMarker(dir, { summaryEventId: event?.eventId ?? null });
    },
  });
  try {
    // A delegated sub-agent arms itself and assembles first. It gets its OWN block
    // (best-effort context for the helper); crucially it no longer CONSUMES the
    // process-wide one-shot flag the way the v1.6.0 boolean did.
    booted.runtime.noteColdStart({ agentId: 'sub-1' });
    assert.match(booted.runtime.promptState({ agent: { id: 'sub-1' } }), /\[Cold-Start Summary\]/);
    assert.doesNotMatch(booted.runtime.promptState({ agent: { id: 'sub-1' } }), /\[Cold-Start/);
    // ...and the user's own conversation STILL gets its own injection (the bug).
    booted.runtime.noteColdStart({ agentId: 'main-1' });
    assert.match(booted.runtime.promptState({ agent: { id: 'main-1' } }), /\[Cold-Start Summary\]/);
    assert.doesNotMatch(booted.runtime.promptState({ agent: { id: 'main-1' } }), /\[Cold-Start/);
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('two different conversations each inject once (per-conversation, not per-process)', async () => {
  const booted = await boot({
    prepare: async (runtime, dir) => {
      const event = await runtime.memory.remember({ content: 'handoff body', tags: ['topic:alpha'], eventTime: T0 });
      await runtime.memory.maintain({ reason: 'cold-start-test' });
      writeMarker(dir, { summaryEventId: event?.eventId ?? null });
    },
  });
  try {
    booted.runtime.memory.observeSessionTurn('sess-A', 'first');
    booted.runtime.noteColdStart({ sessionId: 'sess-A' });
    assert.match(booted.runtime.promptState(), /\[Cold-Start Summary\]/);
    assert.doesNotMatch(booted.runtime.promptState(), /\[Cold-Start/);

    booted.runtime.memory.observeSessionTurn('sess-B', 'second');
    booted.runtime.noteColdStart({ sessionId: 'sess-B' });
    assert.match(booted.runtime.promptState(), /\[Cold-Start Summary\]/);
    assert.doesNotMatch(booted.runtime.promptState(), /\[Cold-Start/);
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('two conversations armed before either assembles each get their own block', async () => {
  const booted = await boot({
    prepare: async (runtime, dir) => {
      const event = await runtime.memory.remember({ content: 'handoff body', tags: ['topic:alpha'], eventTime: T0 });
      await runtime.memory.maintain({ reason: 'cold-start-test' });
      writeMarker(dir, { summaryEventId: event?.eventId ?? null });
    },
  });
  try {
    // The user's conversation and a helper agent are both created before either
    // assembles — the single-slot version overwrote the first entry here.
    booted.runtime.noteColdStart({ sessionId: 'sess-main' });
    booted.runtime.noteColdStart({ agentId: 'helper-1' });
    assert.match(booted.runtime.promptState({ agent: { id: 'helper-1' } }), /\[Cold-Start Summary\]/);
    // The user's entry survived the helper's arm+consume.
    booted.runtime.memory.observeSessionTurn('sess-main', 'still here');
    assert.match(booted.runtime.promptState(), /\[Cold-Start Summary\]/);
    assert.equal(booted.runtime.coldStart.pending.size, 0);
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('the stats payload exposes the armed/injected cold-start state', async () => {
  const booted = await boot({
    prepare: async (runtime, dir) => {
      const event = await runtime.memory.remember({ content: 'handoff body', tags: ['topic:alpha'], eventTime: T0 });
      await runtime.memory.maintain({ reason: 'cold-start-test' });
      writeMarker(dir, { summaryEventId: event?.eventId ?? null });
    },
  });
  try {
    booted.runtime.noteColdStart({ sessionId: 'sess-view' });
    const before = await booted.runtime.uiPayload();
    assert.ok(Array.isArray(before.coldStart.pending), 'coldStart.pending is a list');
    assert.equal(before.coldStart.pending.length, 1);
    assert.equal(before.coldStart.pending[0].sessionId, 'sess-view');
    assert.equal(before.coldStart.pending[0].source, 'session');
    assert.equal(before.coldStart.injected, 0);
    booted.runtime.memory.observeSessionTurn('sess-view', 'go');
    booted.runtime.promptState();
    const after = await booted.runtime.uiPayload();
    assert.equal(after.coldStart.pending.length, 0, 'consumed entries leave the pending list');
    assert.equal(after.coldStart.injected, 1);
    assert.equal(after.coldStart.lastSessionId, null, 'lastSessionId tracks captured turns, not assemblies');
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('both OFF: no historical block, but the static wake-up policy still exists', async () => {
  const booted = await boot({
    context: { coldStartInjectSummary: false, coldStartInjectRecentTurns: false },
    prepare: async (runtime, dir) => {
      const event = await runtime.memory.remember({ content: 'cold start alpha fact', tags: ['topic:alpha'], eventTime: T0 });
      await runtime.memory.maintain({ reason: 'cold-start-test' });
      writeMarker(dir, { summaryEventId: event?.eventId ?? null, tailTurns: [{ role: 'user', text: 'hello' }] });
      runtime.noteColdStart({ agentId: 'main-off' });
    },
  });
  try {
    const text = booted.runtime.promptState({ agent: { id: 'main-off' } });
    assert.doesNotMatch(text, /\[Cold-Start/);
    assert.doesNotMatch(text, /\[Previous Context Tail\]/);
    assert.equal(booted.runtime.coldStart.pending.size, 0, 'a disabled injection is still consumed');
    const policy = booted.sections.find((section) => section.name === 'memory:policy');
    assert.ok(policy, 'memory:policy section is registered');
    assert.match(policy.text(), /状态唤醒/);
    assert.match(policy.text(), /不是.*客服/);
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('summary OFF + turns ON: detection line and the tail, no summary', async () => {
  const booted = await boot({
    context: { coldStartInjectSummary: false, coldStartInjectRecentTurns: true },
    prepare: async (runtime, dir) => {
      const event = await runtime.memory.remember({ content: 'one recent fact', tags: ['topic:recent'], eventTime: T0 });
      await runtime.memory.maintain({ reason: 'cold-start-test' });
      writeMarker(dir, {
        summaryEventId: event?.eventId ?? null,
        tailTurns: [
          { role: 'user', text: '第一句' },
          { role: 'assistant', text: '第二句' },
        ],
      });
      runtime.noteColdStart({ agentId: 'main-turns' });
    },
  });
  try {
    const text = booted.runtime.promptState({ agent: { id: 'main-turns' } });
    assert.match(text, /\[Cold-Start Detected:/);
    assert.doesNotMatch(text, /\[Cold-Start Summary\]/);
    assert.match(text, /\[Previous Context Tail\]\n- user: 第一句\n- assistant: 第二句/);
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});
