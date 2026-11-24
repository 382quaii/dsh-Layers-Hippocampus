/**
 * v1.7.0 — the five roadmap items that turn three separate layers into one chain:
 *
 *   M1  structured handoff summary   (getLatestHandoffSummary returns FIELDS)
 *   M2  six L3 dimensions + no physiology (a persona, not a body)
 *   M3  privacy:secret               (store it, never serve it by accident)
 *   M4  user-vs-self provenance in Dream facts
 *   M5  per-tool usage evidence in /memory status
 *
 * The tests are deliberately behavioural: they assert what a caller (or a sibling
 * plugin) can observe, not that a particular helper exists.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { groupByDimension, inferDimension, stripPhysiology } from '../src/semantic/dimensions.js';
import { parseDistillation, parseFacts, localDistillation } from '../src/dream.js';
import { DAY_MS, T0, fakeCtx, makeMemory, tempDir } from './helpers.js';

test('M2: an L3 summary gets a dimension, a dim: tag, and no physiology in the persona block', async () => {
  const dir = tempDir('v170-dim');
  const fixture = fakeCtx();
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    const memory = runtime.memory;
    const store = memory.semanticStore;
    const clock = memory.clock;
    // A trait, and a physiological line that must never be inherited as personality.
    const trait = store.upsert({
      clock,
      title: '偏好：回答先用结论',
      text: '用户更喜欢先给结论再给细节。',
      tags: ['preference:style'],
      sourceEvents: ['ev_a'],
    });
    assert.equal(trait.dimension, 'preferences');
    assert.ok(trait.tags.includes('dim:preferences'));
    const body = store.upsert({
      clock,
      title: '人格：稳定',
      text: '人格稳定。\n体检：疲劳 0.4，心率 90。',
      tags: ['persona:traits'],
      sourceEvents: ['ev_b'],
    });
    assert.equal(body.dimension, 'persona');
    const persona = runtime.personaTraitsText();
    assert.match(persona, /\[Persona & Traits\]/);
    assert.match(persona, /\[preferences\]/);
    assert.match(persona, /\[persona\]/);
    assert.doesNotMatch(persona, /疲劳|心率/, 'physiological state must never ride in as a trait');
    // The pure helpers are the contract other plugins get.
    assert.equal(inferDimension({ text: '边界：不得自动转账' }), 'boundaries');
    assert.equal(stripPhysiology('人格稳定。\n疲劳 0.4'), '人格稳定。');
    assert.equal(groupByDimension([{ title: 'x', text: 'x', tags: ['dim:boundaries'] }]).get('boundaries').length, 1);
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M3: a privacy:secret memory is stored, withheld by default, and only served on request', async () => {
  const fixture = await makeMemory();
  try {
    const secret = await fixture.memory.remember({
      content: '用户的家庭住址是某某路 1 号',
      tags: ['privacy:secret', 'topic:home'],
      salience: 0.9,
      eventTime: T0,
    });
    assert.ok(secret.eventId);
    const plain = await fixture.memory.remember({
      content: '用户喜欢用 pnpm 而不是 npm',
      tags: ['preference:tools'],
      salience: 0.9,
      eventTime: T0,
    });
    await fixture.memory.maintain({ reason: 'test' });
    const ordinary = await fixture.memory.recall({ text: '住址 地址 pnpm', tags: [], topK: 10 });
    const ids = ordinary.hits.map((hit) => hit.eventId);
    assert.equal(ids.includes(secret.eventId), false, 'a secret hit must not be returned by default');
    assert.ok(ids.includes(plain.eventId));
    assert.ok(
      (ordinary.notes ?? []).some((note) => note.startsWith('privacy-withheld:')),
      'the caller may learn that something was withheld, as a count',
    );
    const explicit = await fixture.memory.recall({ text: '住址', tags: [], topK: 10, includeSecret: true });
    assert.ok(explicit.hits.some((hit) => hit.eventId === secret.eventId), 'an explicit request gets it');
  } finally {
    fixture.cleanup();
  }
});

test('M3: a secret memory is never advertised as an automatic pointer', async () => {
  const dir = tempDir('v170-pointer-secret');
  const fixture = fakeCtx();
  try {
    await apply(fixture.ctx, {
      dataDir: dir,
      maintenanceCron: '0 */6 * * *',
      autoMaintainOnBoot: false,
      context: { autoInjectIndex: { enabled: true, everyNTurns: 3, maxPointers: 3, maxChars: 300 } },
    });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    await runtime.memory.remember({
      content: '隐私：银行卡尾号 8888',
      tags: ['privacy:secret', 'topic:money'],
      salience: 0.95,
      eventTime: runtime.memory.clock.now(),
    });
    await runtime.runMaintenance('manual');
    const pointers = runtime.pointerEntries();
    assert.equal(pointers.length, 0, 'the pointer list is empty, not merely filtered at render time');
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M4: Dream facts carry provenance and an unattributed fact is dropped', async () => {
  const parsed = parseDistillation(
    JSON.stringify({
      summary: '先给结论再给细节更受欢迎',
      confidence: 0.8,
      dimension: 'preferences',
      facts: [
        { text: '用户要求先给结论', source: 'user' },
        { text: '我总结出这个套路', source: 'self' },
        { text: '无主陈述' },
        { text: '来源不认识', source: 'other' },
      ],
    }),
  );
  assert.deepEqual(parsed.facts, [
    { text: '用户要求先给结论', source: 'user' },
    { text: '我总结出这个套路', source: 'self' },
  ]);
  assert.equal(parsed.dimension, 'preferences');
  assert.deepEqual(parseFacts([{ text: 'x', source: 'USER' }]), [{ text: 'x', source: 'user' }]);
  // The mechanical fallback is not allowed to produce unattributed facts either.
  const local = localDistillation('topic:x', [
    { eventId: 'a', eventTime: T0, content: '用户说：先给结论', role: 'user' },
    { eventId: 'b', eventTime: T0 + 1, content: '我记下了这个偏好', role: 'assistant' },
    { eventId: 'c', eventTime: T0 + 2, content: '没有角色的事件' },
  ]);
  assert.deepEqual(local.facts.map((fact) => fact.source), ['user', 'self']);
});

