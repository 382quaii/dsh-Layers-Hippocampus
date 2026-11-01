import assert from 'node:assert/strict';
import test from 'node:test';
import { foldText, extractEntities } from '../src/utils/RegexExtractor.js';
import { composePrompt, stablePrefix, renderMemoryMap } from '../src/utils/promptLayout.js';
import { slimToolOutput, needsSlimming } from '../src/utils/ToolOutputSlimmer.js';
import { WriteQueue } from '../src/utils/WriteQueue.js';
import { applyConfidence } from '../src/retrieval.js';
import { makeMemory, FakeClock, T0, DAY_MS } from './helpers.js';

const cfg = (raw = {}) => ({ config: { raw: { mode: 'all', autoCapture: true, maxTurnKb: 64, maxBytesPerDay: 8, maxTotalMb: 256, retentionDays: 30, maxScanMb: 16, maxResultTokens: 1000, captureRatio: 1, ...raw } } });

test('regex fold: entities + emotional clue, capped and deduped', () => {
  const text = '部署时 https://x.dev/a?b=1 报错 失败，路径 C:\\work\\app.js 和 --timeout=30，函数 runTask 又报错 失败 崩溃';
  const { entities } = extractEntities(text);
  assert.ok(entities.some((e) => e.kind === 'URL'));
  assert.ok(entities.some((e) => e.kind === 'WinPath'));
  assert.ok(entities.some((e) => e.kind === 'CLI'));
  assert.ok(entities.some((e) => e.kind === 'Ident' && e.value === 'runTask'));
  assert.ok(entities.some((e) => e.clue && e.clue.includes('报错')), 'emotional clue kept');
  assert.ok(entities.filter((e) => e.kind === 'URL').length <= 5);
  assert.equal(new Set(entities.map((e) => `${e.kind}:${e.value}`)).size, entities.length, 'deduped');
  assert.match(foldText(text), /\[Auto-Folded\] URL: https:\/\/x\.dev/);
});

test('regex fold: 10000-char truncation stays under 10ms', () => {
  const huge = `${'a '.repeat(30_000)} https://late.example/x 报错 失败`;
  const started = performance.now();
  const { entities, truncated } = extractEntities(huge);
  const elapsed = performance.now() - started;
  assert.equal(truncated, true);
  assert.ok(elapsed < 10, `regex fold took ${elapsed.toFixed(2)}ms`);
  assert.equal(entities.some((e) => e.value.includes('late.example')), false, 'beyond the cap is not scanned');
});

test('prompt layout: rules first, blocks last, prefix stable across block changes', () => {
  const rules = 'You are a careful agent. 规则 A';
  const map = renderMemoryMap([{ tag: 'project:dsh', count: 3 }, { tag: 'topic:music', count: 2 }]);
  const a = composePrompt({ rules, map, blocks: 'block one' });
  const b = composePrompt({ rules, map, blocks: 'block two is much longer' });
  assert.ok(a.startsWith(rules));
  assert.ok(a.indexOf('block one') > a.indexOf('[Memory Map]'));
  assert.equal(stablePrefix(a), stablePrefix(b), 'prefix cache is not disturbed');
});

test('tool output slimming keeps recovery hash and deep_raw restores the original', async () => {
  const { memory, cleanup } = await makeMemory(cfg());
  try {
    const original = `begin ${'x'.repeat(4000)} end`;
    const captured = await memory.captureRaw({ content: original, role: 'tool', kind: 'tool_output', force: true });
    assert.equal(captured.stored, true);
    await memory.raw.flush();
    const slim = slimToolOutput({ text: original, sha256: captured.sha256, turnId: captured.turnId });
    assert.equal(slim.slimmed, true);
    assert.match(slim.text, /\[Slimmed\] 原文快照: hash_/);
    assert.match(slim.text, /deep_raw/);
    assert.equal(needsSlimming(original), true);
    const restored = await memory.deepRaw({ hash: slim.snapshotId });
    assert.equal(restored.hits[0].content, original, 'hash restore is verbatim');
  } finally {
    cleanup();
  }
});

test('write queue parks bursts above 20 and drains without blocking', () => {
  const clock = new FakeClock(T0);
  const batches = [];
  const queue = new WriteQueue({ clock, onFlush: (batch) => batches.push(batch.length) });
  for (let i = 0; i < 30; i += 1) assert.equal(typeof queue.push(i), 'number');
  assert.ok(queue.length > 0, 'burst is queued, push returned already');
  queue.flush();
  assert.equal(queue.length, 0);
  assert.deepEqual(batches, [30]);
  queue.dispose();
});

test('captureRatio 0.5 samples deterministically; 0 blocks capture and deep_raw warns', async () => {
  const half = await makeMemory(cfg({ captureRatio: 0.5 }));
  try {
    let stored = 0;
    for (let seq = 1; seq <= 20; seq += 1) {
      const result = await half.memory.captureSessionEvent({ id: 's' }, { type: 'user/message', seq, time: T0, data: { content: [{ type: 'text', text: `turn ${seq}` }] } });
      if (result.stored) stored += 1;
    }
    assert.ok(stored > 0 && stored < 20, `sampled ${stored}/20`);
    // Deterministic replay: the same event yields the SAME verdict every time.
    const replayA = await half.memory.captureSessionEvent({ id: 's' }, { type: 'user/message', seq: 7, time: T0, data: { content: [{ type: 'text', text: 'turn 7' }] } });
    const replayB = await half.memory.captureSessionEvent({ id: 's' }, { type: 'user/message', seq: 7, time: T0, data: { content: [{ type: 'text', text: 'turn 7' }] } });
    assert.equal(Boolean(replayA.stored), Boolean(replayB.stored), 'sampling is deterministic');
    await half.memory.raw.flush();
  } finally {
    half.cleanup();
  }
  const off = await makeMemory(cfg({ captureRatio: 0 }));
  try {
    const skipped = await off.memory.captureSessionEvent({ id: 's' }, { type: 'user/message', seq: 1, time: T0, data: { content: [{ type: 'text', text: 'nope' }] } });
    assert.equal(skipped.skipped, 'capture-ratio-0');
    const warned = await off.memory.deepRaw({ text: '', startTime: T0 - DAY_MS, endTime: T0 + DAY_MS });
    assert.match(warned.warning, /黑匣子留存已关闭/);
  } finally {
    off.cleanup();
  }
});

test('confidence: low hits become short hints, never full bodies', () => {
  const hits = [
    { eventId: 'a', score: 1, snippet: 'high body' },
    { eventId: 'b', score: 0.2, snippet: 'low body' },
  ];
  const result = applyConfidence(hits, 0.6);
  assert.equal(result.hits[0].snippet, 'high body');
  assert.match(result.hits[1].snippet, /低置信/);
  assert.equal(result.hits[1].lowConfidence, true);
  assert.deepEqual(result.notes, ['low-confidence-hints:1']);
});
