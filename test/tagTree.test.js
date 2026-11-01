import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rebuildTree, pruneBatch, serializeTree, ghostMids, classifyHit, parseTagPath, DAY_MS,
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