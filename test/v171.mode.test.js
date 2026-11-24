/**
 * v1.7.1 — task/expert mode, the hint feedback loop, and prompt hygiene.
 *
 * Three problems, all observed in a real long build session:
 *
 *   1. injected summaries carried BOOKKEEPING counters ("events 348", "reviews 346 due
 *      337", "v1.6.9") that were true when written and false an hour later. The model
 *      spent tokens reading them and more tokens correcting them. → always-on hygiene:
 *      strip the counters, stamp the snapshot time, and never touch numbers that carry
 *      a lesson.
 *   2. `[Memory Hints]` kept advertising the same irrelevant tags turn after turn and
 *      never triggered a single recall. → a one-way silence after N fruitless showings
 *      (task mode only).
 *   3. a build session needs the CURRENT state (repo HEAD, window pressure), which
 *      memory cannot know. → one hard-capped `[Task State]` line (task mode only).
 *
 * The mode switch deliberately does NOT gate item 1: hygiene is not a preference, it
 * is a correctness fix (user decision, 2026-11-24).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { apply, getRuntime } from '../index.js';
import { HintFeedbackStore, HINT_IDLE_SILENCE_AFTER, shouldSilence } from '../src/hintFeedback.js';
import { hygienicSummary, isVolatileClause, stripVolatile } from '../src/promptHygiene.js';
import { renderStateLine, STATE_MARKER } from '../src/utils/promptLayout.js';
import { fakeCtx, makeMemory, T0, tempDir } from './helpers.js';

async function applied(extra = {}) {
  const dir = tempDir('v171-mode');
  const fixture = fakeCtx();
  await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false, ...extra });
  const runtime = getRuntime(fixture.ctx);
  await runtime.ready;
  return { runtime, dir, fixture };
}

function cleanup(target) {
  target.fixture.dispose();
  fs.rmSync(target.dir, { recursive: true, force: true });
}

test('the engine defaults to TASK mode and the switch is a validated enum', async () => {
  const target = await applied();
  try {
    assert.equal(target.runtime.config.context.mode, 'task');
    assert.equal(target.runtime.config.context.hintsIdleSilenceAfter, HINT_IDLE_SILENCE_AFTER);
    assert.equal(target.runtime.config.context.statePointer.enabled, true);
  } finally {
    cleanup(target);
  }
  // An unknown value must fail fast, not silently pick a mode.
  const dir = tempDir('v171-enum');
  const fixture = fakeCtx();
  try {
    await assert.rejects(
      () => apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', context: { mode: 'turbo' } }),
      /mode/,
    );
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('N fruitless showings silence a hint for good, and a recall does not revive it', () => {
  const dir = tempDir('v171-feedback');
  const file = path.join(dir, 'state', 'hint-feedback.json');
  try {
    let now = T0;
    const store = new HintFeedbackStore({ file, clock: { now: () => now } });
    store.load();
    const limit = 4;
    for (let round = 0; round < limit; round += 1) {
      now += 1000;
      const result = store.noteShown(['project:omni-pet'], { threshold: limit });
      // The transition happens on the LAST show, not after it.
      assert.equal(result.silenced.length, round === limit - 1 ? 1 : 0, `round ${round}`);
    }
    assert.deepEqual(store.silencedTags(), ['project:omni-pet']);
    // One-way: even a real recall must not bring the tag back.
    store.noteRecalled(['project:omni-pet']);
    assert.deepEqual(store.silencedTags(), ['project:omni-pet']);
    assert.deepEqual(store.filter(['project:omni-pet', 'task:dsh']), ['task:dsh']);
    // Persisted, so a restart does not re-offer the same tag forever.
    const reopened = new HintFeedbackStore({ file, clock: { now: () => now } });
    reopened.load();
    assert.deepEqual(reopened.silencedTags(), ['project:omni-pet']);
    // A tag that earns a recall is never silenced, however often it is shown after.
    store.noteShown(['task:dsh'], { threshold: limit });
    store.noteRecalled(['task:dsh']);
    for (let round = 0; round < limit * 3; round += 1) store.noteShown(['task:dsh'], { threshold: limit });
    assert.deepEqual(store.silencedTags(), ['project:omni-pet']);
    assert.equal(shouldSilence({ shown: limit, recalled: 1 }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('expert mode keeps every hint and injects no state line', async () => {
  const target = await applied({ context: { mode: 'expert' } });
  try {
    const prompt = target.runtime.promptState();
    assert.equal(prompt.includes(STATE_MARKER), false);
    assert.equal(target.runtime.statePointerText(), '');
    // Expert mode never CONSULTS the loop: promptState must run many times without
    // recording a single showing, so nothing can ever be silenced by this path.
    for (let round = 0; round < 5; round += 1) target.runtime.promptState();
    assert.equal(target.runtime.hintFeedbackView().tracked, 0);
    assert.equal(target.runtime.hintFeedbackView().silenced, 0);
  } finally {
    cleanup(target);
  }
});

test('task mode injects a bounded [Task State] line with the repo HEAD', async () => {
  const target = await applied();
  try {
    const prompt = target.runtime.promptState();
    assert.ok(prompt.includes(STATE_MARKER), 'task mode must add the state line');
    const line = target.runtime.statePointerText();
    const budget = target.runtime.config.context.statePointer.maxChars;
    assert.ok(line.length > 0);
    assert.ok(line.length <= budget, `state line ${line.length} exceeds ${budget}`);
    assert.match(line, /HEAD [0-9a-f]{7}/);
    // It sits LAST: nothing volatile may follow it.
    assert.equal(prompt.trimEnd().endsWith(line) || prompt.indexOf(STATE_MARKER) > prompt.indexOf('[Memory Blocks]'), true);
  } finally {
    cleanup(target);
  }
});

test('renderStateLine is hard-capped and skips empty fields', () => {
  const line = renderStateLine({ a: 'repo@main', b: '', c: null, d: 'HEAD abc1234' }, { maxChars: 60 });
  assert.ok(line.length <= 60);
  assert.equal(line.includes(' ·  · '), false);
  const clipped = renderStateLine({ a: 'x'.repeat(500) }, { maxChars: 40 });
  assert.equal(clipped.length, 40);
  assert.ok(clipped.endsWith('…'));
});

test('hygiene strips bookkeeping counters but keeps numbers that carry a lesson', () => {
  const stale =
    '交接摘要（2026-11-24：events 348 / reviews total 346 due 337 / version 1.6.9）；' +
    '1M 溢出事故：854,668 + 256,000 > 1,048,576，必须读宿主真实窗口。';
  const { text, removed } = stripVolatile(stale);
  assert.equal(text.includes('1.6.9'), false, 'a bare version stamp is not knowledge');
  assert.equal(/events\s*348/i.test(text), false);
  assert.equal(/due\s*337/i.test(text), false);
  // The lesson and its numbers survive: this is the line that must never be lost.
  assert.ok(text.includes('854,668'), text);
  assert.ok(text.includes('1,048,576'), text);
  assert.ok(text.includes('宿主真实窗口'));
  assert.ok(removed.length >= 1);
  // A pure counter clause is volatile; a sentence with a modal verb is not.
  assert.equal(isVolatileClause('events: 1446'), true);
  assert.equal(isVolatileClause('gen-000131'), true);
  assert.equal(isVolatileClause('必须保留 raw 原文，不许压缩'), false);

  const stamped = hygienicSummary(stale, { at: T0, maxChars: 400, label: 'cold start' });
  assert.match(stamped.text, /^\(snapshot \d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z · cold start · counters stripped as stale\)/);
  assert.ok(stamped.text.length <= 400);
  // Nothing left to say → no block at all, not an empty header.
  assert.equal(hygienicSummary('events 12 / version 9.9.9', { at: T0 }).text, '');
});

test('the cold-start block is hygienic and dated in a real handoff', async () => {
  const target = await applied();
  try {
    const { runtime, dir } = target;
    // Build the handoff the way the engine does: a summary event + a marker file. The
    // point here is the RENDERING contract, not the state machine (that is v160/v163).
    const summary = await runtime.memory.remember({
      content: '交接摘要（events 1446 / reviews total 362 due 0 / version 1.7.0）；结论：必须先读宿主真实窗口再决定是否交接。',
      tags: ['folded-summary', 'status:handoff'],
      salience: 0.9,
      eventTime: T0,
    });
    await runtime.memory.maintain({ reason: 'test' });
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state', 'handoff.json'),
      JSON.stringify({ schema: 1, active: true, at: T0, sessionId: 'sess-old', summaryEventId: summary.eventId, tailTurns: [] }),
    );

    runtime.noteColdStart({ sessionId: 'sess-new' });
    const text = runtime.coldStartText({ sessionId: 'sess-new' });
    assert.ok(text.includes('[Cold-Start Summary]'), text);
    assert.match(text, /snapshot \d{4}-\d{2}-\d{2}T/);
    assert.equal(/events\s*1446/i.test(text), false, text);
    assert.equal(text.includes('1.7.0'), false, text);
    assert.ok(text.includes('宿主真实窗口'), 'the lesson half must survive');
  } finally {
    cleanup(target);
  }
});
