/**
 * v1.6.4 — the 1M-overflow incident (2026-11-14).
 *
 * Three independent defects let a request of 854,668 prompt tokens + a 256,000-token
 * completion reservation reach the provider against a 1,048,576-token window:
 *
 *  1. the denominator was the hand-written `context.nativeTokenLimit` (8000 in the
 *     damage profile), never the model's real window;
 *  2. the numerator was `Math.ceil(chars / 4)` over captured surface turns, ignoring
 *     the host's measured pressure (system prompt, tool schemas, history);
 *  3. `checkHandoff()` returned early whenever a marker was ACTIVE, and the session id
 *     no longer changes after handoff — so the state machine deadlocked after the FIRST
 *     handoff and never fired again.
 *
 * This suite locks the fixes: host-first window resolution, the `used + reserved`
 * decision, fail-fast on an impossible request, re-handoff in the same session, and the
 * Live Compact pointer for a single oversized tool result.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { ContextEngine } from '../src/context/contextEngine.js';
import { contentChars, liveCompactSession, planPointerization, pointerizeText, POINTER_MARKER } from '../src/context/liveCompact.js';
import { rehandoffDecision, requestPressure, resolveWindow } from '../src/context/windowGuard.js';
import { fakeCtx, makeMemory, T0, tempDir } from './helpers.js';

const WINDOW = 1_048_576;

/* ------------------------------------------------------------------ window */

test('the host window wins over the configured override; the override is only a fallback', () => {
  const fromHost = resolveWindow({ hostWindow: WINDOW, configuredWindow: 8000, fallback: 8000 });
  assert.deepEqual(fromHost, { window: WINDOW, source: 'host', hostWindow: WINDOW, configuredWindow: 8000 });
  const noHost = resolveWindow({ hostWindow: null, configuredWindow: 64000, fallback: 8000 });
  assert.equal(noHost.window, 64000);
  assert.equal(noHost.source, 'config');
  const nothing = resolveWindow({ hostWindow: null, configuredWindow: null, fallback: 8000 });
  assert.equal(nothing.window, 8000);
  assert.equal(nothing.source, 'default');
});

test('the engine resolves its window host-first and reports where it came from', () => {
  const headless = new ContextEngine({ clock: { now: () => T0 }, getPolicy: () => ({ context: { nativeTokenLimit: 8000 } }) });
  assert.equal(headless.nativeTokenLimit, 8000);
  assert.equal(headless.window.source, 'config');
  const hosted = new ContextEngine({
    clock: { now: () => T0 },
    getPolicy: () => ({ context: { nativeTokenLimit: 8000 } }),
    getHostWindow: () => WINDOW,
  });
  assert.equal(hosted.nativeTokenLimit, WINDOW);
  assert.equal(hosted.window.source, 'host');
  // A host probe that throws must not take the engine down with it.
  const broken = new ContextEngine({
    clock: { now: () => T0 },
    getPolicy: () => ({ context: { nativeTokenLimit: 8000 } }),
    getHostWindow: () => {
      throw new Error('no llm service');
    },
  });
  assert.equal(broken.nativeTokenLimit, 8000);
});

/* ---------------------------------------------------------------- pressure */

test('the decision uses used + reserved, not the prompt alone', () => {
  // The real incident: 854,668 in, 256,000 reserved, window 1,048,576.
  const incident = requestPressure({ usedTokens: 854_668, reservedTokens: 256_000, window: WINDOW, threshold: 0.85 });
  assert.equal(incident.projectedTokens, 1_110_668);
  assert.equal(incident.hardExceeded, true);
  assert.equal(incident.handoffDue, true);
  // The prompt alone would have looked survivable — this is the bug in one line.
  assert.ok(incident.ratio < 0.85, 'prompt-only ratio stays under the threshold');
  assert.ok(incident.projectedRatio > 1);

  const healthy = requestPressure({ usedTokens: 100_000, reservedTokens: 256_000, window: WINDOW, threshold: 0.85 });
  assert.equal(healthy.hardExceeded, false);
  assert.equal(healthy.handoffDue, false);
  assert.equal(healthy.handoffAtTokens, Math.round(WINDOW * 0.85));
});

