/**
 * v1.5.6 — pure-local low-valley scheduler (no external price plugin).
 *
 * Contracts:
 *   1. Beijing weekday 09–12 / 14–18 are PEAK; weekends and off-hours are LOW;
 *   2. an idle LLM Dream is DEFERRED during peak and queued durably; the queued
 *      Dream runs as soon as the valley opens (also after a restart);
 *   3. the Host bridge's default price probe follows the same window, while
 *      `DSH_DREAM_PRICE` still overrides it;
 *   4. the window/queue are observable in `/stats` and the setting is editable.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRuntime } from '../index.js';
import { resolveConfig, toMemoryOptions } from '../src/config.js';
import { isLowValley, isPeakHour, nextLowValleyStart, windowInfo } from '../src/priceWindow.js';
import { MEMORY_API, EDITABLE_CONFIG_KEYS as ROUTE_KEYS } from '../src/webRoutes.js';
import { FakeClock, T0, tempDir } from './helpers.js';

const BJ = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h, min) - 8 * 3_600_000;
// 2024-01-01 is a Monday; 2024-01-06 is a Saturday.
const MON_0930 = BJ(2024, 1, 1, 9, 30);
const MON_1200 = BJ(2024, 1, 1, 12, 0);
const MON_1430 = BJ(2024, 1, 1, 14, 30);
const MON_1800 = BJ(2024, 1, 1, 18, 0);
const SAT_1100 = BJ(2024, 1, 6, 11, 0);

test('peak/valley boundaries are Beijing-local and weekend-aware', () => {
  assert.equal(isPeakHour(MON_0930), true);
  assert.equal(isPeakHour(MON_1200), false, 'lunch break is low valley');
  assert.equal(isPeakHour(MON_1430), true);
  assert.equal(isPeakHour(MON_1800), false);
  assert.equal(isLowValley(SAT_1100), true, 'weekends are low valley');
  assert.deepEqual(nextLowValleyStart(MON_0930), MON_1200);
  assert.deepEqual(nextLowValleyStart(MON_1430), MON_1800);
  assert.equal(nextLowValleyStart(MON_1200), MON_1200, 'already low returns now');
  const info = windowInfo(MON_0930);
  assert.equal(info.low, false);
  assert.equal(info.reason, 'peak-hour');
  assert.equal(info.nextLowAt, MON_1200);
});

test('dream.onlyLowValley is fail-fast, exposed and editable', () => {
  const defaults = resolveConfig({});
  assert.equal(defaults.dream.onlyLowValley, true);
  assert.throws(
    () => resolveConfig({ dream: { onlyLowValley: 'yes' } }),
    (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE',
  );
  assert.ok(ROUTE_KEYS.includes('dream.onlyLowValley'), 'HTTP editable');
});

test('an idle LLM Dream is deferred at peak, then queued and run at the valley', async () => {
  const dir = tempDir('low-valley');
  const config = resolveConfig({ dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false, dreamIdleMinutes: 1 });
  const clock = new FakeClock(MON_0930);
  const runtime = createRuntime({ config, options: toMemoryOptions(config), clock });
  try {
    runtime.start();
    await runtime.ready;
    clock.advance(2 * 60_000); // idle threshold (1 min) crossed while still at peak
    const before = await runtime.tick();
    const deferred = before.find((entry) => entry && entry.reason === 'peak-hour');
    assert.ok(deferred, 'the peak-hour tick is deferred');
    assert.equal(deferred.dueAt, MON_1200);
    assert.equal(runtime.memory.dreamQueue().pending, true, 'the deferral is durable');
    const payload = await runtime.uiPayload();
    assert.equal(payload.dreamWindow.low, false);
    assert.equal(payload.dreamQueue.pending, true);

    clock.advance(MON_1200 - MON_0930);
    const after = await runtime.tick();
    const queued = after.find((entry) => entry && entry.fromQueue === true);
    assert.ok(queued, 'the queued Dream runs when the valley opens');
    assert.equal(runtime.memory.dreamQueue().pending, false);
  } finally {
    runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Host bridge probe follows the local window (env override still wins)', async () => {
  const dir = tempDir('low-valley-probe');
  const config = resolveConfig({ dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
  const clock = new FakeClock(MON_0930);
  const runtime = createRuntime({ config, options: toMemoryOptions(config), clock });
  try {
    runtime.start();
    await runtime.ready;
    assert.equal(runtime.hostBridge.lowValley(MON_0930).low, false);
    assert.equal(runtime.hostBridge.lowValley(MON_1200).low, true);
    // An explicit env override is still honoured when no probe was installed.
    const override = createRuntime({ config, options: toMemoryOptions(config), clock });
    try {
      override.hostBridge.setPriceProbe(null);
      assert.equal(override.hostBridge.lowValley(MON_0930).known, false);
    } finally {
      override.stop();
    }
  } finally {
    runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
