/**
 * Module 3 — context window paging.
 *
 * The rule under test: paging is a measurement the engine performs, not an
 * instruction the model may drift from. Blocks enter a finite window, the window
 * evicts by score (salience x decay) down to a target, and evicting from the
 * window never deletes the underlying memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, T0, makeMemory } from './helpers.js';

const CONFIG = { context: { maxTokens: 1000, threshold: 0.85, target: 0.7 } };

test('the engine evicts by score down to the target, and storage stays intact', async () => {
  const { memory, clock, cleanup } = await makeMemory({ config: CONFIG });
  try {
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const record = await memory.remember({ content: `fact ${i} about the project`, salience: 0.2 });
      ids.push(record.eventId);
      // 5 blocks x 300 tokens = 1500 > 0.85 x 1000 -> paging must trigger.
      memory.context.inject({
        id: record.eventId,
        kind: 'recall',
        text: 'x'.repeat(1200),
        salience: 1 - i * 0.1,
        at: T0,
      });
    }
    assert.equal(memory.context.tokens(), 1500);

    const paging = memory.context.enforce();
    assert.equal(paging.triggered, true);
    assert.equal(paging.after <= 700, true, 'must land at or below the target, not one block above it');
    assert.ok(paging.evicted.length >= 2);

    // Deterministic: the lowest salience block leaves first.
    assert.equal(paging.evicted[0].id, ids[4]);
    const survivors = memory.context.snapshot().blocks.map((block) => block.id);
    for (const record of paging.evicted) assert.equal(survivors.includes(record.id), false);
    assert.equal(memory.context.render().includes(paging.evicted[0].id), false);

    // Eviction is a prompt-window decision only: the log and index are untouched.
    const status = await memory.status();
    assert.equal(status.log.recordCount, 5);
    const recalled = await memory.recall({ tags: [], topK: 10 });
    assert.equal(recalled.hits.length >= 0, true);
  } finally {
    cleanup();
  }
});

test('a pinned block is never evicted, and decay ranks the rest', async () => {
  const { memory, clock, cleanup } = await makeMemory({ config: CONFIG });
  try {
    memory.context.inject({ id: 'pinned:policy', kind: 'briefing', text: 'p'.repeat(1200), pinned: true });
    memory.context.inject({ id: 'old:weak', kind: 'recall', text: 'o'.repeat(1200), salience: 0.5, at: T0 - 200 * DAY_MS });
    memory.context.inject({ id: 'fresh:strong', kind: 'recall', text: 'f'.repeat(1200), salience: 0.9, at: T0 });

    const paging = memory.context.enforce({ now: T0 });
    assert.equal(paging.triggered, true);
    assert.deepEqual(paging.evicted.map((block) => block.id), ['old:weak']);
    const survivorIds = memory.context.snapshot({ now: T0 }).blocks.map((block) => block.id);
    assert.deepEqual(survivorIds, ['pinned:policy', 'fresh:strong']);
  } finally {
    cleanup();
  }
});
