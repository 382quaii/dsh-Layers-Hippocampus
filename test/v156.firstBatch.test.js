/**
 * v1.5.6 — first batch: reserved-tag isolation, [Active Task], fallback hints and
 * session-scoped injection dedup.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { renderMemoryHints, selectRelevantTags } from '../src/utils/memoryHints.js';
import { fakeCtx, makeMemory, T0, tempDir } from './helpers.js';

function writeHandoffMarker(dir, marker) {
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'handoff.json'), JSON.stringify(marker), 'utf8');
}

test('reserved status tags never reach the graph or the tag tree', async () => {
  const fixture = await makeMemory();
  try {
    const { memory } = fixture;
    await memory.remember({ content: '交接摘要：下一步 X', tags: ['status:handoff'], eventTime: T0 });
    await memory.remember({ content: '折叠摘要占位', tags: ['status:folded'], eventTime: T0 + 1 });
    await memory.remember({ content: '折叠标记', tags: ['folded-summary'], eventTime: T0 + 2 });
    await memory.remember({ content: '真正的业务记忆', tags: ['project:alpha', 'module:graph'], eventTime: T0 + 3 });
    await memory.maintain({ reason: 'reserved-tags' });

    const graph = memory.graphView(100);
    const nodeIds = graph.nodes.map((node) => node.id);
    assert.ok(nodeIds.includes('project:alpha'));
    assert.ok(nodeIds.includes('module:graph'));
    assert.ok(nodeIds.every((id) => !id.startsWith('status:')), 'no status:* node in the graph');
    assert.ok(!nodeIds.includes('folded-summary'), 'no folded-summary node in the graph');
    assert.ok(
      graph.edges.every((edge) => !edge.source.startsWith('status:') && !edge.target.startsWith('status:')),
      'no status:* edge in the graph',
    );

    const tree = memory.tagTreeView();
    assert.deepEqual(tree.ghosts, []);
    const treeStatus = memory.tagTree.status();
    assert.equal(treeStatus.roots, 2, 'the tag tree only holds the two business roots');
  } finally {
    fixture.cleanup();
  }
});

test('[Active Task] is injected from the handoff summary at session start', async () => {
  const dir = tempDir('active-task');
  const { ctx, dispose } = fakeCtx();
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    const summary = await runtime.memory.remember({
      content: '上一轮进度：已完成物理切割；下一步：补 Orchestrator 服务注册。',
      tags: ['status:handoff'],
      eventTime: T0,
    });
    await runtime.runMaintenance('test');
    writeHandoffMarker(dir, { active: true, at: T0, sessionId: 'old', summaryEventId: summary.eventId });

    const prompt = runtime.promptState();
    assert.ok(prompt.includes('[Active Task]'), 'the block is present');
    assert.ok(prompt.includes('补 Orchestrator 服务注册'), 'the summary body is present');
    // Injected once per session.
    assert.ok(!runtime.promptState().includes('[Active Task]'), 'the active task is not re-injected in the same session');
  } finally {
    dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('[Active Task] falls back to the newest task: event', async () => {
  const dir = tempDir('active-task-tag');
  const { ctx, dispose } = fakeCtx();
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    await runtime.memory.remember({ content: '任务进度：先修标签过滤，再修图谱交互。', tags: ['task:batch-1'], eventTime: T0 });
    await runtime.runMaintenance('test');
    const prompt = runtime.promptState();
    assert.ok(prompt.includes('[Active Task]'));
    assert.ok(prompt.includes('先修标签过滤'));
  } finally {
    dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('short inputs reuse the previous turn tags as fallback hints', async () => {
  const dir = tempDir('hints-fallback');
  const { ctx, dispose } = fakeCtx();
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    await runtime.memory.remember({ content: 'project alpha 记录一', tags: ['project:alpha'], eventTime: T0 });
    await runtime.memory.remember({ content: 'project alpha 记录二', tags: ['project:alpha'], eventTime: T0 + 1 });
    await runtime.memory.remember({ content: 'project alpha 记录三', tags: ['project:alpha'], eventTime: T0 + 2 });
    await runtime.runMaintenance('test');

    runtime.lastUserText = 'project:alpha 在哪里';
    const first = runtime.promptState();
    assert.ok(first.includes('project:alpha'), 'a matching tag is hinted');

    runtime.lastUserText = '继续';
    // New session: the dedup pool resets, so the fallback tags can be injected.
    runtime.memory.observeSessionTokens('session-fallback', 100);
    const second = runtime.promptState();
    assert.ok(second.includes('project:alpha'), 'the fallback reuses the previous turn tag');

    // Pure function contract, independent of the runtime.
    assert.deepEqual(
      selectRelevantTags({ text: '继续', activeTags: [], fallbackTags: ['project:alpha', 'x:y', 'status:handoff'] }),
      ['project:alpha', 'x:y'],
    );
    assert.equal(renderMemoryHints([]), '');
  } finally {
    dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session-scoped dedup blocks the second injection and resets on a new session', async () => {
  const dir = tempDir('injection-dedup');
  const { ctx, dispose } = fakeCtx();
  try {
    await apply(ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(ctx);
    await runtime.ready;
    await runtime.memory.remember({ content: 'project beta 记录一', tags: ['project:beta'], eventTime: T0 });
    await runtime.memory.remember({ content: 'project beta 记录二', tags: ['project:beta'], eventTime: T0 + 1 });
    await runtime.memory.remember({ content: 'project beta 记录三', tags: ['project:beta'], eventTime: T0 + 2 });
    await runtime.runMaintenance('test');

    runtime.lastUserText = 'project:beta 是什么';
    const first = runtime.promptState();
    assert.ok(first.includes('project:beta'));

    const second = runtime.promptState();
    assert.ok(!second.includes('project:beta'), 'the same tag is not injected twice in one session');

    // A new session clears the pool; the tag may be injected again.
    runtime.memory.observeSessionTokens('session-2', 100);
    runtime.lastUserText = 'project:beta 再问一次';
    const third = runtime.promptState();
    assert.ok(third.includes('project:beta'), 'the new session starts with a fresh dedup pool');

    // Single prompt must not repeat the same tag body.
    assert.equal(third.split('project:beta').length - 1, 1);
  } finally {
    dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
