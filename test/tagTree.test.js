import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rebuildTree, pruneBatch, serializeTree, ghostMids, classifyHit, parseTagPath, DAY_MS,
  mergePreviousTree, queueDeadLeaves,
} from '../src/tagTreeRebuild.js';
import { resolveConfig } from '../src/config.js';

const cfg = { tagTree: { midHalfLifeMultiplier: 3, midGracePeriodDays: 30, pruneBatchSize: 100, leafDecayFloor: 0 } };
const at = 1_700_000_000_000;
const event = (id, tags, t = at) => ({ eventId: id, tags, eventTime: t, salience: 0.8 });

test('flat tags are parsed as roots and NEVER pruned', () => {
  assert.equal(parseTagPath('project:dsh'), null);
  const tree = rebuildTree({ events: [event('e1', ['project:dsh'])], now: at });
  const root = tree.nodes.get('root:project:dsh');
  assert.equal(root.flat, true);
  const queued = [{ id: 'root:project:dsh', queuedBy: 'forget' }];
  const out = pruneBatch(tree, { now: at + 365 * DAY_MS, queue: queued, midGracePeriodDays: 30 });
  assert.equal(out.tree.nodes.has('root:project:dsh'), true, 'flat tag survives a year and a bad queue entry');
  assert.deepEqual(out.removedLeaves, []);
});

test('layered survival: leaf dies, mid ghosts, mid dies after grace, root stays', () => {
  const tree = rebuildTree({ events: [event('e1', ['tech/frontend/vue3'])], now: at });
  const queued = [{ id: 'leaf:vue3', queuedBy: 'forget' }];
  tree.nodes.get('leaf:vue3').refCount = 0;
  tree.nodes.get('mid:frontend').refCount = 0;
  let out = pruneBatch(tree, { now: at, queue: queued, midGracePeriodDays: 30 });
  assert.deepEqual(out.removedLeaves, ['leaf:vue3']);
  const ghost = ghostMids(out.tree, at);
  assert.equal(ghost.length, 1, 'mid is a ghost inside the grace window');
  assert.equal(out.tree.nodes.has('root:tech'), true);
  // 10 days later the mid is still alive (half-life multiplier 3).
  out = pruneBatch(out.tree, { now: at + 10 * DAY_MS, queue: [], midGracePeriodDays: 30 });
  assert.equal(out.tree.nodes.has('mid:frontend'), true);
  // Past the grace deadline AND below the decay floor: the mid dies, the root does not.
  out = pruneBatch(out.tree, { now: at + 400 * DAY_MS, queue: [], midGracePeriodDays: 30 });
  assert.equal(out.tree.nodes.has('mid:frontend'), false);
  assert.equal(out.tree.nodes.has('root:tech'), true, 'root is immortal');
});

test('ghost classification: path-only degrades, direct leaf never does', () => {
  const ghosts = [{ id: 'mid:frontend', name: 'frontend', graceUntil: at + DAY_MS }];
  assert.equal(classifyHit(['tech/frontend'], ghosts), 'path-only');
  assert.equal(classifyHit(['tech/frontend/vue3'], ghosts), 'direct', 'direct leaf hit wins');
  assert.equal(classifyHit(['project:dsh'], ghosts), 'direct', 'flat tag stays direct');
  assert.equal(classifyHit(['tech/frontend/vue3', 'tech/frontend'], ghosts), 'direct');
});

test('derived rebuild is deterministic across replay', () => {
  const events = [event('e1', ['tech/frontend/vue3']), event('e2', ['tech/frontend']), event('e3', ['project:dsh'])];
  const a = rebuildTree({ events, now: at });
  const b = rebuildTree({ events, now: at });
  assert.equal(serializeTree(a), serializeTree(b), 'same input -> same tree');
  assert.equal(serializeTree(rebuildTree({ events: [...events].reverse(), now: at })), serializeTree(a), 'order independent');
});

test('batch pruning: 20 queued leaves drain in one bounded pass', () => {
  const events = [];
  for (let i = 0; i < 20; i += 1) events.push(event('e' + i, ['tech/frontend/lib' + i]));
  const tree = rebuildTree({ events, now: at });
  const queue = [...tree.nodes.keys()].filter((id) => id.startsWith('leaf:')).map((id) => ({ id, queuedBy: 'forget' }));
  for (const id of queue) tree.nodes.get(id.id).refCount = 0;
  const out = pruneBatch(tree, { now: at, queue, batchSize: 100 });
  assert.equal(out.removedLeaves.length, 20);
  assert.equal(out.remaining, 0);
});

