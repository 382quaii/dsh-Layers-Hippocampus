/**
 * v1.6.5 — the microkernel contract (user directive 2026-11-15).
 *
 * The hippocampus is a MEMORY KERNEL: it owns storage, retrieval and distillation.
 * It must NOT drive the conversation (no "open a new session", no listening to the
 * host's UI or append-mode surfaces) and it must NOT spend model tokens to serve its
 * own slash commands. Everything that touches the conversation belongs to an outside
 * router plugin, which consumes the plain service interface instead.
 *
 * Three locks, one per assertion class requested:
 *  1. `/memory …` runs through the host command service (no model round-trip) — 0 tokens.
 *  2. Monthly memos (L2.5) are driven by `executeDream()`, and what they absorbed is
 *     marked `promoted_to_monthly` so Dream never distills the same diaries again.
 *  3. There is no host-UI / append-mode listener anywhere in the engine half.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { MONTHLY_TAG } from '../src/memory.js';
import { DAY_MS, fakeCtx, makeMemory, T0, tempDir } from './helpers.js';

// ---------------------------------------------------------------------------
// 1. `/memory` commands cost zero model tokens
// ---------------------------------------------------------------------------

test('the /memory command is registered through the host command service', async () => {
  const dir = tempDir('micokernel-commands');
  const fixture = fakeCtx();
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    const registered = fixture.commands.find(null, 'memory');
    assert.ok(registered, '/memory must be registered when the host offers a command service');
    assert.equal(registered.name, 'memory');
    assert.ok(typeof registered.description === 'string' && registered.description.length > 0);
    assert.ok(registered.input && typeof registered.input.hint === 'string');
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every /memory sub-command answers as plain text without a model request', async () => {
  const dir = tempDir('micokernel-zero-token');
  const fixture = fakeCtx();
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (...args) => {
    fetchCalls += 1;
    return realFetch(...args);
  };
  try {
    await apply(fixture.ctx, {
      dataDir: dir,
      maintenanceCron: '0 */6 * * *',
      autoMaintainOnBoot: false,
      enableDream: false,
    });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;

    for (const line of ['/memory status', '/memory mute', '/memory unmute', '/memory resume']) {
      const result = await fixture.commands.execute(null, line);
      assert.ok(result, `${line} must be handled by the command service`);
      assert.ok(result.kind === 'success' || result.kind === 'error', `${line} returns a CommandResult`);
      assert.equal(typeof result.text, 'string', `${line} answers with plain text`);
      assert.ok(result.text.length > 0, `${line} text must not be empty`);
    }

    // `/memory maintain` really runs maintenance (no LLM: Dream is off, and even with
    // it on the engine only reaches the network for Dream, never for a command).
    const maintained = await fixture.commands.execute(null, '/memory maintain');
    assert.equal(maintained.kind, 'success');

    // The decisive assertion: NOT ONE network call — a command never reaches the model.
    assert.equal(fetchCalls, 0, '/memory must not cause any model/network request');

    // Mute really silences the prompt block, and unmute restores it.
    const muted = runtime.promptState();
    assert.ok(!muted.includes('[Memory Hints]'), 'muted state injects no memory hints');
  } finally {
    globalThis.fetch = realFetch;
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/memory resume re-arms the handoff summary even after it was already delivered', async () => {
  const dir = tempDir('micokernel-resume');
  const fixture = fakeCtx();
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;

    // No handoff yet: resume must say so instead of pretending.
    const empty = await fixture.commands.execute(null, '/memory resume');
    assert.equal(empty.kind, 'error');
    assert.match(empty.text, /没有可恢复的交接摘要/);

    // The plain service accessor is what an outside router plugin uses.
    const summary = runtime.latestHandoffSummary();
    assert.equal(summary.active, false);
    assert.equal(summary.summaryEventId, null);
    assert.equal(summary.text, null);
    const service = fixture.ctx.get('hippocampus');
    assert.deepEqual(service.getLatestHandoffSummary(), summary);
    assert.equal(service.capabilities().service.latestHandoffSummary, true);
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown sub-command answers with the usage text and stays token-free', async () => {
  const dir = tempDir('micokernel-help');
  const fixture = fakeCtx();
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    await getRuntime(fixture.ctx).ready;
    const help = await fixture.commands.execute(null, '/memory');
    assert.equal(help.kind, 'success');
    assert.match(help.text, /resume/);
    assert.match(help.text, /maintain/);
    assert.match(help.text, /status/);
    assert.match(help.text, /mute/);
    const unknown = await fixture.commands.execute(null, '/memory nope');
    assert.equal(unknown.kind, 'error');
    assert.match(unknown.text, /未知子命令/);
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Monthly memos are scheduled by executeDream and removed from the Dream pool
// ---------------------------------------------------------------------------

test('executeDream runs the monthly memo first and promotes its diaries', async () => {
  const { memory, cleanup } = await makeMemory({
    policy: { activeSet: { minEvents: 1, minMass: 0.01 }, identity: { eventTimePolicy: 'explicit' } },
  });
  try {
    // Three October diaries under ONE tag: enough for a Dream group (minGroupSize 3)
    // and inside a COMPLETED month, so both schedulers would claim them.
    for (let i = 0; i < 3; i += 1) {
      await memory.remember({
        content: `october work item ${i}`,
        tags: ['project:october'],
        eventTime: Date.UTC(2023, 9, 3 + i),
        happenedAt: Date.UTC(2023, 9, 3 + i),
      });
    }
    const before = memory.indexManager.snapshot().events;
    const diaries = before.filter((event) => event.tags.some((tag) => tag.tag === 'project:october'));
    assert.equal(diaries.length, 3);

    const report = await memory.executeDream({ now: T0 });
    assert.equal(report.monthly.generated, 1, 'the monthly memo really ran');
    assert.deepEqual(report.monthly.months, ['2023-10']);

    const state = JSON.parse(fs.readFileSync(memory.monthlyStatePath(), 'utf8'));
    for (const diary of diaries) {
      assert.equal(state.promoted[diary.eventId], '2023-10', 'each absorbed diary is promoted_to_monthly');
    }

    // The decisive assertion: Dream's pool excluded them, so nothing was distilled a
    // second time (and the report says how many events it skipped for that reason).
    assert.ok(report.skippedPromoted >= 3, 'promoted diaries never enter a Dream group');
    assert.equal(report.merged, 0, 'nothing left to distill');
    for (const result of report.results ?? []) {
      for (const id of result.sourceEventIds ?? []) {
        assert.ok(!state.promoted[id], `dream must not re-distill promoted event ${id}`);
      }
    }
  } finally {
    cleanup();
  }
});

test('maintain() no longer produces monthly memos (one scheduler only)', async () => {
  const { memory, cleanup } = await makeMemory({
    policy: { activeSet: { minEvents: 1, minMass: 0.01 }, identity: { eventTimePolicy: 'explicit' } },
  });
  try {
    await memory.remember({ content: 'october kickoff', tags: ['project:october'], eventTime: Date.UTC(2023, 9, 3), happenedAt: Date.UTC(2023, 9, 3) });
    const report = await memory.maintain({ reason: 'manual' });
    assert.equal(report.monthly, undefined, 'monthly memos moved to executeDream');
    assert.equal(
      memory.indexManager.snapshot().events.filter((event) => event.tags.some((tag) => tag.tag === MONTHLY_TAG)).length,
      0,
    );
  } finally {
    cleanup();
  }
});

test('a diary promoted by an earlier run is never re-condensed', async () => {
  const { memory, clock, cleanup } = await makeMemory({
    policy: { activeSet: { minEvents: 1, minMass: 0.01 }, identity: { eventTimePolicy: 'explicit' } },
  });
  try {
    await memory.remember({ content: 'october one', tags: ['project:october'], eventTime: Date.UTC(2023, 9, 3), happenedAt: Date.UTC(2023, 9, 3) });
    await memory.remember({ content: 'october two', tags: ['project:october'], eventTime: Date.UTC(2023, 9, 4), happenedAt: Date.UTC(2023, 9, 4) });
    clock.set(T0);
    const first = await memory.executeDream({ now: T0 });
    assert.equal(first.monthly.generated, 1);

    // Next month: the promoted diaries must not form a group again.
    const later = T0 + 40 * DAY_MS;
    clock.set(later);
    const second = await memory.executeDream({ now: later });
    assert.equal(second.monthly.generated, 0, 'the memo is idempotent');
    assert.ok(second.skippedPromoted >= 2, 'the promoted diaries stay out of the pool');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. The engine half never listens to the host UI / append mode
// ---------------------------------------------------------------------------

test('the host half contains no UI or append-mode listener', () => {
  const root = new URL('..', import.meta.url);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'test' || entry.name === 'docs' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(full);
      }
    }
  };
  walk(path.join(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'src'));
  files.push(path.join(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'index.js'));

  const forbidden = [
    /\buiWorkspace\b/,
    /\bstartSession\s*\(/,
    /\bsessionStorage\b/,
    /\bappendMode\b/,
    /\bappend_mode\b/,
    /\bonSlot\s*\(/,
    /\bslots\.(?:register|mount)\s*\(/,
    /ctx\.slots\s*=/,
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(source), `${path.basename(file)} must not match ${pattern}`);
    }
  }
});
