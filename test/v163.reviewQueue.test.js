/**
 * v1.6.3: maintenance must CONSUME the due review queue, not just report it.
 *
 * Reported symptom (live panel on a real profile): `reviews.total = 346`,
 * `reviews.due = 337`, and every entry had `lastAt: null` — the spaced-repetition
 * table had never advanced since installation. `tick()` was only ever REPORTED in
 * `maintain()`, so the "due" list was write-only: it grew monotonically and recall
 * never received a reinforcement anchor.
 *
 * Contract locked here:
 *   - a due row is consumed exactly once per maintenance pass;
 *   - the advance is BATCHED (`consumeBatchSize`) and BOUNDED (`consumeMaxPerRun`),
 *     so a 337-row backlog drains over a few passes instead of blocking one;
 *   - the reinforcement log grows by the consumed count (that IS the anchor);
 *   - `autoConsume: false` leaves the queue untouched (operator opt-out);
 *   - the schedule file is written once per batch, not once per row.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeMemory } from './helpers.js';

const DAY = 86_400_000;

/** Absolute path of a file under the fixture's `state/` directory. */
function statePath(dir, name) {
  return path.join(dir, 'state', name);
}

async function seedDueRows(memory, count) {
  // salience >= REVIEW_MIN_SALIENCE (0.5) and not `status:monthly` => gets a review
  // row at step 0 with dueAt = now + intervals[0] days.
  for (let index = 0; index < count; index += 1) {
    await memory.remember({
      content: `review seed ${index}`,
      tags: [`topic:seed-${index % 3}`],
      salience: 0.8,
      eventTime: memory.clock.now() - index,
    });
  }
}

test('maintenance consumes due review rows and advances the schedule', async () => {
  const fixture = await makeMemory({ config: { review: { consumeBatchSize: 10 } } });
  try {
    const { memory, clock } = fixture;
    await seedDueRows(memory, 12);
    await memory.maintain({ reason: 'seed' });
    // Step 0 rows are due after one interval day.
    clock.advance(2 * DAY);

    const report = await memory.maintain({ reason: 'review-consume' });
    assert.ok(report.reviewConsume, 'the pass must report reviewConsume');
    assert.equal(report.reviewConsume.enabled, true);
    assert.ok(report.reviewConsume.consumed >= 12, `consumed ${report.reviewConsume.consumed} of 12 due rows`);
    assert.equal(report.reviewConsume.batches, Math.ceil(report.reviewConsume.consumed / 10));

    const status = memory.reviews.status({ now: clock.now() });
    assert.equal(status.due, 0, 'nothing may remain due right after consumption');
    const advanced = status.items.filter((item) => item.lastAt !== null);
    assert.ok(advanced.length >= 12, 'every consumed row records lastAt');
    for (const item of advanced) assert.ok(item.step >= 1, 'step advances on consumption');
  } finally {
    fixture.cleanup();
  }
});

test('the reinforcement log grows by exactly the consumed count', async () => {
  const fixture = await makeMemory({ config: { review: { consumeBatchSize: 50 } } });
  try {
    const { memory, clock } = fixture;
    await seedDueRows(memory, 5);
    await memory.maintain({ reason: 'seed' });
    clock.advance(2 * DAY);
    const before = memory.indexManager.snapshot().stats.reinforcements ?? 0;
    const report = await memory.maintain({ reason: 'review-consume' });
    const after = memory.indexManager.snapshot().stats.reinforcements ?? 0;
    assert.equal(after - before, report.reviewConsume.consumed, 'one reinforcement record per consumed row');
    const events = memory.indexManager.snapshot().events;
    assert.ok(
      events.some((event) => (event.reinforcementCount ?? 0) > 0),
      'recall-visible reinforcementCount must be non-zero after review consumption',
    );
  } finally {
    fixture.cleanup();
  }
});

test('a backlog larger than the per-run budget drains over several passes', async () => {
  const fixture = await makeMemory({ config: { review: { consumeBatchSize: 5, consumeMaxPerRun: 6 } } });
  try {
    const { memory, clock } = fixture;
    await seedDueRows(memory, 20);
    await memory.maintain({ reason: 'seed' });
    clock.advance(2 * DAY);

    const first = await memory.maintain({ reason: 'batch-1' });
    assert.equal(first.reviewConsume.consumed, 6, 'budget caps the first pass');
    assert.ok(first.reviewConsume.remaining > 0, 'remaining rows are reported, not silently dropped');
    assert.equal(memory.reviews.status({ now: clock.now() }).due, first.reviewConsume.remaining);

    const second = await memory.maintain({ reason: 'batch-2' });
    assert.ok(second.reviewConsume.consumed > 0, 'the next pass keeps draining');
    let passes = 2;
    while (memory.reviews.status({ now: clock.now() }).due > 0 && passes < 10) {
      // Bounded loop: 20 rows at 6/pass needs 4 passes; the guard turns a
      // starvation regression into a clear failure instead of a hang.
      const next = await memory.maintain({ reason: `batch-${passes + 1}` });
      assert.ok(next.reviewConsume.consumed > 0, 'every pass must make progress');
      passes += 1;
    }
    assert.equal(memory.reviews.status({ now: clock.now() }).due, 0, 'the queue eventually empties');
    assert.ok(passes >= 4, 'a 20-row backlog at 6/pass cannot drain in fewer than 4 passes');
  } finally {
    fixture.cleanup();
  }
});

test('autoConsume:false leaves the queue untouched', async () => {
  const fixture = await makeMemory({ config: { review: { autoConsume: false } } });
  try {
    const { memory, clock } = fixture;
    await seedDueRows(memory, 4);
    await memory.maintain({ reason: 'seed' });
    clock.advance(2 * DAY);
    const report = await memory.maintain({ reason: 'manual-only' });
    assert.equal(report.reviewConsume.enabled, false);
    assert.equal(report.reviewConsume.reason, 'auto-consume-disabled');
    const status = memory.reviews.status({ now: clock.now() });
    assert.equal(status.due, 4, 'opt-out means the due rows are still due');
    assert.ok(status.items.every((item) => item.lastAt === null));
  } finally {
    fixture.cleanup();
  }
});

test('the schedule file is written once per batch, not once per row', async () => {
  const fixture = await makeMemory({ config: { review: { consumeBatchSize: 40 } } });
  try {
    const { memory, clock } = fixture;
    await seedDueRows(memory, 10);
    await memory.maintain({ reason: 'seed' });
    clock.advance(2 * DAY);
    const file = statePath(fixture.dir, 'reviews.json');
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    const report = await memory.maintain({ reason: 'review-consume' });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    // One atomic write per batch => ONE updatedAt bump for a single 10-row chunk.
    assert.equal(report.reviewConsume.batches, 1);
    assert.ok(after.updatedAt >= before.updatedAt);
    assert.equal(
      Object.values(after.items).filter((item) => item.lastAt !== null).length,
      report.reviewConsume.consumed,
    );
  } finally {
    fixture.cleanup();
  }
});
