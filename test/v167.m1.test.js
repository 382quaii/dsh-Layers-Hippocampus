/**
 * v1.6.7 M1 — index-style prompt injection.
 *
 * The rule under test: the live window must NOT pay for memory BODIES on every turn.
 * A block reaches the prompt as one pointer line — eventId, tags, title — and the body
 * is fetched on demand with the recall tool. `full` keeps the legacy rendering for
 * anyone who wants it, and an explicit token weight from a caller always wins.
 *
 * The economic claim is testable directly: the same blocks, in `index` mode, cost
 * dramatically fewer window tokens than in `full` mode.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import {
  ContextEngine,
  FULL_MODE,
  INDEX_MODE,
  INDEX_TAG_LIMIT,
  INDEX_TITLE_CHARS,
  estimateTokens,
  renderBlockLine,
} from '../src/context/contextEngine.js';
import { resolveConfig } from '../src/config.js';
import { EDITABLE_CONFIG_KEYS } from '../src/webRoutes.js';
import { T0, fakeCtx, makeMemory, tempDir } from './helpers.js';

function engine(overrides = {}) {
  return new ContextEngine({ clock: { now: () => T0 }, getPolicy: () => ({}), ...overrides });
}

test('index is the default and renders id + tags + title, never the body', () => {
  const ctx = engine();
  assert.equal(ctx.injectMode, INDEX_MODE);
  ctx.inject({
    id: 'ev_abc',
    kind: 'recall',
    text: 'x'.repeat(4000),
    title: '发布门禁为什么卡住',
    tags: ['project:omni-pet', 'task:release', 'extra:fourth', 'extra:fifth'],
    at: T0,
  });
  const rendered = ctx.render();
  assert.match(rendered, /- \[memory ev_abc\] /, 'the eventId is the pointer');
  assert.match(rendered, /发布门禁为什么卡住/, 'the title is carried');
  assert.match(rendered, /project:omni-pet/, 'the first tag is carried');
  assert.ok(!rendered.includes('x'.repeat(400)), 'the body never reaches the prompt');
  // Tags are bounded so one heavily-tagged memory cannot become its own paragraph.
  assert.ok(
    rendered.split(' · ').length <= INDEX_TAG_LIMIT + 2,
    `at most ${INDEX_TAG_LIMIT} tags are shown`,
  );
});

test('index mode charges the pointer line, not the body (the M1 saving)', async () => {
  const { memory, cleanup } = await makeMemory({
    config: { context: { maxTokens: 10_000, injectMode: 'index' } },
  });
  try {
    const body = 'y'.repeat(8000); // ~2000 tokens if it were emitted
    memory.context.inject({ id: 'ev_big', kind: 'recall', text: body, title: 'short title', tags: ['tag:a'], at: T0 });
    const indexTokens = memory.context.tokens();
    const pointerLine = memory.context.render();
    assert.equal(indexTokens, estimateTokens(pointerLine), 'the charge IS the rendered line');
    assert.ok(indexTokens < 100, `a pointer must be cheap, got ${indexTokens}`);
    assert.ok(indexTokens < estimateTokens(body) / 10, 'an order of magnitude cheaper than the body');
  } finally {
    cleanup();
  }
});

test('full mode keeps the legacy rendering AND the legacy body weight', async () => {
  const { memory, cleanup } = await makeMemory({
    config: { context: { maxTokens: 10_000, injectMode: 'full' } },
  });
  try {
    const body = 'z'.repeat(8000);
    memory.context.inject({ id: 'ev_full', kind: 'recall', text: body, title: 'ignored in full', tags: ['tag:b'], at: T0 });
    // Legacy weight = the whole body, even though render() shows a 200-char snippet.
    assert.equal(memory.context.tokens(), estimateTokens(body));
    const rendered = memory.context.render();
    assert.match(rendered, /- \[memory ev_full\] /);
    assert.ok(!rendered.includes('ignored in full'), 'full mode renders the body, not the title');
    assert.ok(rendered.length < 300, 'the snippet is bounded');
  } finally {
    cleanup();
  }
});

test('an explicit token weight from the caller always wins', () => {
  const ctx = engine({ injectMode: 'index' });
  ctx.inject({ id: 'ev_weight', text: 'q'.repeat(4000), tokens: 777, at: T0 });
  assert.equal(ctx.tokens(), 777);
  // ...and it still wins after the mode flips.
  ctx.inject({ id: 'ev_weight', text: 'q'.repeat(4000), tokens: 777, at: T0 });
  assert.equal(ctx.tokensOf(ctx.blocks[0]), 777);
});

test('a briefing block is never degraded to a pointer', () => {
  const ctx = engine({ injectMode: 'index' });
  ctx.inject({ id: 'briefing:policy', kind: 'briefing', text: 'OPERATOR POLICY: never delete without consent.', pinned: true });
  const rendered = ctx.render();
  assert.match(rendered, /OPERATOR POLICY: never delete without consent\./, 'briefing text is emitted verbatim');
  assert.ok(!rendered.includes('[memory briefing:policy]'), 'no pointer form for a briefing');
});

test('renderBlockLine keeps the pointer short and falls back to the body head', () => {
  const longTitle = renderBlockLine(
    { id: 'ev_t', kind: 'recall', text: 'body ' + 'w'.repeat(2000), title: 'T'.repeat(400), tags: null },
    { mode: INDEX_MODE },
  );
  const bound = '- [memory ev_t] recall · '.length + INDEX_TITLE_CHARS + 1;
  assert.ok(longTitle.length <= bound, `the title is capped at INDEX_TITLE_CHARS, got ${longTitle.length} > ${bound}`);
  const noTitle = renderBlockLine(
    { id: 'ev_u', kind: 'recall', text: 'fallback title here ' + 'v'.repeat(2000) },
    { mode: INDEX_MODE },
  );
  assert.match(noTitle, /fallback title here/, 'a missing title falls back to the body head');
  assert.ok(noTitle.length <= '- [memory ev_u] recall · '.length + INDEX_TITLE_CHARS + 1);
  // A block with neither title nor tags still renders a usable pointer.
  const bare = renderBlockLine({ id: 'ev_v', kind: 'semantic', text: 'bare body head ' + 'u'.repeat(2000) }, { mode: INDEX_MODE });
  assert.match(bare, /- \[memory ev_v\] semantic · bare body head/);
});

test('injectMode is validated, editable and defaults to index', () => {
  const resolved = resolveConfig({});
  assert.equal(resolved.context.injectMode, 'index');
  assert.equal(resolveConfig({ context: { injectMode: 'full' } }).context.injectMode, 'full');
  assert.throws(() => resolveConfig({ context: { injectMode: 'bodies' } }), /injectMode/);
  assert.ok(EDITABLE_CONFIG_KEYS.includes('context.injectMode'), 'the operator can flip it over HTTP');
});

test('the prompt states that blocks are pointers, and only in index mode', async () => {
  const run = async (injectMode) => {
    const dir = tempDir(`m1-${injectMode}`);
    const fixture = fakeCtx();
    try {
      await apply(fixture.ctx, {
        dataDir: dir,
        maintenanceCron: '0 */6 * * *',
        autoMaintainOnBoot: false,
        context: { injectMode },
      });
      const runtime = getRuntime(fixture.ctx);
      await runtime.ready;
      const now = runtime.memory.clock.now();
      await runtime.memory.remember({ content: '发布门禁失败时先看 CI 日志再改代码', tags: ['lesson:release'], salience: 0.9, eventTime: now });
      await runtime.memory.maintain({ reason: 'm1-test' });
      return { text: runtime.promptState() };
    } finally {
      fixture.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const indexRun = await run('index');
  assert.match(indexRun.text, /INDEX POINTER/, 'index mode tells the model these are pointers');
  assert.match(indexRun.text, /\[Memory Blocks\]/, 'the marker itself is unchanged');

  const fullRun = await run('full');
  assert.ok(!fullRun.text.includes('INDEX POINTER'), 'full mode keeps the legacy rules byte-for-byte');
  // The rules are the ONLY prefix difference between the two modes.
  const before = (text) => text.slice(0, text.indexOf('[Memory Blocks]'));
  assert.notEqual(before(indexRun.text), before(fullRun.text));
  assert.match(before(fullRun.text), /The engine measures and pages this window/);
});