test('nativeState prefers host-measured occupancy over the character estimate', () => {
  const engine = new ContextEngine({
    clock: { now: () => T0 },
    getPolicy: () => ({ context: { nativeTokenLimit: 8000 } }),
    getHostWindow: () => WINDOW,
    getHostUsedTokens: () => 900_000,
    getReservedTokens: () => 256_000,
    getSessionTokens: () => 12,
  });
  const state = engine.nativeState({});
  assert.equal(state.tokens, 900_000);
  assert.equal(state.reservedTokens, 256_000);
  assert.equal(state.projectedTokens, 1_156_000);
  assert.equal(state.hardExceeded, true);
  assert.equal(state.windowSource, 'host');
  assert.equal(state.rolloverDue, true);
  // Explicit per-call numbers beat the probes (the request guard knows them exactly).
  const explicit = engine.nativeState({ usedTokens: 1_000, reservedTokens: 0 });
  assert.equal(explicit.tokens, 1_000);
  assert.equal(explicit.hardExceeded, false);
});

/* -------------------------------------------------------------- re-handoff */

test('an active marker no longer deadlocks the state machine', () => {
  assert.equal(rehandoffDecision({ markerRatio: 0.9, projectedRatio: 0.9, sameSession: true }).rehandoff, false);
  const grew = rehandoffDecision({ markerRatio: 0.86, projectedRatio: 0.93, sameSession: true });
  assert.equal(grew.rehandoff, true);
  assert.equal(grew.reason, 'pressure-growth');
  const hard = rehandoffDecision({ markerRatio: 0.99, projectedRatio: 0.96, sameSession: true });
  assert.equal(hard.rehandoff, true);
  assert.equal(hard.reason, 'near-hard-limit');
  assert.equal(rehandoffDecision({ markerRatio: 0.5, projectedRatio: 0.9, sameSession: false }).rehandoff, false);
});

/* ------------------------------------------------------------ live compact */

test('a normal tool result is untouched; only the middle of a flood is removed', () => {
  const small = [{ type: 'text', text: 'x'.repeat(5_000) }];
  assert.equal(planPointerization(small, { thresholdChars: 200_000 }).changed, false);

  const flood = [{ type: 'text', text: `HEAD${'m'.repeat(400_000)}TAIL` }];
  const plan = planPointerization(flood, { thresholdChars: 200_000, headChars: 4_000, tailChars: 2_000, ref: { seq: 7, callId: 'call_1' } });
  assert.equal(plan.changed, true);
  const text = plan.content.map((block) => block.text).join('\n');
  assert.ok(text.startsWith('HEAD'), 'head is preserved verbatim');
  assert.ok(text.endsWith('TAIL'), 'tail is preserved verbatim');
  assert.ok(text.includes(POINTER_MARKER), 'the pointer marker is present');
  assert.ok(text.includes('seq=7') && text.includes('call=call_1'), 'the pointer carries durable coordinates');
  assert.ok(plan.charsAfter < plan.charsBefore / 2, `expected a large reduction, got ${plan.charsBefore} -> ${plan.charsAfter}`);
});

test('pointerizeText keeps code points intact and reports what it removed', () => {
  const source = `a${'😀'.repeat(20_000)}z`;
  const { text, removedChars } = pointerizeText(source, { headChars: 10, tailChars: 10 });
  assert.ok(removedChars > 19_000);
  assert.ok(text.startsWith('a'));
  assert.ok(text.endsWith('z'));
  // No lone surrogate may survive the slice.
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), false);
  assert.equal(pointerizeText('short', { headChars: 100, tailChars: 100 }).removedChars, 0);
});

test('liveCompactSession replaces the oversized surface node through the host surface protocol', () => {
  const appended = [];
  const original = {
    type: 'tool/result',
    seq: 3,
    data: { message: { role: 'tool', content: [{ type: 'text', text: 'y'.repeat(300_000) }] } },
  };
  const replacementMessage = { role: 'tool', content: [{ type: 'text', text: 'y'.repeat(300_000) }] };
  const session = {
    surface: { nodes: [1, 3] },
    eventAt(seq) {
      if (seq === 3) return original;
      return { type: 'user/message', seq: 1 };
    },
    deriveEventMessage() {
      return replacementMessage;
    },
    append(type, data, options) {
      appended.push({ type, data, options });
      return { seq: 10 + appended.length };
    },
  };
  const report = liveCompactSession(session, { thresholdChars: 200_000, headChars: 1_000, tailChars: 500 });
  assert.equal(report.pruned, 1);
  assert.equal(report.failed, null);
  assert.deepEqual(appended.map((entry) => entry.type), ['compaction/prune', 'tool/result']);
  const replace = appended[1].options.surfaceOp;
  assert.deepEqual(replace, { op: 'replace', startSeq: 3, endSeq: 3 });
  assert.deepEqual(appended[1].options.sourceEventSeqs, [3]);
  assert.ok(report.charsRemoved > 200_000);
  assert.ok(contentChars(appended[1].data.message.content) < 10_000);
});

