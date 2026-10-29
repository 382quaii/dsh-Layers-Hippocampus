/**
 * Scheduler discipline: never concurrent, never backfilled, failures visible.
 *
 * All ticks are driven with an injected clock and an explicit `now`, so no test
 * waits on a real timer.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CronScheduler } from '../src/scheduler.js';
import { matchesCron, nextRun, parseCron } from '../src/cron.js';
import { FakeClock, T0 } from './helpers.js';

const MINUTE = 60_000;

function schedulerWith(run, { clock = new FakeClock(T0), cron = '* * * * *' } = {}) {
  return new CronScheduler({ clock, getCronExpression: () => cron, run });
}

test('a tick while maintenance is in flight is skipped and counted', async () => {
  const clock = new FakeClock(T0);
  let release;
  let started = 0;
  let block = true;
  const scheduler = schedulerWith(
    () => {
      started += 1;
      if (!block) return Promise.resolve();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    { clock },
  );

  const first = scheduler.tick({ now: T0 });
  const second = await scheduler.tick({ now: T0 + MINUTE });
  assert.equal(second.ran, false);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'maintenance-in-flight');
  assert.equal(started, 1, 'the second tick never started a second run');
  assert.equal(scheduler.skipped, 1);

  release();
  const result = await first;
  assert.equal(result.ran, true);
  assert.equal(scheduler.runs, 1);
  assert.equal(scheduler.running, false);

  // Once the first run finished, the next due minute runs again.
  block = false;
  const third = await scheduler.tick({ now: T0 + 2 * MINUTE });
  assert.equal(third.ran, true);
  assert.equal(started, 2);
});

test('a tick outside the cron expression does nothing', async () => {
  const clock = new FakeClock(T0);
  const scheduler = schedulerWith(async () => {}, { clock, cron: '0 * * * *' });
  const result = await scheduler.tick({ now: T0 + 30 * MINUTE });
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'not-due');
  assert.equal(scheduler.runs, 0);
});

test('a missed window is not backfilled: only the matching minute fires', async () => {
  const clock = new FakeClock(T0);
  let runs = 0;
  const scheduler = schedulerWith(async () => {
    runs += 1;
  }, { clock, cron: '0 */6 * * *' });

  // Simulate a process that was down for 7 hours: tick once, at a non-matching moment.
  const result = await scheduler.tick({ now: T0 + 7 * 60 * MINUTE + 13 * MINUTE });
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'not-due');
  assert.equal(runs, 0, 'missed windows are skipped, never replayed');
  assert.equal(scheduler.lastSuccessAt, null);
});

test('a failing run is recorded and does not stop the scheduler', async () => {
  const clock = new FakeClock(T0);
  let attempt = 0;
  const scheduler = schedulerWith(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('boom');
  }, { clock });

  const failed = await scheduler.tick({ now: T0 });
  assert.equal(failed.ran, false);
  assert.equal(failed.reason, 'failed');
  assert.equal(scheduler.lastError.message, 'boom');
  assert.equal(scheduler.lastSuccessAt, null, 'a failed run is not a success time');

  const recovered = await scheduler.tick({ now: T0 + MINUTE });
  assert.equal(recovered.ran, true);
  assert.equal(scheduler.lastError, null);
  assert.equal(scheduler.lastSuccessAt, clock.now());
});

test('status exposes cron, next run, counters and the last success time', async () => {
  const clock = new FakeClock(T0);
  const scheduler = schedulerWith(async () => {}, { clock, cron: '* * * * *' });
  await scheduler.tick({ now: T0 });
  const status = scheduler.status(T0);
  assert.equal(status.cron, '* * * * *');
  assert.equal(typeof status.nextRunAt, 'number');
  assert.ok(status.nextRunAt > T0);
  assert.equal(status.ticks, 1);
  assert.equal(status.runs, 1);
  assert.equal(status.running, false);
  assert.equal(status.cronError, null);
});

test('nextRunAt is computed from the configured expression', () => {
  const scheduler = schedulerWith(async () => {}, { clock: new FakeClock(T0), cron: '0 */6 * * *' });
  const next = scheduler.nextRunAt(T0);
  assert.equal(matchesCron(parseCron('0 */6 * * *'), next), true, 'the reported time matches the expression');
  assert.equal(next, nextRun(parseCron('0 */6 * * *'), T0), 'and it is the first such time after now');
});

test('an invalid cron is reported in status instead of crashing ticks', async () => {
  const clock = new FakeClock(T0);
  const scheduler = schedulerWith(async () => {}, { clock, cron: 'nonsense' });
  const status = scheduler.status(T0);
  assert.equal(status.nextRunAt, null);
  assert.equal(status.cronError.code, 'MEM_E_CONFIG_INVALID_CRON');

  const tick = await scheduler.tick({ now: T0 });
  assert.equal(tick.reason, 'invalid-cron');
  assert.equal(scheduler.lastError.code, 'MEM_E_CONFIG_INVALID_CRON');
});
