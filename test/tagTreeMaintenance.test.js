/**
 * L1.5 tag-tree maintenance integration: rebuild -> carry -> bounded prune ->
 * `state/tag-tree.json`.
 *
 * The clock is injected and nothing sleeps. Every assertion is about the PERSISTED
 * projection (what the Web UI and the recall degradation path will read), not about
 * a private in-memory structure.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig, toMemoryOptions } from '../src/config.js';
import { DAY_MS, T0, makeMemory } from './helpers.js';

function stateDir(dir) {
  return path.join(dir, 'state');
}

function readTree(dir) {
  return JSON.parse(fs.readFileSync(path.join(stateDir(dir), 'tag-tree.json'), 'utf8'));
}

function nodeById(tree, id) {
  return tree.nodes.find((node) => node.id === id) ?? null;
}

/** Purge through the pipeline directly: the tests below are about the tree, not
 * about the pending-delete grace countdown (covered by delete.test.js). */
async function purgeNow(memory, eventIds) {
  return memory.deletePipeline.request({ eventIds, mode: 'purge', reason: 'tag-tree-test' });
}

test('maintain publishes state/tag-tree.json with provenance, nodes and a stable order', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    await memory.remember({ content: 'vue notes', tags: ['tech/frontend/vue3'], salience: 0.5 });
    await memory.remember({ content: 'dsh notes', tags: ['project:dsh'], salience: 0.5 });
    const report = await memory.maintain({ reason: 'baseline' });

    const tree = readTree(memory.dataDir);
    assert.equal(tree.schema, 1);
    assert.equal(tree.sourceIndexGeneration, report.indexGen, 'provenance names the index it was built from');
    assert.equal(tree.sourceIndexGeneration, memory.indexManager.generation);
    assert.equal(tree.generatedAt, T0);

    assert.deepEqual(Object.keys(report.tagTree).sort(), [
      'available', 'generatedAt', 'ghostCount', 'leaves', 'mids', 'nodeCount', 'pendingQueue', 'prune', 'roots',
      'sourceIndexGeneration', 'stale',
    ]);
    assert.equal(report.tagTree.available, true);
    assert.equal(report.tagTree.nodeCount, 4);
    assert.equal(report.tagTree.ghostCount, 0);
    assert.equal(report.tagTree.pendingQueue, 0);
    assert.equal(report.tagTree.stale, false);

    const root = nodeById(tree, 'root:tech');
    assert.equal(root.level, 'root');
    assert.equal(root.flat, false, 'a namespace root is not a flat tag');
    assert.equal(root.childCount, 1);
    assert.equal(root.refCount, 1);

    const mid = nodeById(tree, 'mid:frontend');
    assert.equal(mid.parentId, 'root:tech');
    assert.equal(mid.halfLifeDays, 3, 'mid life comes from config.midHalfLifeMultiplier');
    assert.equal(mid.childCount, 1);

    const leaf = nodeById(tree, 'leaf:vue3');
    assert.equal(leaf.parentId, 'mid:frontend');
    assert.equal(leaf.refCount, 1);

    const flat = nodeById(tree, 'root:project:dsh');
    assert.equal(flat.flat, true, 'a slash-free tag is a protected root');
    assert.equal(flat.childCount, 0);

    assert.deepEqual(tree.ghosts, []);
    assert.deepEqual(tree.pendingQueue, []);
    assert.deepEqual(tree.nodes.map((node) => node.id), tree.nodes.map((node) => node.id).sort(), 'stable order');

    // Atomic write: temp files never survive a completed pass.
    const leftovers = fs.readdirSync(stateDir(memory.dataDir)).filter((name) => name.startsWith('tag-tree.json.tmp-'));
    assert.deepEqual(leftovers, []);

    // The same (index, clock) still produces the same nodes: it is derived state.
    const again = await memory.maintain({ reason: 'again' });
    const second = readTree(memory.dataDir);
    assert.deepEqual(second.nodes, tree.nodes);
    assert.deepEqual(second.ghosts, tree.ghosts);
    assert.equal(again.tagTree.nodeCount, 4);

    // Provenance is how staleness is detected without reading the tree.
    assert.equal(memory.tagTree.status({ indexGeneration: 'gen-999999' }).stale, true);
  } finally {
    cleanup();
  }
});