test('recall hits carry tags and a title into the window', async () => {
  const dir = tempDir('m1-recall');
  const fixture = fakeCtx();
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    const now = runtime.memory.clock.now();
    // A body much longer than the title cap: the head is the pointer's title, and the
    // tail (the part a plain-text block used to spend tokens on) must NOT appear.
    await runtime.memory.remember({
      content: '发布门禁失败时先看 CI 日志再改代码 ' + '填充正文'.repeat(60) + ' TAIL-MARKER-正文尾巴',
      tags: ['lesson:release'],
      salience: 1,
      eventTime: now,
    });
    await runtime.memory.maintain({ reason: 'm1-recall' });
    // The window is fed by the TOOL path (that is where a model actually reads from),
    // not by the service-level recall, which is a pure query.
    const recallTool = fixture.tools.get('memory_recall');
    assert.ok(recallTool, 'the recall tool is registered');
    const payload = JSON.parse(await recallTool.execute({ text: '发布门禁 CI', tags: [], top_k: 5 }));
    assert.ok((payload.hits ?? []).length > 0, 'the recall produced a hit');
    const text = runtime.promptState();
    assert.match(text, /\[memory ev_/, 'a pointer with an eventId reached the prompt');
    assert.match(text, /lesson:release/, 'the tags are carried');
    assert.ok(!text.includes('TAIL-MARKER-正文尾巴'), 'the body beyond the title cap is NOT in the prompt');
    // ...but the body is still there for the folding path: `full` can render it.
    assert.ok(runtime.memory.context.render({ mode: 'full' }).length > 0, 'the body is retained in the block');
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
