/**
 * v1.5.0 — multi-space routing and the physical session-handoff layer.
 *
 * The rule under test: a session may end, the persona does not.
 *   - below `context.nativeTokenLimit` nothing is folded (Qwen native mode);
 *   - at `context.autoRolloverThreshold` x nativeTokenLimit the tail is distilled
 *     into ONE L1.5 summary, state/handoff.json is marked active and the prompt
 *     advertises the marker;
 *   - with auto-rollover disabled, ContextEngine force-evicts at 95% instead;
 *   - a new session consumes the marker;
 *   - `targetSpaceId` routes reads/writes to an isolated physical store with its
 *     own file lock, and a typo can never fall back to the default space.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HANDOFF_TAG, FOLDED_TAG } from '../src/memory.js';
import { resolveConfig, toMemoryOptions } from '../src/config.js';
import { apply, createRuntime, getRuntime } from '../index.js';
import { createOrchestratorStub, FakeClock, T0, fakeCtx, makeMemory, tempDir } from './helpers.js';

const TAGS_OF = (event) => (event.tags ?? []).map((tag) => tag.tag ?? tag);

test('Qwen native mode: nothing is folded below nativeTokenLimit, folding resumes above it', async () => {
  const { memory, cleanup } = await makeMemory({ config: { context: { nativeTokenLimit: 8000 } } });
  try {
    memory.context.inject({ id: 'evict-a', text: '任务：完成发布检查。', tokens: 2000, salience: 0.1, at: T0 });
    memory.context.inject({ id: 'evict-b', text: '任务：整理变更日志。', tokens: 2000, salience: 0.2, at: T0 });

    const report = memory.context.enforce({ now: T0 });
    assert.equal(report.triggered, true, 'the legacy paging threshold still fires independently of native mode');
    assert.ok(report.evicted.length >= 1);
    const evictedTokens = report.evicted.reduce((sum, record) => sum + (record.tokens ?? 0), 0);
    assert.ok(memory.context.tokens() + evictedTokens < 8000, 'the folded + live volume is below the native window');

    const nativeFold = await memory.foldEvicted(report.evicted);
    assert.equal(nativeFold.folded, 0, 'below the native window verbatim wins: no L1.5 fold');
    assert.equal(nativeFold.mode, 'native');
    assert.equal(nativeFold.reason, 'native-mode');
    const events = memory.indexManager.snapshot()?.events ?? [];
    assert.equal(events.filter((event) => TAGS_OF(event).includes(FOLDED_TAG)).length, 0);

    // The session outgrows the native window: the same eviction batch now folds.
    memory.observeSessionTokens('session-layered', 9000);
    const layered = await memory.foldEvicted(report.evicted);
    assert.ok(layered.folded >= 1, 'above the native window the layered fold runs');
    const after = memory.indexManager.snapshot()?.events ?? [];
    assert.ok(after.some((event) => TAGS_OF(event).includes(FOLDED_TAG)), 'the folded summary is a durable L1 event');
  } finally {
    cleanup();
  }
});

test('nativeState draws the native/layered boundary exactly at nativeTokenLimit', async () => {
  const { memory, cleanup } = await makeMemory({ config: { context: { nativeTokenLimit: 1000 } } });
  try {
    assert.equal(memory.context.nativeState({ sessionTokens: 999 }).mode, 'native');
    assert.equal(memory.context.nativeState({ sessionTokens: 1000 }).mode, 'layered');
    assert.equal(memory.context.foldAllowed({ sessionTokens: 999 }), false);
    assert.equal(memory.context.foldAllowed({ sessionTokens: 1000 }), true);

    const state = memory.context.nativeState({ sessionTokens: 860 });
    assert.equal(state.remainingTokens, 0, 'handoff headroom is measured against threshold*native, not the hard limit');
    assert.equal(state.rolloverDue, true, '86% of a 0.85 threshold window is already due');
    assert.equal(memory.context.nativeState({ sessionTokens: 400 }).remainingTokens, 450);
  } finally {
    cleanup();
  }
});

test('reaching autoRolloverThreshold distils one L1.5 summary, marks the handoff and injects the prompt', async () => {
  const dir = tempDir('v150-handoff');
  const config = resolveConfig({
    dataDir: dir,
    autoMaintainOnBoot: false,
    context: { nativeTokenLimit: 1000, autoRolloverThreshold: 0.85, maxTokens: 100_000 },
  });
  const clock = new FakeClock(T0);
  const runtime = createRuntime({ config, options: toMemoryOptions(config), clock, orchestrator: createOrchestratorStub() });
  try {
    runtime.start();
    await runtime.ready;
    const memory = runtime.memory;
    memory.context.inject({
      id: 'tail-block',
      kind: 'recall',
      text: '任务：完成 v1.5.0 发布检查。要点：@Alice 负责验证跨空间迁移。',
      tokens: 120,
      salience: 0.9,
      at: T0,
    });
    memory.observeSessionTokens('session-a', 860);

    const result = await memory.checkHandoff({ now: T0 });
    assert.equal(result.rolloverDue, true);
    assert.equal(result.handoff.active, true, 'the handoff marker is set');

    // The durable summary is a real L1 event tagged for the handoff layer.
    const events = memory.indexManager.snapshot()?.events ?? [];
    const summary = events.find((event) => TAGS_OF(event).includes(HANDOFF_TAG));
    assert.ok(summary, 'the tail summary was stored as L1.5');
    assert.equal(result.handoff.summaryEventId, summary.eventId);
    assert.match(summary.content, /交接摘要/);
    assert.match(summary.content, /Alice/);

    // state/handoff.json is the durable marker the next session reads.
    const markerFile = path.join(dir, 'state', 'handoff.json');
    assert.equal(fs.existsSync(markerFile), true);
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    assert.equal(marker.active, true);
    assert.equal(marker.threshold, 0.85);
    assert.equal(marker.nativeTokenLimit, 1000);

    // Prompt injection: the marker rides the volatile tail, not the stable prefix.
    const prompt = runtime.promptState();
    assert.match(prompt, /\[交接标记\]/);
    assert.match(prompt, /人格不死/);
    assert.match(prompt, new RegExp(summary.eventId));

    // Idempotent: a second evaluation never mints a second summary.
    const again = await memory.checkHandoff({ now: T0 });
    assert.equal(again.handoff.active, true);
    const handoffSummaries = (memory.indexManager.snapshot()?.events ?? []).filter((event) =>
      TAGS_OF(event).includes(HANDOFF_TAG),
    );
    assert.equal(handoffSummaries.length, 1, 'one handoff, one summary');
  } finally {
    runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-rollover disabled: no marker, ContextEngine force-evicts at 95% of the native window', async () => {
  const { memory, cleanup } = await makeMemory({
    config: {
      context: { nativeTokenLimit: 1000, autoRolloverEnabled: false, autoRolloverThreshold: 0.85, maxTokens: 100_000 },
    },
  });
  try {
    memory.context.inject({ id: 'fat-block', kind: 'recall', text: 'x'.repeat(3900), tokens: 960, salience: 0.5, at: T0 });
    const result = await memory.checkHandoff({ now: T0 });
    assert.equal(result.handoff.active, false, 'a disabled handoff is never marked');
    assert.ok(result.forcedEviction, 'the 95% ceiling must force an eviction');
    assert.equal(result.forcedEviction.triggered, true);
    assert.equal(result.forcedEviction.reason, 'native-force');
    assert.equal(result.forcedEviction.forced, true);
    assert.ok(result.forcedEviction.after <= 700, 'evicted down to target x nativeTokenLimit, not target x maxTokens');
    assert.equal(fs.existsSync(memory.handoffPath()), false, 'no marker file is written when rollover is off');
  } finally {
    cleanup();
  }
});

test('a NEW session consumes the previous handoff marker', async () => {
  const { memory, cleanup } = await makeMemory({
    config: { context: { nativeTokenLimit: 1000, autoRolloverThreshold: 0.85, maxTokens: 100_000 } },
  });
  try {
    memory.context.inject({ id: 'tail', kind: 'recall', text: '发布检查尾巴', tokens: 100, salience: 0.9, at: T0 });
    memory.observeSessionTokens('session-old', 900);
    assert.equal((await memory.checkHandoff({ now: T0 })).handoff.active, true);

    memory.observeSessionTokens('session-new', 40);
    const marker = memory.handoffState();
    assert.equal(marker.active, false, 'the next session consumes the marker');
    assert.equal(marker.consumedBy, 'session-new');
    assert.match(memory.briefing(), /Memory gen=/, 'the briefing still renders after a marker change');
  } finally {
    cleanup();
  }
});

test('targetSpaceId isolates stores, survives concurrent writes and rejects path-like ids', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const [alpha, beta] = await Promise.all([
      memory.remember({ content: 'alpha-only fact', tags: ['space:isolation'], targetSpaceId: 'alpha', salience: 0.8 }),
      memory.remember({ content: 'beta-only fact', tags: ['space:isolation'], targetSpaceId: 'beta', salience: 0.8 }),
    ]);
    assert.ok(alpha.eventId && beta.eventId);
    assert.notEqual(alpha.eventId, beta.eventId, 'each space mints its own identity');

    const defaults = await memory.recall({ tags: ['space:isolation'] });
    assert.equal(defaults.hits.length, 0, 'spaces never leak into the default read path');

    const inAlpha = await memory.recall({ tags: ['space:isolation'], targetSpaceId: 'alpha' });
    assert.ok(inAlpha.hits.some((hit) => hit.snippet.includes('alpha-only fact')));
    assert.ok(!inAlpha.hits.some((hit) => hit.snippet.includes('beta-only fact')), 'no cross-space bleed');

    const inBeta = await memory.recall({ tags: ['space:isolation'], targetSpaceId: 'beta' });
    assert.ok(inBeta.hits.some((hit) => hit.snippet.includes('beta-only fact')));

    // Physical isolation is real directories, not in-memory namespaces.
    assert.equal(fs.existsSync(path.join(memory.dataDir, 'spaces', 'alpha', 'log', 'CURRENT')), true);
    const panel = (await memory.status()).panel;
    assert.ok(panel.spaces.ids.includes('default'));
    assert.ok(panel.spaces.ids.includes('alpha'));
    assert.ok(panel.spaces.ids.includes('beta'));

    // A typo must fail, never silently route the write into the default space.
    await assert.rejects(
      () => memory.remember({ content: 'evil', targetSpaceId: '../escape' }),
      (error) => error.code === 'MEM_E_INVALID_INPUT',
    );
    assert.equal((await memory.recall({ text: 'evil' })).hits.length, 0);
  } finally {
    cleanup();
  }
});

test('the panel session group feeds the status bar contract', async () => {
  const { memory, cleanup } = await makeMemory({
    config: { context: { nativeTokenLimit: 8000, autoRolloverThreshold: 0.85 } },
  });
  try {
    const panel = (await memory.status()).panel;
    assert.equal(panel.session.mode, 'native');
    assert.equal(panel.session.nativeTokenLimit, 8000);
    assert.equal(panel.session.threshold, 0.85);
    assert.equal(panel.session.remainingTokens, Math.ceil(0.85 * 8000));
    assert.equal(panel.session.rolloverEnabled, true);
    assert.equal(panel.session.handoffActive, false);
    assert.equal(panel.spaces.current, 'default');
    assert.deepEqual(panel.spaces.ids, ['default']);
    assert.ok(!('debounce' in panel.session), 'the status bar is a projection, not an interaction');
  } finally {
    cleanup();
  }
});

test('the memory_space_transfer tool defaults to copy and routes to the target space', async () => {
  const dir = tempDir('v150-transfer-tool');
  const host = fakeCtx();
  try {
    await apply(host.ctx, { dataDir: dir, autoMaintainOnBoot: false });
    const definition = host.tools.get('memory_space_transfer');
    assert.ok(definition, 'the ninth tool is registered before READY');
    assert.deepEqual([...definition.parameters.required].sort(), ['event_ids', 'target_space_id']);
    assert.equal(definition.parameters.properties.event_ids.type, 'array');
    assert.deepEqual(definition.parameters.properties.transfer_mode.enum, ['copy', 'move']);

    await getRuntime(host.ctx).ready;
    const runtime = getRuntime(host.ctx);
    const stored = await runtime.memory.remember({ content: 'tool transfer fact', tags: ['transfer:tool'], salience: 0.9 });
    const parsed = JSON.parse(
      await definition.execute({ event_ids: [stored.eventId], target_space_id: 'tool-space', user_approved: true }),
    );
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, 'copy', 'transferMode defaults to copy');
    assert.equal(parsed.source.state, 'retained');
    assert.notEqual(parsed.target.eventIds[0], stored.eventId, 'the target regenerates the event id');

    const inTarget = await runtime.memory.recall({ tags: ['transfer:tool'], targetSpaceId: 'tool-space' });
    assert.ok(inTarget.hits.length >= 1, 'the copy is readable in the target space');
    const inDefault = await runtime.memory.recall({ tags: ['transfer:tool'] });
    assert.ok(inDefault.hits.some((hit) => hit.eventId === stored.eventId), 'copy leaves the source readable');
  } finally {
    host.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