test('forget cascades across passes: leaf dies, mid ghosts inside grace, mid dies after grace, root stays', async () => {
  const { memory, clock, cleanup } = await makeMemory();
  try {
    const episode = await memory.remember({ content: 'vue notes', tags: ['tech/frontend/vue3'], salience: 0.5 });
    await memory.maintain({ reason: 'baseline' });

    await purgeNow(memory, [episode.eventId]);
    const first = await memory.maintain({ reason: 'after-forget' });
    let tree = readTree(memory.dataDir);

    assert.deepEqual(first.tagTree.prune.removedLeaves, ['leaf:vue3'], 'the dead leaf is pruned in one bounded pass');
    assert.equal(nodeById(tree, 'leaf:vue3'), null);
    const ghostMid = nodeById(tree, 'mid:frontend');
    assert.ok(ghostMid, 'the mid outlives its last leaf');
    assert.equal(ghostMid.graceUntil, T0 + 30 * DAY_MS, 'grace starts when the last child dies');
    assert.equal(ghostMid.refCount, 0);
    assert.equal(tree.ghosts.length, 1);
    assert.deepEqual(
      { id: tree.ghosts[0].id, name: tree.ghosts[0].name, parentId: tree.ghosts[0].parentId },
      { id: 'mid:frontend', name: 'frontend', parentId: 'root:tech' },
      'ghost metadata is what the UI history view needs',
    );
    assert.equal(nodeById(tree, 'root:tech').childCount, 1, 'the root still counts the dying mid');

    clock.advance(10 * DAY_MS);
    await memory.maintain({ reason: 'mid-life' });
    tree = readTree(memory.dataDir);
    assert.ok(nodeById(tree, 'mid:frontend'), 'ten days into a thirty-day grace is still alive');
    assert.ok(Math.abs(nodeById(tree, 'mid:frontend').decayScore - 0.099213) < 1e-6, 'decay is re-derived against now');
    assert.equal(tree.ghosts.length, 1);

    clock.advance(21 * DAY_MS);
    const past = await memory.maintain({ reason: 'past-grace' });
    tree = readTree(memory.dataDir);
    assert.deepEqual(past.tagTree.prune.removedMids, ['mid:frontend'], 'grace expired and decay is far below the floor');
    assert.equal(nodeById(tree, 'mid:frontend'), null);
    assert.equal(tree.ghosts.length, 0);
    assert.ok(nodeById(tree, 'root:tech'), 'the root is immortal');
    assert.equal(nodeById(tree, 'root:tech').childCount, 0, 'truthful child count after the mid is gone');
  } finally {
    cleanup();
  }
});

test('a fresh leaf under a ghost mid revives it and clears the grace window', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const episode = await memory.remember({ content: 'vue notes', tags: ['tech/frontend/vue3'], salience: 0.5 });
    await memory.maintain({ reason: 'baseline' });
    await purgeNow(memory, [episode.eventId]);
    await memory.maintain({ reason: 'ghost' });
    assert.equal(readTree(memory.dataDir).ghosts.length, 1);

    await memory.remember({ content: 'react notes', tags: ['tech/frontend/react'], salience: 0.5 });
    await memory.maintain({ reason: 'revive' });
    const tree = readTree(memory.dataDir);
    const mid = nodeById(tree, 'mid:frontend');
    assert.equal(tree.ghosts.length, 0, 'a mounted leaf revives the mid immediately');
    assert.equal(mid.refCount, 1);
    assert.equal(mid.childCount, 1);
    assert.equal(mid.graceUntil, null);
    assert.equal(nodeById(tree, 'leaf:react').refCount, 1);
    assert.deepEqual(tree.pendingQueue, [], 'the old queue entry does not survive the revival');
  } finally {
    cleanup();
  }
});

test('a storm of dead leaves drains one bounded batch per maintenance run', async () => {
  const { memory, clock, cleanup } = await makeMemory({ config: { tagTree: { pruneBatchSize: 10 } } });
  try {
    const ids = [];
    for (let i = 0; i < 25; i += 1) {
      const saved = await memory.remember({ content: `lib ${i} note`, tags: [`tech/frontend/lib${i}`], salience: 0.5 });
      ids.push(saved.eventId);
    }
    await memory.maintain({ reason: 'baseline' });
    await purgeNow(memory, ids);

    // Each run consumes at most pruneBatchSize entries; the rest stays on disk.
    const passes = [];
    for (let pass = 0; pass < 4; pass += 1) {
      const report = await memory.maintain({ reason: `drain-${pass}` });
      const tree = readTree(memory.dataDir);
      passes.push({
        removed: report.tagTree.prune.removedLeaves.length,
        consumed: report.tagTree.prune.consumed,
        queued: tree.pendingQueue.length,
        leaves: tree.stats.leaves,
      });
    }
    assert.deepEqual(passes.map((entry) => entry.removed), [10, 10, 5, 0]);
    assert.deepEqual(passes.map((entry) => entry.consumed), [10, 10, 5, 0], 'one bounded batch, never a storm');
    assert.deepEqual(passes.map((entry) => entry.queued), [15, 5, 0, 0], 'the queue survives restarts');
    assert.deepEqual(passes.map((entry) => entry.leaves), [15, 5, 0, 0]);

    const tree = readTree(memory.dataDir);
    assert.equal(tree.stats.nodes, 2, 'only the mid and its immortal root remain');
    assert.equal(tree.ghosts.length, 1, 'the mid entered grace when its last leaf died');
    assert.equal(nodeById(tree, 'root:tech').childCount, 1);

    clock.advance(31 * DAY_MS);
    const later = await memory.maintain({ reason: 'grace-over' });
    assert.deepEqual(later.tagTree.prune.removedMids, ['mid:frontend']);
    const after = readTree(memory.dataDir);
    assert.equal(after.ghosts.length, 0);
    assert.ok(nodeById(after, 'root:tech'));
  } finally {
    cleanup();
  }
});

