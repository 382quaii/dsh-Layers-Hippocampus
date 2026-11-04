/**
 * v1.5.6 — Orchestrator federation / dedupe wiring (the core call sites).
 *
 * The services live in dsh-orchestrator; the engine now reports business tags to
 * the global federation map and lets the first space own a cross-space monthly memo.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Memory } from '../src/memory.js';
import { ContentRegistry } from '../../dsh-orchestrator/src/dedupe.js';
import { FederationMap } from '../../dsh-orchestrator/src/federation.js';
import { SMALL_POLICY, T0, tempDir } from './helpers.js';

const DAY = 86_400_000;

async function openSpace(spaceId, federation, dedupe) {
  const dir = tempDir(`federation-${spaceId}`);
  const memory = await Memory.open({ dataDir: dir, clock: undefined, policy: SMALL_POLICY, federation, dedupe, spaceId });
  return { memory, dir };
}

test('business tags are federated across spaces; internal status tags are not', async () => {
  const federation = new FederationMap();
  const a = await openSpace('a', federation, null);
  const b = await openSpace('b', federation, null);
  try {
    await a.memory.remember({ content: 'frontend note A', tags: ['domain:frontend', 'status:handoff'], eventTime: T0 });
    await b.memory.remember({ content: 'frontend note B', tags: ['domain:frontend', 'project:other'], eventTime: T0 });
    const view = federation.view();
    const frontend = view.find((node) => node.tag === 'domain:frontend');
    assert.deepEqual(frontend.spaces, ['a', 'b'], 'one global node, both reporting spaces');
    assert.ok(!view.some((node) => node.tag.startsWith('status:')), 'bookkeeping tags are not federated');
    assert.ok(federation.has('project:other'));
    assert.deepEqual(federation.tagsFor('b'), ['domain:frontend', 'project:other']);
  } finally {
    a.memory.close();
    b.memory.close();
  }
});

test('a cross-space monthly memo is claimed once; the sibling space skips its copy', async () => {
  const dedupe = new ContentRegistry();
  const a = await openSpace('a', null, dedupe);
  const b = await openSpace('b', null, dedupe);
  try {
    // Same workload, same completed month (September 2023 with an injected T0 in Nov).
    const eventTime = Date.UTC(2023, 8, 10, 8, 0, 0);
    for (const space of [a, b]) {
      await space.memory.remember({ content: 'September record', tags: ['project:sept'], salience: 0.9, eventTime });
    }
    const first = await a.memory.maintain({ reason: 'federation-test' });
    assert.equal(first.monthly.generated, 1, 'the first space generates the memo');
    assert.equal(first.monthly.skipped, 0);

    const second = await b.memory.maintain({ reason: 'federation-test' });
    assert.equal(second.monthly.generated, 0, 'the sibling space does not duplicate it');
    assert.equal(second.monthly.skipped, 1);
    assert.equal(second.monthly.skippedEntries[0].owner, 'monthly:a');
    assert.equal(dedupe.size, 1);
  } finally {
    a.memory.close();
    b.memory.close();
  }
});