test('M4: a distilled L3 summary keeps the fact list in its own meta', async () => {
  const fixture = await makeMemory({
    config: {
      dream: { useLlm: true, minGroupSize: 3, llm: { baseUrl: 'https://example.invalid', model: 'test-model', apiKey: 'k' } },
    },
  });
  try {
    const day = T0 - DAY_MS;
    for (const [index, text] of ['用户说喜欢简洁', '用户说不要客套', '用户说要先给结论'].entries()) {
      await fixture.memory.remember({ content: text, tags: ['topic:style'], salience: 0.9, eventTime: day + index });
    }
    await fixture.memory.maintain({ reason: 'test' });
    const run = await fixture.memory.executeDream({
      now: T0,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: '用户偏好简洁直接的回答',
                    confidence: 0.85,
                    dimension: 'preferences',
                    facts: [
                      { text: '用户要简洁', source: 'user' },
                      { text: '我应当先给结论', source: 'self' },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    assert.ok(run);
    // The index projects a whitelist of fields, so provenance is asserted on the
    // durable log record instead (the append-only source of truth).
    const log = await fixture.memory.logStore.snapshot();
    const hasTag = (record, wanted) => (record.tags ?? []).some((tag) => (tag?.tag ?? tag) === wanted);
    const distilled = log.records.find((record) => hasTag(record, 'status:dream'));
    assert.ok(distilled, 'a dream event must exist');
    assert.deepEqual(distilled.meta.facts.map((fact) => fact.source), ['user', 'self']);
    assert.equal(distilled.meta.dimension, 'preferences');
  } finally {
    fixture.cleanup();
  }
});

test('M1: the handoff summary is structured, and every raw turn carries a role', async () => {
  const dir = tempDir('v170-handoff-struct');
  const fixture = fakeCtx();
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    const memory = runtime.memory;
    await memory.remember({ content: '任务：把 1.7.0 发出去', tags: ['task:release'], salience: 0.9, eventTime: memory.clock.now() });
    await memory.remember({
      content: '偏好：回答先给结论',
      tags: ['preference:style', 'dim:preferences'],
      salience: 0.9,
      eventTime: memory.clock.now(),
    });
    memory.semanticStore.upsert({
      clock: memory.clock,
      title: '偏好：先结论',
      text: '用户更喜欢先给结论。',
      tags: ['preference:style'],
      dimension: 'persona',
      sourceEvents: ['ev_x'],
    });
    memory.semanticStore.upsert({
      clock: memory.clock,
      title: '事实：发布前要跑全量测试',
      text: '发布前必须跑全量测试。',
      tags: ['lesson:release'],
      dimension: 'facts-rules',
      sourceEvents: ['ev_y'],
    });
    // Write a marker with a tail, exactly the shape a real handoff produces.
    fs.mkdirSync(memory.paths.state, { recursive: true });
    fs.writeFileSync(
      memory.handoffPath(),
      JSON.stringify({
        schema: 1,
        active: true,
        state: 'active',
        at: memory.clock.now(),
        sessionId: 'sess-old',
        summaryEventId: null,
        tailTurns: [
          { role: 'user', text: '把 1.7.0 的文档也更新了' },
          { role: 'assistant', text: '好的，先写测试再改文档' },
        ],
      }),
      'utf8',
    );
    const summary = runtime.latestHandoffSummary();
    assert.equal(summary.active, true);
    assert.ok(summary.activeTask, 'activeTask is populated from the checkpoint/task: event');
    assert.match(summary.activeTask.text, /1\.7\.0/);
    assert.ok(summary.lastRawTurns.length > 0);
    for (const turn of summary.lastRawTurns) {
      assert.ok(turn.role === 'user' || turn.role === 'assistant', 'no unattributed text is ever handed over');
      assert.ok(turn.text.length > 0);
    }
    assert.ok(summary.personaTraits.length > 0);
    assert.equal(summary.personaTraits[0].dimension, 'persona');
    assert.ok(summary.recentFacts.length > 0);
    assert.equal(summary.recentFacts[0].dimension, 'facts-rules');
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M5: /memory status reports real tool usage and points at idle tools', async () => {
  const dir = tempDir('v170-tool-usage');
  const fixture = fakeCtx();
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    // One recall call through the REAL tool definition, so the counter is wired at
    // the same place a model would hit it.
    await fixture.tools.get('memory_recall').execute({ text: '任意', tags: [], top_k: 3 });
    assert.equal(runtime.toolUsage.counts.get('recall'), 1);
    const result = await runtime.memoryCommand({ rawInput: 'status', agent: { id: 'a1' } });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /工具使用（本进程）：/);
    assert.match(result.text, /recall 1/);
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
