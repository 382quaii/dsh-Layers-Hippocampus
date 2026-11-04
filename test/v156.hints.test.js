/**
 * v1.5.6 — relevance-first memory hints.
 *
 * Locked contracts:
 *   1. only tags that lexically overlap the CURRENT user input are hinted;
 *   2. internal bookkeeping tags (status:/month:/context:/active_task) never are;
 *   3. no match => no `[Memory Hints]` section at all (never padded);
 *   4. the section sits AFTER `[Memory Blocks]`, so the cacheable prefix is
 *      unaffected by per-turn hints;
 *   5. the last USER turn is tracked from `session/event` (prompt assembly itself
 *      carries no message text).
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { renderMemoryHints, selectRelevantTags } from '../src/utils/memoryHints.js';
import { tempDir } from './helpers.js';

function fakeCtx() {
  const tools = new Map();
  const sections = new Map();
  const contexts = new Map();
  const effects = [];
  const handlers = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    systemPrompt: {
      section(definition) {
        sections.set(definition.name, definition);
        return () => sections.delete(definition.name);
      },
      context(definition) {
        contexts.set(definition.name, definition);
        return () => contexts.delete(definition.name);
      },
    },
    effect(factory) {
      const disposer = factory();
      effects.push(disposer);
      return disposer;
    },
    get() {
      return null;
    },
    inject(_deps, callback) {
      callback(ctx);
      return () => {};
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
    off(name) {
      handlers.delete(name);
    },
    emitSessionEvent(session, event) {
      handlers.get('session/event')?.(session, event);
    },
    sections,
    contexts,
    async dispose() {
      for (const disposer of effects.reverse()) {
        if (typeof disposer === 'function') await disposer();
      }
    },
  };
  ctx.root = ctx;
  return ctx;
}

test('selectRelevantTags keeps matches and drops unrelated/internal tags', () => {
  const active = ['error:java-oom', 'lang:react', 'habit:release', 'status:handoff', 'month:2026-10', 'active_task'];
  const picked = selectRelevantTags({ text: 'React 组件 useEffect 重复渲染', activeTags: active });
  assert.ok(picked.includes('lang:react'));
  assert.ok(!picked.includes('error:java-oom'), 'the busiest unrelated tag is not hinted');
  assert.ok(!picked.some((tag) => tag.startsWith('status:')));
  assert.ok(!picked.some((tag) => tag.startsWith('month:')));
  assert.ok(!picked.includes('active_task'));
  assert.deepEqual(selectRelevantTags({ text: '', activeTags: active }), []);
  assert.deepEqual(selectRelevantTags({ text: '天气不错', activeTags: active }), []);

  const limited = selectRelevantTags({
    text: 'react vue svelte angular',
    activeTags: ['lang:react', 'lang:vue', 'lang:svelte', 'lang:angular'],
    limit: 5,
  });
  assert.equal(limited.length, 4, 'never more than the matching count');
  assert.ok(selectRelevantTags({ text: '发布门禁失败', activeTags: ['lesson:发布门禁'] }).includes('lesson:发布门禁'));
});

test('renderMemoryHints is absent when empty and names the recall tool otherwise', () => {
  assert.equal(renderMemoryHints([]), '');
  const text = renderMemoryHints(['lang:react', 'habit:release'], { toolName: 'memory_recall' });
  assert.match(text, /^\[Memory Hints\]/);
  assert.match(text, /lang:react、habit:release/);
  assert.match(text, /memory_recall/);
});

test('prompt tail carries only relevance hints and leaves the prefix stable', async () => {
  const dir = tempDir('hints');
  const ctx = fakeCtx();
  try {
    await apply(ctx, {
      dataDir: dir,
      maintenanceCron: '0 */6 * * *',
      autoMaintainOnBoot: false,
      policy: { activeSet: { minEvents: 1, minMass: 0.01 } },
    });
    const runtime = getRuntime(ctx);
    await runtime.ready;

    const now = runtime.memory.clock.now();
    await runtime.memory.remember({
      content: 'React 组件里 useEffect 的依赖数组必须完整，否则会重复渲染',
      tags: ['lang:react'],
      salience: 0.9,
      eventTime: now,
    });
    await runtime.memory.remember({
      content: 'Java 进程 OOM 时先看堆转储再谈扩容',
      tags: ['error:java-oom'],
      salience: 1,
      eventTime: now + 1000,
    });
    await runtime.memory.maintain({ reason: 'hints-test' });

    runtime.lastUserText = 'React 组件 useEffect 总是重复渲染';
    const view = runtime.memory.indexManager.snapshot();
    assert.ok(
      view.activeSet.entries.some((entry) => entry.tag === 'lang:react'),
      `active tags: ${view.activeSet.entries.map((entry) => entry.tag).join(',')}`,
    );
    assert.deepEqual(
      selectRelevantTags({
        text: runtime.lastUserText,
        activeTags: view.activeSet.entries.map((entry) => ({ tag: entry.tag })),
      }),
      ['lang:react'],
      'the selector itself matches lang:react',
    );
    const definition = ctx.contexts.get('memory-state');
    const before = definition.text();
    assert.match(before, /\[Memory Hints\]/);
    assert.match(before, /lang:react/);
    assert.ok(!before.includes('error:java-oom'), 'an unrelated tag is never injected');
    assert.ok(!before.includes('[Memory Map]'), 'the global active-tag map is gone');
    assert.ok(before.indexOf('[Memory Blocks]') < before.indexOf('[Memory Hints]'), 'hints live after the block marker');

    const prefixBefore = before.slice(0, before.indexOf('[Memory Blocks]'));
    runtime.lastUserText = '随便聊聊天气';
    const after = definition.text();
    assert.ok(!after.includes('[Memory Hints]'), 'no match => the section is absent');
    assert.equal(after.slice(0, after.indexOf('[Memory Blocks]')), prefixBefore, 'prefix cache is untouched');
  } finally {
    await ctx.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session/event(user/message) updates the hint input', async () => {
  const dir = tempDir('hints-track');
  const ctx = fakeCtx();
  try {
    await apply(ctx, {
      dataDir: dir,
      maintenanceCron: '0 */6 * * *',
      autoMaintainOnBoot: false,
      policy: { activeSet: { minEvents: 1, minMass: 0.01 } },
    });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    assert.equal(runtime.lastUserText, '');

    ctx.emitSessionEvent(null, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'React 的 useEffect 依赖' }] },
    });
    assert.equal(runtime.lastUserText, 'React 的 useEffect 依赖');

    // Non-user surface events must not overwrite the hint input.
    ctx.emitSessionEvent(null, {
      type: 'assistant/message',
      data: { content: [{ type: 'text', text: '让我看一下依赖数组' }] },
    });
    assert.equal(runtime.lastUserText, 'React 的 useEffect 依赖');
  } finally {
    await ctx.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
