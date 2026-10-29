/**
 * Cron parsing / matching / next-run.
 *
 * Dates are built with the LOCAL Date constructor on purpose: cron fields are
 * interpreted in the server's local time zone, so a test written against UTC would
 * pass in UTC and fail in Asia/Shanghai.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesCron, nextRun, parseCron } from '../src/cron.js';

/** Local wall-clock timestamp. */
function at(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function codeOf(fn) {
  let code = null;
  assert.throws(fn, (error) => {
    code = error.code;
    return true;
  });
  return code;
}

test('a 5-field expression expands to sorted field sets', () => {
  const spec = parseCron('0 */6 * * *');
  assert.deepEqual([...spec.minute].sort((a, b) => a - b), [0]);
  assert.deepEqual([...spec.hour].sort((a, b) => a - b), [0, 6, 12, 18]);
  assert.equal(spec.expression, '0 */6 * * *');
});

test('matching is minute-granular and respects the hour set', () => {
  const spec = parseCron('0 */6 * * *');
  assert.equal(matchesCron(spec, at(2026, 1, 15, 12, 0)), true);
  assert.equal(matchesCron(spec, at(2026, 1, 15, 12, 1)), false);
  assert.equal(matchesCron(spec, at(2026, 1, 15, 13, 0)), false);
});

test('nextRun finds the next matching minute and wraps across days', () => {
  const spec = parseCron('0 */6 * * *');
  assert.equal(nextRun(spec, at(2026, 1, 15, 12, 5)), at(2026, 1, 15, 18, 0));
  assert.equal(nextRun(spec, at(2026, 1, 15, 18, 1)), at(2026, 1, 16, 0, 0));
  // Strictly after `from`: a run already at a boundary must not repeat.
  assert.equal(nextRun(spec, at(2026, 1, 15, 18, 0)), at(2026, 1, 16, 0, 0));
});

test('day-of-month and day-of-week are OR-ed, not AND-ed', () => {
  const spec = parseCron('0 0 13 * 5');
  assert.equal(matchesCron(spec, at(2026, 1, 13, 0, 0)), true, 'the 13th matches even though it is a Tuesday');
  assert.equal(matchesCron(spec, at(2026, 1, 9, 0, 0)), true, 'a Friday matches even though it is not the 13th');
  assert.equal(matchesCron(spec, at(2026, 1, 14, 0, 0)), false, 'Wednesday the 14th matches neither branch');
});

test('lists, ranges and steps are supported', () => {
  const spec = parseCron('5,35 9-17/2 * * 1-5');
  assert.deepEqual([...spec.minute].sort((a, b) => a - b), [5, 35]);
  assert.deepEqual([...spec.hour].sort((a, b) => a - b), [9, 11, 13, 15, 17]);
  assert.deepEqual([...spec.dayOfWeek].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(matchesCron(spec, at(2026, 1, 14, 11, 35)), true);
});

test('invalid expressions fail with CONFIG_INVALID_CRON instead of guessing', () => {
  assert.equal(codeOf(() => parseCron('* * * *')), 'MEM_E_CONFIG_INVALID_CRON');
  assert.equal(codeOf(() => parseCron('0 0 0 * * *')), 'MEM_E_CONFIG_INVALID_CRON');
  assert.equal(codeOf(() => parseCron('60 * * * *')), 'MEM_E_CONFIG_INVALID_CRON');
  assert.equal(codeOf(() => parseCron('*/0 * * * *')), 'MEM_E_CONFIG_INVALID_CRON');
  assert.equal(codeOf(() => parseCron('5, * * * *')), 'MEM_E_CONFIG_INVALID_CRON');
  assert.equal(codeOf(() => parseCron('5-1 * * * *')), 'MEM_E_CONFIG_INVALID_CRON');
});

test('nextRun advances strictly and is stable (pure function of the inputs)', () => {
  const spec = parseCron('*/15 8-20 * * *');
  const start = at(2026, 3, 1, 8, 7);
  const first = nextRun(spec, start);
  const second = nextRun(spec, first);
  assert.ok(first > start);
  assert.ok(second > first);
  assert.equal(nextRun(spec, start), first, 'no hidden state between calls');
});
