/**
 * v1.5.6 — low-valley Phase 2: wake timer + late-wake (sleep) correction.
 *
 * The timer never trusts the instant it was scheduled for: on fire it re-reads the
 * clock and the window. Woke during a valley -> run the queued Dream (reporting how
 * late it was); woke during a peak -> re-arm instead of spending. Timers are injected,
 * so no test waits on real time.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRuntime } from '../index.js';
import { resolveConfig, toMemoryOptions } from '../src/config.js';
import { DreamTimer, DEFAULT_WAKE_MARGIN_MS } from '../src/dreamTimer.js';
import { FakeClock, tempDir } from './helpers.js';

const BJ = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h, min) - 8 * 3_600_000;
const MON_0930 = BJ(2024, 1, 1, 9, 30);
const MON_1200 = BJ(2024, 1, 1, 12, 0);
const MON_1300 = BJ(2024, 1, 1, 13, 0);
const MON_1430 = BJ(2024, 1, 1, 14, 30);
const MON_1800 = BJ(2024, 1, 1, 18, 0);

function fakeTimers() {
  const handles = [];
  return {
    handles,
    setTimer(cb, delay) {
      const handle = { id: handles.length + 1, cb, delay, cleared: false };
      handles.push(handle);
      return handle;
    },
    clearTimer(handle) {
      if (handle) handle.cleared = true;
    },
    fire(handle) {
      assert.ok(handle && !handle.cleared, 'firing a live timer');
      handle.cb();
    },
    last() {
      return handles[handles.length - 1];
    },
  };
}

test('a peak wake re-arms for the next valley instead of running', async () => {
  const clock = new FakeClock(MON_0930);
  const timers = fakeTimers();
  let calls = 0;
  const timer = new DreamTimer({
    clock: () => clock.now(),
    getQueue: () => ({ pending: true, dueAt: MON_1200 }),
    isLow: (now) => now >= MON_1200 && now < MON_1430,
    nextLow: () => MON_1200,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onDue: async () => {
      calls += 1;
    },
  });
  const armed = timer.schedule();
  assert.equal(armed.armed, true);
  assert.equal(armed.at, MON_1200, 'waits for the valley boundary');
  assert.equal(armed.delay, MON_1200 - MON_0930);

  // The timer fires early (or the OS slept only a little): still peak -> re-arm.
  clock.advance(60 * 60_000); // 10:30, still peak
  await timers.last().cb();
  assert.equal(calls, 0);
  assert.equal(timer.status().reschedules, 1);

  clock.advance(MON_1200 - clock.now()); // 12:00, valley
  await timers.last().cb();
  assert.equal(calls, 1, 'runs once the valley is open');
  assert.equal(timer.status().wakes, 1);
});

test('a sleep-delayed wake is detected and reported as a catch-up', async () => {
  const clock = new FakeClock(MON_0930);
  const timers = fakeTimers();
  const seen = [];
  const timer = new DreamTimer({
    clock: () => clock.now(),
    getQueue: () => ({ pending: true, dueAt: MON_1200 }),
    isLow: (now) => now >= MON_1200,
    nextLow: () => MON_1200,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    wakeMarginMs: DEFAULT_WAKE_MARGIN_MS,
    onDue: async (info) => seen.push(info),
  });
  timer.schedule();
  // The machine slept until 13:00: the timer fires an hour late, still in the valley.
  clock.advance(MON_1300 - MON_0930);
  await timers.last().cb();
  assert.equal(seen.length, 1);
  assert.ok(seen[0].lateMs >= 60 * 60_000, 'lateMs reflects real elapsed time');
  assert.equal(seen[0].catchUp, true);
  assert.equal(timer.status().lateWakes, 1);
});

test('a queue due in the past while already in the valley arms delay 0 (boot catch-up)', async () => {
  const clock = new FakeClock(MON_1300);
  const timers = fakeTimers();
  let ran = 0;
  const timer = new DreamTimer({
    clock: () => clock.now(),
    getQueue: () => ({ pending: true, dueAt: MON_1200 }),
    isLow: () => true,
    nextLow: () => MON_1200,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onDue: async () => {
      ran += 1;
    },
  });
  const armed = timer.schedule();
  assert.equal(armed.delay, 0, 'catch-up wakes immediately');
  await timers.last().cb();
  assert.equal(ran, 1);
});

test('runtime: a deferred peak Dream is woken by the timer at the valley', async () => {
  const dir = tempDir('low-valley-2');
  const config = resolveConfig({ dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false, dreamIdleMinutes: 1 });
  const clock = new FakeClock(MON_0930);
  const timers = fakeTimers();
  const runtime = createRuntime({ config, options: toMemoryOptions(config), clock, timers });
  try {
    runtime.start();
    await runtime.ready;
    clock.advance(2 * 60_000);
    const deferred = await runtime.tick();
    assert.ok(deferred.some((entry) => entry?.reason === 'peak-hour'));
    assert.equal(runtime.memory.dreamQueue().pending, true);
    assert.equal(runtime.dreamTimer.status().armed, true);

    clock.advance(MON_1200 - clock.now());
    await runtime.dreamTimer._fire();
    assert.equal(runtime.memory.dreamQueue().pending, false);
    assert.equal(runtime.dreamTimer.status().runs, 1);
    const payload = await runtime.uiPayload();
    assert.equal(payload.dreamTimer.runs, 1);
  } finally {
    runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
