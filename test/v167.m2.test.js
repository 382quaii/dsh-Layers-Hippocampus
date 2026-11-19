/**
 * v1.6.7 — M2: optional external seams.
 *
 * The architecture note says this engine should DELEGATE price / peak / notification
 * duties to sibling plugins (`dsh-price-tip`, `dsh-peak-runner`, `dsh-notify-plugin`).
 * None of them exists on this machine, so the honest implementation is:
 *
 *   - probe a small set of CONVENTIONAL service keys,
 *   - accept several plausible method shapes,
 *   - fall back to local behaviour (or a recorded no-op) when nothing answers,
 *   - and REPORT which seam answered, so "not installed" is visible rather than
 *     silently pretending everything is wired.
 *
 * What must never happen: inventing a channel, throwing because a plugin is missing,
 * or claiming `wired: true` when nothing is there.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { HostBridge } from '../src/hostBridge.js';
import { apply, getRuntime } from '../index.js';
import { fakeCtx, tempDir } from './helpers.js';

const bridge = (overrides = {}) => {
  const clock = { now: 1_700_000_000_000 };
  return new HostBridge({ clock: () => clock.now, env: {}, ...overrides });
};

test('a bridge without a notifier records a no-op instead of throwing', () => {
  const subject = bridge();
  assert.equal(subject.notifierAttached, false);
  const outcome = subject.notify({ title: 't', text: 'x' });
  assert.deepEqual(outcome, { delivered: false, reason: 'no-notifier' });
  assert.equal(subject.stats.notifications, 0);
  assert.equal(subject.stats.notifySkipped, 1);
  assert.equal(subject.stats.lastNotifySkipReason, 'no-notifier');
  // And the panel-facing status says so.
  assert.equal(subject.status().notifierAttached, false);
});

test('an injected notifier receives the payload and is counted', () => {
  const seen = [];
  const subject = bridge();
  subject.setNotifier((payload) => {
    seen.push(payload);
    return 'ok';
  });
  assert.equal(subject.notifierAttached, true);
  const outcome = subject.notify({ title: '海马体', text: '推迟到谷时', kind: 'dream-deferred' });
  assert.equal(outcome.delivered, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].title, '海马体');
  assert.equal(seen[0].kind, 'dream-deferred');
  assert.equal(seen[0].at, 1_700_000_000_000, 'the bridge stamps its own clock');
  assert.equal(subject.stats.notifications, 1);
  assert.equal(subject.status().notifierAttached, true);
});

test('a throwing notifier is caught, counted, and never propagates', () => {
  const subject = bridge();
  subject.setNotifier(() => {
    throw new Error('sink exploded');
  });
  const outcome = subject.notify({ title: 't', text: 'x' });
  assert.deepEqual(outcome, { delivered: false, reason: 'sink-error' });
  assert.equal(subject.stats.notifications, 0);
  assert.equal(subject.stats.lastNotifySkipReason, 'sink-error');
  // Clearing the sink restores the no-op path (no sticky broken state).
  subject.setNotifier(null);
  assert.equal(subject.notify({ title: 't', text: 'x' }).reason, 'no-notifier');
});

test('the plugin reports which external seams answered (all absent here)', async () => {
  const dir = tempDir('m2-seams');
  const fixture = fakeCtx();
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    const seams = runtime.externalSeams();
    // Nothing is installed in the test host: notifier and peak are absent, and price
    // falls back to the built-in clock window (which is still a real, working probe).
    assert.equal(seams.notifier.wired, false);
    assert.equal(seams.notifier.source, null);
    assert.equal(seams.peak.wired, false);
    assert.equal(seams.price.wired, true);
    assert.equal(seams.price.source, 'local-window');
    const payload = await runtime.uiPayload();
    assert.deepEqual(payload.capabilities.externalSeams, seams);
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an injected notify service is discovered and used for a deferred dream', async () => {
  const dir = tempDir('m2-notifier');
  const fixture = fakeCtx();
  const seen = [];
  // A `dsh-notify-plugin`-style service: any object with notify/send/post.
  fixture.services.set('notifier', { notify: (payload) => seen.push(payload) });
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    const seams = runtime.externalSeams();
    assert.equal(seams.notifier.wired, true);
    assert.equal(seams.notifier.source, 'notifier');
    // The sink is reached through the bridge, not through a private field.
    const direct = runtime.hostBridge.notify({ title: 'probe', text: 'ping' });
    assert.equal(direct.delivered, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].title, 'probe');
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a price tip service takes precedence over the local clock window', async () => {
  const dir = tempDir('m2-price');
  const fixture = fakeCtx();
  // Always "high price": the external tip service must win over the local window.
  fixture.services.set('priceTip', { isLowValley: () => false });
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    const seams = runtime.externalSeams();
    assert.equal(seams.price.wired, true);
    assert.equal(seams.price.source, 'priceTip');
    const verdict = runtime.hostBridge.lowValley(runtime.memory.clock.now());
    assert.deepEqual(verdict, { known: true, low: false });
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