/* ------------------------------------------------------- same-session handoff */

test('checkHandoff re-distills instead of returning early while a marker stays active', async () => {
  const { memory, clock, cleanup } = await makeMemory({
    config: { context: { nativeTokenLimit: 1000, autoRolloverThreshold: 0.85 } },
  });
  try {
    const markerAt = clock.now() - 60_000;
    fs.writeFileSync(
      path.join(memory.paths.state, 'handoff.json'),
      JSON.stringify({
        schema: 1,
        active: true,
        state: 'active',
        at: markerAt,
        sessionId: 'sess-A',
        ratio: 0.86,
        tokens: 860,
        nativeTokenLimit: 1000,
        summaryEventId: 'ev_old',
      }),
    );
    // 90% pressure: only +4 points over the marker → not enough growth to justify a
    // second distillation, and the marker must stay exactly as it was.
    memory.observeSessionTokens('sess-A', 900);
    const flat = await memory.checkHandoff({ distill: false });
    assert.equal(flat.handoff.at, markerAt, 'a small increase must not re-distill');

    // 98% → near the hard limit: the state machine must top the marker up instead of
    // staying dead for the rest of the conversation (the 1M incident's third defect).
    memory.observeSessionTokens('sess-A', 980);
    const again = await memory.checkHandoff({ distill: false });
    assert.equal(again.handoff.active, true);
    assert.ok(again.handoff.at > markerAt, `expected a fresh marker, still at ${again.handoff.at}`);
    assert.equal(again.rehandoff.reason, 'near-hard-limit');
  } finally {
    cleanup();
  }
});

/* --------------------------------------------------------- request guard */

test('an impossible request is rejected before it is sent, and a handoff is attempted first', async () => {
  const dir = tempDir('overflow-guard');
  const fixture = fakeCtx();
  // A host that reports the REAL window and the real (huge) measured pressure.
  fixture.services.set('llm', {
    async resolveModelInfo() {
      return { context: { contextWindow: WINDOW }, defaultMaxTokens: 256_000 };
    },
  });
  fixture.services.set('tokenMeter', {
    contextPressure() {
      return { pressureTokens: 854_668, projectedTokens: 854_668, contextWindow: WINDOW };
    },
  });
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;

    await assert.rejects(
      runtime.guardRequest({ agent: { session: { surface: { nodes: [] } } }, config: { provider: 'deepseek', model: 'deepseek-flash', maxTokens: 256_000 } }),
      (error) => {
        assert.equal(error.code, 'MEM_E_CONTEXT_EXCEEDED');
        assert.equal(error.details.reservedTokens, 256_000);
        assert.ok(error.details.projectedTokens > WINDOW);
        assert.equal(error.details.window, WINDOW);
        assert.equal(error.details.windowSource, 'host');
        return true;
      },
    );

    // The same agent with a small prompt must pass: the guard is a limiter, not a wall.
    fixture.services.set('tokenMeter', { contextPressure: () => ({ pressureTokens: 1_000, contextWindow: WINDOW }) });
    const state = await runtime.guardRequest({
      agent: { session: { surface: { nodes: [] } } },
      config: { provider: 'deepseek', model: 'deepseek-flash', maxTokens: 256_000 },
    });
    assert.equal(state.hardExceeded, false);
    assert.equal(state.nativeTokenLimit, WINDOW);
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a host with no llm/tokenMeter service never blocks a request', async () => {
  const dir = tempDir('overflow-headless');
  const fixture = fakeCtx();
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    const state = await runtime.guardRequest({ config: { provider: 'p', model: 'm', maxTokens: 1_000 } });
    assert.equal(state.hardExceeded, false);
    // No host window → the configured override is the fallback, and the source says so.
    assert.equal(state.windowSource, 'config');
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