test('a corrupt derived cache is ignored instead of failing maintenance', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    fs.writeFileSync(path.join(stateDir(memory.dataDir), 'tag-tree.json'), 'this is not json{');
    await memory.remember({ content: 'vue notes', tags: ['tech/frontend/vue3'], salience: 0.5 });
    const report = await memory.maintain({ reason: 'recover' });
    assert.equal(report.tagTreeError, undefined);
    assert.equal(report.tagTree.available, true);
    const tree = readTree(memory.dataDir);
    assert.equal(tree.schema, 1);
    assert.ok(nodeById(tree, 'leaf:vue3'), 'the live tree is rebuilt from the index alone');
    assert.deepEqual(tree.ghosts, [], 'no ghost is invented from unreadable state');
  } finally {
    cleanup();
  }
});

test('deleting state/tag-tree.json loses only ghost history, never the live tree', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMP ?? '.', 'tag-tree-cache-'));
  const first = await makeMemory({ dir });
  try {
    const episode = await first.memory.remember({ content: 'vue notes', tags: ['tech/frontend/vue3'], salience: 0.5 });
    await first.memory.maintain({ reason: 'baseline' });
    await purgeNow(first.memory, [episode.eventId]);
    await first.memory.maintain({ reason: 'ghost' });
    assert.equal(readTree(dir).ghosts.length, 1);
  } finally {
    first.memory.close();
  }
  try {
    fs.rmSync(path.join(stateDir(dir), 'tag-tree.json'));
    const second = await makeMemory({ dir });
    try {
      const report = await second.memory.maintain({ reason: 'after-cache-loss' });
      assert.equal(report.tagTreeError, undefined);
      const tree = readTree(dir);
      assert.equal(tree.nodes.length, 0, 'the cache was history: the live index has no events left');
      assert.deepEqual(tree.ghosts, []);

      // Live data still rebuilds the tree on the next pass.
      await second.memory.remember({ content: 'react notes', tags: ['tech/frontend/react'], salience: 0.5 });
      await second.memory.maintain({ reason: 'live-again' });
      const again = readTree(dir);
      assert.ok(nodeById(again, 'root:tech'));
      assert.ok(nodeById(again, 'leaf:react'));
    } finally {
      second.cleanup();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('toMemoryOptions carries the tagTree group into the Memory config', () => {
  const config = resolveConfig({});
  const options = toMemoryOptions(config);
  assert.deepEqual(options.config.tagTree, config.tagTree);
  assert.deepEqual(options.config.tagTree, {
    midHalfLifeMultiplier: 3,
    midGracePeriodDays: 30,
    pruneBatchSize: 100,
    leafDecayFloor: 0,
  });
});

test('tagTreeView feeds the graph history view with ghost metadata only', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const episode = await memory.remember({ content: 'vue notes', tags: ['tech/frontend/vue3'], salience: 0.5 });
    await memory.maintain({ reason: 'baseline' });
    await purgeNow(memory, [episode.eventId]);
    await memory.maintain({ reason: 'ghost' });

    const view = memory.tagTreeView();
    assert.equal(view.available, true);
    assert.equal(view.totalGhosts, 1);
    assert.equal(view.truncated, false);
    assert.equal('nodes' in view, false, 'the route never ships the whole hierarchy');
    assert.deepEqual(
      { id: view.ghosts[0].id, name: view.ghosts[0].name, parentId: view.ghosts[0].parentId },
      { id: 'mid:frontend', name: 'frontend', parentId: 'root:tech' },
      'the UI needs the parent root to hang the ghost under it',
    );
    assert.equal(typeof view.ghosts[0].graceUntil, 'number');
    assert.equal(view.stats.ghosts, 1);

    const capped = memory.tagTreeView({ ghostLimit: 0 });
    assert.deepEqual(capped.ghosts, []);
    assert.equal(capped.truncated, true);
    assert.equal(capped.totalGhosts, 1);
  } finally {
    cleanup();
  }
});
