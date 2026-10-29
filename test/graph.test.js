/**
 * Offline knowledge graph: per-node Top-N, global weight order, 2000 cap, and a
 * read path that only slices.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildGraph, GraphCache, GRAPH_HARD_CAP } from '../src/graph.js';
import { FakeClock, T0, tempDir } from './helpers.js';

function events(pairs) {
  return pairs.map((tags, i) => ({
    eventId: `e${i}`,
    salience: 0.8,
    tags: tags.map((tag) => ({ tag, strength: 1 })),
  }));
}

test('edges are co-occurrence, nodes keep their mass', () => {
  const graph = buildGraph(events([['a', 'b'], ['a', 'c'], ['b', 'c']]), { now: T0 });
  assert.equal(graph.edges.length, 3);
  assert.deepEqual(graph.edges.map((edge) => `${edge.source}-${edge.target}`).sort(), ['a-b', 'a-c', 'b-c']);
  assert.equal(graph.nodes.find((node) => node.id === 'a').events, 2);
  assert.equal(graph.truncated, false);
});

test('a hub cannot swallow the map: each node keeps only Top-N neighbours', () => {
  // "hub" co-occurs with 12 leaves; every leaf only ever meets "hub".
  const rows = [];
  for (let i = 0; i < 12; i += 1) rows.push(['hub', `leaf${i}`]);
  const graph = buildGraph(events(rows), { topNeighbors: 5, now: T0 });
  const hubEdges = graph.edges.filter((edge) => edge.source === 'hub' || edge.target === 'hub');
  assert.equal(hubEdges.length, 5, 'hub keeps Top-5, not 12');
  assert.equal(graph.edges.length, 5);
});

test('the cache is capped at the hard limit and stays weight-ordered', () => {
  const rows = [];
  for (let i = 0; i < 40; i += 1) {
    for (let j = i + 1; j < 40; j += 1) rows.push([`t${i}`, `t${j}`]);
  }
  const graph = buildGraph(events(rows), { maxEdges: 25, topNeighbors: 40, now: T0 });
  assert.equal(graph.edgeCount, 25);
  assert.ok(graph.totalEdges > 25);
  assert.equal(graph.truncated, true);
  for (let i = 1; i < graph.edges.length; i += 1) {
    assert.ok(graph.edges[i - 1].weight >= graph.edges[i].weight, 'descending weight');
  }
  assert.ok(GRAPH_HARD_CAP === 2000);
});

test('GraphCache persists, reports status, and the view slices without re-sorting', () => {
  const dir = tempDir('graph');
  const clock = new FakeClock(T0);
  try {
    const cache = new GraphCache({ dataDir: dir, clock });
    const built = cache.rebuild(
      events([
        ['a', 'b'],
        ['a', 'b'],
        ['b', 'c'],
      ]),
      { indexGeneration: 'gen-000007' },
    );
    assert.equal(built.sourceIndexGeneration, 'gen-000007');
    assert.ok(fs.existsSync(cache.file), 'cache file written');

    const status = cache.status({ limit: 500, indexGeneration: 'gen-000007' });
    assert.equal(status.available, true);
    assert.equal(status.nodeCount, 3);
    assert.equal(status.edgeCount, 2);
    assert.equal(status.stale, false);
    assert.equal(status.limit, 500);

    const stale = new GraphCache({ dataDir: dir, clock }).status({ indexGeneration: 'gen-000008' });
    assert.equal(stale.stale, true, 'a stale projection is reported, not silently served');

    const view = cache.view({ limit: 1 });
    assert.equal(view.edges.length, 1);
    assert.equal(view.nodeCount, 3, 'nodeCount is the cache total');
    assert.equal(view.nodes.length, 2, 'only nodes referenced by the sliced edges');
    assert.equal(view.limit, 1);

    const empty = new GraphCache({ dataDir: tempDir('graph-empty'), clock }).view({ limit: 500 });
    assert.equal(empty.available, false);
    assert.deepEqual(empty.edges, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt cache file is ignored instead of failing the panel', () => {
  const dir = tempDir('graph-bad');
  const clock = new FakeClock(T0);
  try {
    fs.mkdirSync(`${dir}/state`, { recursive: true });
    fs.writeFileSync(`${dir}/state/graph.json`, '{not json');
    const cache = new GraphCache({ dataDir: dir, clock });
    assert.equal(cache.view({ limit: 100 }).available, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
