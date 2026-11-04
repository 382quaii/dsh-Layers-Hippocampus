/**
 * v1.5.6 — automatic new conversation on handoff.
 *
 * Verified Host surface: the CLIENT service `uiWorkspace.startSession()` is the
 * same action the "+" button uses, so a client-half plugin can open a fresh
 * conversation; `ctx.agents.create/resume` also exists host-side. This suite locks
 * the memory-plugin contract: config flag (default true), handoff payload, and the
 * client controller source (one fire per marker, capability-guarded).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { resolveConfig } from '../src/config.js';
import { EDITABLE_CONFIG_KEYS } from '../src/webRoutes.js';
import { fakeCtx, tempDir } from './helpers.js';

test('context.autoNewSession defaults true and is fail-fast/editable', () => {
  assert.equal(resolveConfig({}).context.autoNewSession, true);
  assert.equal(resolveConfig({ context: { autoNewSession: false } }).context.autoNewSession, false);
  assert.throws(
    () => resolveConfig({ context: { autoNewSession: 'yes' } }),
    (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE',
  );
  assert.ok(EDITABLE_CONFIG_KEYS.includes('context.autoNewSession'));
});

test('poll mode and interval are validated and editable', () => {
  const defaults = resolveConfig({});
  assert.equal(defaults.context.autoNewSessionPoll, 'interval');
  assert.equal(defaults.context.autoNewSessionIntervalSeconds, 15);
  assert.equal(resolveConfig({ context: { autoNewSessionPoll: 'once' } }).context.autoNewSessionPoll, 'once');
  assert.throws(
    () => resolveConfig({ context: { autoNewSessionPoll: 'sometimes' } }),
    (error) => error.code === 'MEM_E_CONFIG_UNKNOWN_ENUM',
  );
  assert.throws(
    () => resolveConfig({ context: { autoNewSessionIntervalSeconds: 1 } }),
    (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
  );
  assert.throws(
    () => resolveConfig({ context: { autoNewSessionIntervalSeconds: 7200 } }),
    (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
  );
  assert.ok(EDITABLE_CONFIG_KEYS.includes('context.autoNewSessionPoll'));
  assert.ok(EDITABLE_CONFIG_KEYS.includes('context.autoNewSessionIntervalSeconds'));
});

test('stats expose the handoff view + capability the client controller reads', async () => {
  const dir = tempDir('auto-session');
  const fixture = fakeCtx();
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    const payload = await runtime.uiPayload();
    assert.equal(payload.capabilities.autoNewSession, true);
    assert.equal(typeof payload.handoff, 'object');
    assert.equal(payload.handoff.autoNewSession, true);
    assert.equal(payload.handoff.active, false, 'no handoff yet');
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('client controller uses uiWorkspace.startSession with a one-fire guard', () => {
  const source = fs.readFileSync(new URL('../ui/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes("ctx.get('uiWorkspace')"), 'client service lookup');
  assert.ok(source.includes('workspace.startSession('), 'opens the Host new-conversation action');
  assert.ok(source.includes('handoff.autoNewSession !== true'), 'respects the config flag from stats');
  assert.ok(source.includes('hippocampus-auto-session:'), 'one fire per handoff marker');
  assert.ok(source.includes('function startAutoNewSession(ctx)'));
  assert.ok(source.includes('ctx.effect(() => startAutoNewSession(ctx))'), 'lifecycle-owned poll');
});

test('client scheduling honors the poll config (once vs interval)', () => {
  const source = fs.readFileSync(new URL('../ui/client.js', import.meta.url), 'utf8');
  assert.ok(source.includes('autoNewSessionPoll'), 'reads the poll mode from stats config');
  assert.ok(source.includes('autoNewSessionIntervalSeconds'), 'reads the interval from stats config');
  assert.ok(source.includes('const configure = (body)'), 'configures the timer from the first response');
  assert.ok(source.includes("poll === 'once'"), 'once mode clears the recurring timer');
  assert.ok(source.includes('setInterval(check, seconds * 1000)'), 'interval mode uses the configured seconds');
  assert.ok(source.includes('context.autoNewSessionPoll'), 'settings UI binds the poll select');
  assert.ok(source.includes('context.autoNewSessionIntervalSeconds'), 'settings UI binds the interval slider');
});
