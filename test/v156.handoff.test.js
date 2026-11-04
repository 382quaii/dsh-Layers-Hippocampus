/**
 * v1.5.4 — handoff state machine hardening (deadlock / recursion / cleanup).
 *
 * Incident: after the recursive handoff summaries grew, hitting the rollover
 * threshold could wedge the state machine, and a user could no longer start a new
 * session. The contract locked here:
 *
 *   1. `checkHandoff()` NEVER rejects: a distillation error/timeout or a marker
 *      write failure degrades to a `failed` marker and lets the next session start.
 *   2. A new session ALWAYS resets its token baseline and releases the in-flight
 *      guard; a marker from a previous session is consumed, not inherited.
 *   3. `_distillHandoffTail()` filters handoff summaries by tag AND by the
 *      `交接摘要` text prefix, and hard-caps its output size.
 *   4. `status:handoff` summaries are 2%-weighted in recall and hidden from the
 *      normal memory list.
 *   5. Escape hatches exist: `resetSessionState()` / admin `reset_session` /
 *      `POST /session/reset`, plus `repairHandoffSummaries()` (dry-run first,
 *      pending-delete only).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { Readable } from 'node:stream';
import { apply, getRuntime } from '../index.js';
import { ErrorCodes, MemoryError } from '../src/errors.js';
import { HANDOFF_TAG } from '../src/memory.js';
import { MEMORY_API, createMemoryRoutes } from '../src/webRoutes.js';
import { FakeClock, T0, fakeCtx, makeMemory, tempDir } from './helpers.js';

const HANDOFF_CONFIG = {
  context: { nativeTokenLimit: 1000, autoRolloverThreshold: 0.85, maxTokens: 100_000 },
};

// ---- 1. recursion is cut off -----------------------------------------------

test('_distillHandoffTail refuses to summarise handoff content (tag and text prefix)', async () => {
  const { memory, cleanup } = await makeMemory({ config: HANDOFF_CONFIG });
  try {
    // A real fact in the live window plus a dirty recursive handoff block.
    memory.context.inject({ id: 'real', kind: 'recall', text: '任务：发布 v1.5.4 交接修复。要点：@Alice 验证状态机。', tokens: 20, salience: 0.9, at: T0 });
    memory.context.inject({ id: 'dirty', kind: 'recall', text: '交接摘要（旧）要点：交接摘要（更旧）要点：不要被套娃。', tokens: 20, salience: 0.9, at: T0 });
    memory.observeSessionTokens('session-recursion', 900);

    const result = await memory.checkHandoff({ now: T0 });
    assert.equal(result.handoff.active, true);
    assert.equal(result.handoff.degraded, false);
    const summary = (memory.indexManager.snapshot()?.events ?? []).find((event) => event.eventId === result.handoff.summaryEventId);
    assert.ok(summary, 'a summary was produced');
    assert.match(summary.content, /发布 v1\.5\.4 交接修复/, 'real tail content is kept');
    assert.match(summary.content, /Alice/);
    assert.equal(summary.content.includes('不要被套娃'), false, 'handoff block must not be re-summarised');
    assert.equal((summary.content.match(/交接摘要/g) ?? []).length, 1, 'only the summary own prefix remains');
    assert.ok(summary.content.length <= 1200, 'summary length is hard-capped');
  } finally {
    cleanup();
  }
});

test('index fallback also skips handoff events', async () => {
  const { memory, cleanup } = await makeMemory({ config: HANDOFF_CONFIG });
  try {
    // No live blocks: distillation must fall back to indexed events, and skip the
    // dirty handoff event even though it is newer/high salience.
    await memory.remember({ content: '交接摘要（脏）要点：交接摘要（更脏）', tags: [HANDOFF_TAG, 'folded_summary'], salience: 1 });
    await memory.remember({ content: '真实事实：Alice 负责验证交接逃生舱', tags: ['fact:handoff'], salience: 0.6 });
    memory.observeSessionTokens('session-fallback', 900);
    const result = await memory.checkHandoff({ now: T0 });
    const summary = (memory.indexManager.snapshot()?.events ?? []).find((event) => event.eventId === result.handoff.summaryEventId);
    assert.ok(summary);
    assert.match(summary.content, /Alice/);
    assert.equal(summary.content.includes('更脏'), false, 'dirty handoff event must never be summarised');
  } finally {
    cleanup();
  }
});

// ---- 2. no deadlock: failures degrade, never reject ------------------------

test('a throwing distillation NEVER rejects: it degrades and lets a new session start', async () => {
  const { memory, cleanup } = await makeMemory({ config: HANDOFF_CONFIG });
  try {
    memory.context.inject({ id: 'tail', kind: 'recall', text: '普通事实', tokens: 10, salience: 0.9, at: T0 });
    memory.observeSessionTokens('session-a', 900);
    memory._distillHandoffTail = async () => {
      throw new MemoryError(ErrorCodes.IO, 'simulated distillation failure');
    };

    const result = await memory.checkHandoff({ now: T0 }); // must resolve, not reject
    assert.equal(result.handoff.active, true, 'a degraded marker is still written');
    assert.equal(result.handoff.degraded, true);
    assert.equal(result.handoff.state, 'failed');
    assert.equal(result.handoff.summaryEventId, null);
    assert.equal(result.handoff.summaryError.code, ErrorCodes.IO);

    // New session: baseline resets, marker consumed, ratio no longer due.
    const usage = memory.observeSessionTokens('session-b', 40);
    assert.equal(usage.tokens, 40);
    assert.equal(memory.handoffState().active, false, 'the degraded marker is consumed by the new session');
    const after = await memory.checkHandoff({ now: T0 });
    assert.equal(after.rolloverDue, false);
    assert.equal(memory._handoffInFlight, false, 'the in-flight guard was released');
  } finally {
    cleanup();
  }
});

test('a hanging distillation times out into a degraded marker', async () => {
  const { memory, cleanup } = await makeMemory({ config: HANDOFF_CONFIG });
  try {
    memory.context.inject({ id: 'tail', kind: 'recall', text: '普通事实', tokens: 10, salience: 0.9, at: T0 });
    memory.observeSessionTokens('session-hang', 900);
    memory._distillHandoffTail = () => new Promise(() => {}); // never settles
    const started = Date.now();
    const result = await memory.checkHandoff({ now: T0, timeoutMs: 40 });
    assert.ok(Date.now() - started < 1500, 'the watchdog bounds the wait');
    assert.equal(result.handoff.active, true);
    assert.equal(result.handoff.degraded, true);
    assert.equal(result.handoff.summaryError.reason, 'timeout');
    assert.equal(result.failure.code, ErrorCodes.HANDOFF_FAILED);
  } finally {
    cleanup();
  }
});

test('a new session always resets the ratio and releases a stuck in-flight guard', async () => {
  const { memory, cleanup } = await makeMemory({ config: HANDOFF_CONFIG });
  try {
    memory.observeSessionTokens('old-session', 990);
    assert.equal(memory.context.nativeState({ sessionTokens: 990 }).rolloverDue, true);
    memory._handoffInFlight = true; // simulate a wedged handoff

    const usage = memory.observeSessionTokens('new-session', 25);
    assert.equal(usage.sessionId, 'new-session');
    assert.equal(usage.tokens, 25);
    assert.equal(memory._handoffInFlight, false);
    assert.equal(memory.context.nativeState({ sessionTokens: 25 }).ratio, 0.025);

    // Same-key restart (estimate collapsed) must also reset the baseline.
    memory.observeSessionTokens('new-session', 800);
    const restarted = memory.observeSessionTokens('new-session', 30);
    assert.equal(restarted.tokens, 30);
  } finally {
    cleanup();
  }
});

// ---- 3. isolation from normal recall/list ---------------------------------

test('status:handoff summaries are 2%-weighted in recall and hidden from the memory list', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    // Same searchable text, normal salience vs handoff at max salience.
    const normal = await memory.remember({ content: 'shared query token handoff ranking proof normal fact', tags: ['rank:normal'], salience: 0.6 });
    await memory.remember({
      content: 'shared query token handoff ranking proof summary noise',
      tags: [HANDOFF_TAG, 'status:folded', 'folded_summary'],
      salience: 1,
    });
    const result = await memory.recall({ text: 'shared query token handoff ranking proof', topK: 10 });
    const normalIndex = result.hits.findIndex((hit) => hit.eventId === normal.eventId);
    const handoffIndex = result.hits.findIndex((hit) => (hit.snippet ?? '').includes('summary noise'));
    assert.ok(normalIndex >= 0, 'normal fact is returned');
    // 2% weight may also push the summary below the candidate floor: both outcomes
    // satisfy "正常召回优先命中真实事实". If present, it must rank after the fact.
    if (handoffIndex >= 0) assert.ok(normalIndex < handoffIndex, 'normal fact must outrank the handoff summary');
    else assert.equal(result.hits.some((hit) => hit.eventId === normal.eventId), true);

    const recent = await memory.recentMemories({ limit: 10 });
    assert.equal(recent.events.some((event) => event.snippet.includes('summary noise')), false, 'handoff hidden from the normal list');
    assert.ok(recent.events.some((event) => event.snippet.includes('normal fact')));
  } finally {
    cleanup();
  }
});

// ---- 4. escape hatches ------------------------------------------------------

test('resetSessionState clears baseline, in-flight guard and marker without touching memories', async () => {
  const { memory, cleanup } = await makeMemory({ config: HANDOFF_CONFIG });
  try {
    await memory.remember({ content: 'durable fact survives reset', tags: ['fact:survive'], salience: 0.9 });
    memory.context.inject({ id: 'tail', kind: 'recall', text: '普通事实', tokens: 10, salience: 0.9, at: T0 });
    memory.observeSessionTokens('wedged', 900);
    await memory.checkHandoff({ now: T0 });
    assert.equal(memory.handoffState().active, true);
    memory._handoffInFlight = true;

    const result = memory.resetSessionState({ reason: 'test' });
    assert.equal(result.reset, true);
    assert.equal(result.before.tokens, 900);
    assert.equal(memory.sessionUsage().tokens, 0);
    assert.equal(memory.handoffState().active, false);
    assert.equal(memory._handoffInFlight, false);
    assert.equal((await memory.checkHandoff({ now: T0 })).rolloverDue, false);
    const recalled = await memory.recall({ tags: ['fact:survive'] });
    assert.ok(recalled.hits.length >= 1, 'durable memories are untouched');
  } finally {
    cleanup();
  }
});

test('repairHandoffSummaries: dry run lists, apply parks recursive/excess in pending_delete', async () => {
  const { memory, cleanup } = await makeMemory({ config: HANDOFF_CONFIG });
  try {
    await memory.remember({ content: 'normal fact one', tags: ['fact'], salience: 0.5 });
    const recursive1 = await memory.remember({
      content: '交接摘要（a）要点：交接摘要（b）要点：旧摘要',
      tags: [HANDOFF_TAG, 'status:folded'],
      salience: 0.9,
      eventTime: T0 + 1,
    });
    const recursive2 = await memory.remember({
      content: '交接摘要（c）要点：交接摘要（d）要点：旧摘要2',
      tags: [HANDOFF_TAG, 'status:folded'],
      salience: 0.9,
      eventTime: T0 + 2,
    });
    const newest = await memory.remember({
      content: '交接摘要（最新）要点：干净的一代',
      tags: [HANDOFF_TAG, 'status:folded'],
      salience: 0.9,
      eventTime: T0 + 3,
    });

    const dry = await memory.repairHandoffSummaries({ dryRun: true, keep: 1 });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.totalHandoff, 3);
    assert.equal(dry.recursive, 2);
    assert.ok(dry.candidates.includes(recursive1.eventId));
    assert.ok(dry.candidates.includes(recursive2.eventId));
    assert.equal(dry.candidates.includes(newest.eventId), false, 'newest generation is kept');

    const applied = await memory.repairHandoffSummaries({ dryRun: false, keep: 1 });
    assert.equal(applied.dryRun, false);
    assert.ok(applied.candidates.length >= 2);
    const pending = memory.pendingDeletes.status(T0);
    assert.ok(pending.total >= 1, 'parked in the two-phase delete queue, not physically purged');
    // The facts are untouched.
    const facts = await memory.recall({ tags: ['fact'] });
    assert.ok(facts.hits.some((hit) => hit.snippet.includes('normal fact one')));
  } finally {
    cleanup();
  }
});

test('escape hatches over tool and HTTP: admin reset_session + POST /session/reset', async () => {
  const dir = tempDir('v156-escape');
  const host = fakeCtx();
  try {
    await apply(host.ctx, { dataDir: dir, autoMaintainOnBoot: false, ...HANDOFF_CONFIG });
    await getRuntime(host.ctx).ready;
    const admin = host.tools.get('memory_admin');
    const parsed = JSON.parse(await admin.execute({ action: 'reset_session' }));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.reset, true);
  } finally {
    host.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const routes = createMemoryRoutes({
    runtime: {
      phase: 'ready',
      state: 'ready',
      async resetSessionState({ reason }) {
        return { reset: true, reason };
      },
    },
  });
  const route = routes.find((candidate) => candidate.path === MEMORY_API.sessionReset);
  assert.ok(route, 'POST /session/reset is registered');
  const req = Readable.from([Buffer.from(JSON.stringify({ reason: 'test' }))]);
  req.method = 'POST';
  req.url = MEMORY_API.sessionReset;
  const res = {
    status: 0,
    text: '',
    writeHead(status) {
      this.status = status;
      return this;
    },
    end(text = '') {
      this.text = text;
      return this;
    },
  };
  await route.handler(req, res);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.text).ok, true);
  assert.equal(JSON.parse(res.text).reset, true);
  assert.equal(routes.length, 9, 'the route table grew by the escape hatch + install route');
});