test('tagTree config: defaults + fail-fast ranges', () => {
  const config = resolveConfig({});
  assert.equal(config.tagTree.midHalfLifeMultiplier, 3);
  assert.equal(config.tagTree.pruneBatchSize, 100);
  assert.equal(config.tagTree.leafDecayFloor, 0);
  assert.throws(() => resolveConfig({ tagTree: { midGracePeriodDays: 5 } }), (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE');
  assert.throws(() => resolveConfig({ tagTree: { pruneBatchSize: 5 } }), (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE');
  assert.throws(() => resolveConfig({ tagTree: { leafDecayFloor: 2 } }), (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE');
});

test('release-queued leaves die even when leafDecayFloor is 0', () => {
  const tree = rebuildTree({ events: [event('e1', ['tech/frontend/vue3'])], now: at });
  // Releasing the only reference zeroes the whole path, not just the leaf.
  tree.nodes.get('leaf:vue3').refCount = 0;
  tree.nodes.get('mid:frontend').refCount = 0;
  const out = pruneBatch(tree, { now: at, queue: [{ id: 'leaf:vue3', queuedBy: 'release' }] });
  assert.deepEqual(out.removedLeaves, ['leaf:vue3']);
  assert.equal(out.tree.nodes.get('mid:frontend').graceUntil, at + 30 * DAY_MS);
});

test('carry forward keeps a vanished leaf dead, and pruning starts the mid grace', () => {
  const previous = rebuildTree({
    events: [event('e1', ['tech/frontend/vue3']), event('e2', ['project:dsh'])],
    now: at,
  });
  const live = rebuildTree({ events: [], now: at + DAY_MS });
  const { carried } = mergePreviousTree(live, previous, { now: at + DAY_MS, midGracePeriodDays: 30 });

  assert.ok(carried.includes('leaf:vue3'));
  assert.equal(live.nodes.get('leaf:vue3').refCount, 0, 'history is kept, references are not');
  assert.equal(live.nodes.get('root:project:dsh').flat, true, 'flat roots survive through the carry');
  assert.equal(live.nodes.get('mid:frontend').graceUntil, null, 'the mid still has a child of record');

  const queue = queueDeadLeaves(live, { now: at + DAY_MS });
  assert.deepEqual(queue.map((item) => item.id), ['leaf:vue3']);
  assert.equal(queue[0].queuedBy, 'release');

  const out = pruneBatch(live, { now: at + DAY_MS, queue, midGracePeriodDays: 30 });
  assert.deepEqual(out.removedLeaves, ['leaf:vue3']);
  assert.equal(out.tree.nodes.get('mid:frontend').graceUntil, at + 31 * DAY_MS);
  assert.equal(out.tree.nodes.get('root:tech').childCount, 1);
});

test('carry forward drops an orphan instead of faking a root', () => {
  const previous = rebuildTree({ events: [event('e1', ['tech/frontend/vue3'])], now: at });
  previous.nodes.delete('mid:frontend'); // corrupted cache: the child now points at nothing
  const live = rebuildTree({ events: [], now: at });
  const { carried } = mergePreviousTree(live, previous, { now: at });
  assert.equal(live.nodes.has('leaf:vue3'), false);
  assert.ok(!carried.includes('leaf:vue3'));
  assert.equal(live.nodes.has('root:tech'), true, 'the root is immortal');
  assert.equal(live.nodes.get('root:tech').childCount, 0);
});

test('mid half-life comes from config.midHalfLifeMultiplier, never hard-coded', () => {
  const events = [event('e1', ['tech/frontend/vue3'])];
  assert.equal(rebuildTree({ events, now: at }).nodes.get('mid:frontend').halfLifeDays, 3, 'documented default');
  const custom = rebuildTree({ events, now: at, config: { midHalfLifeMultiplier: 2 } });
  assert.equal(custom.nodes.get('mid:frontend').halfLifeDays, 2);
});

test('only true flat tags get flat roots; a hierarchy root is not flat', () => {
  const tree = rebuildTree({
    events: [event('e1', ['tech/frontend/vue3']), event('e2', ['project:dsh'])],
    now: at,
  });
  assert.equal(tree.nodes.get('root:project:dsh').flat, true, 'no slash -> flat tag');
  assert.equal(tree.nodes.get('root:tech').flat, false, 'a namespace root is not a flat tag');
});