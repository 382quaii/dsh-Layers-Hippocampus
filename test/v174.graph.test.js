/**
 * v1.7.4 — read-time graph trimming.
 *
 * The cached projection may hold up to GRAPH_HARD_CAP nodes; the route is what a
 * browser renders, so it gets a bounded copy. `trimGraph` is pure: the cache file
 * and the input object must never be touched, and eviction must be deterministic
 * (fewest events first) or two panels would disagree about what a "big" graph is.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { trimGraph } from '../src/graph.js';

/**
 * 31 nodes whose `events` grow with the index, with a deliberate tie block on
 * 25 so the weight/id tie-breakers are exercised. Node 0..20 are the ones with
 * the fewest events and must be evicted when `maxNodes` is 10.
 */
function makeGraph() {
  const nodes = [];
  for (let i = 0; i < 31; i += 1) {
    nodes.push({
      id: `n${i}`,
      label: `node ${i}`,
      degree: 1,
      weight: i < 25 ? 1 : (i - 25) * 0.1,
      events: i < 25 ? i : 25,
    });
  }
  const edges = [
    { source: 'n0', target: 'n1', weight: 9 },
    { source: 'n10', target: 'n21', weight: 5 },
    { source: 'n28', target: 'n29', weight: 0.3 },
    { source: 'n27', target: 'n28', weight: 0.2 },
    { source: 'n29', target: 'n30', weight: 0.1 },
  ];
  return {
    schema: 1,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    totalEdges: edges.length,
    truncated: false,
    topNeighbors: 8,
    nodes,
    edges,
  };
}

test('default trim keeps every node of a small graph and reports no truncation', () => {
  const graph = makeGraph();
  const trimmed = trimGraph(graph);
  assert.equal(trimmed.totalNodes, 31);
  assert.equal(trimmed.nodes.length, 31);
  assert.equal(trimmed.droppedNodes, 0);
  assert.equal(trimmed.droppedEdges, 0);
  assert.equal(trimmed.truncated, false);
  assert.equal(trimmed.totalEdges, 5);
  assert.equal(trimmed.topNeighbors, 8);
});

test('maxNodes keeps the nodes with the most events and drops their edges', () => {
  const graph = makeGraph();
  const trimmed = trimGraph(graph, { maxNodes: 10 });

  assert.equal(trimmed.totalNodes, 31);
  assert.equal(trimmed.nodes.length, 10);
  assert.equal(trimmed.droppedNodes, 21);
  assert.equal(trimmed.truncated, true);

  // Highest events win; the tie block is ordered by weight then id, so 21..30.
  assert.deepEqual(
    trimmed.nodes.map((node) => node.id),
    ['n21', 'n22', 'n23', 'n24', 'n25', 'n26', 'n27', 'n28', 'n29', 'n30'],
  );

  const keptIds = new Set(trimmed.nodes.map((node) => node.id));
  for (const edge of trimmed.edges) {
    assert.ok(keptIds.has(edge.source), `surviving edge source ${edge.source} must be kept`);
    assert.ok(keptIds.has(edge.target), `surviving edge target ${edge.target} must be kept`);
    assert.ok(edge.source !== 'n0' && edge.target !== 'n0');
    assert.ok(edge.source !== 'n10' && edge.target !== 'n10');
  }
  assert.equal(trimmed.droppedEdges, 2);
  assert.deepEqual(
    trimmed.edges.map((edge) => `${edge.source}->${edge.target}`),
    ['n28->n29', 'n27->n28', 'n29->n30'],
  );
});

test('equal event counts fall back to weight and then to the id text order', () => {
  const nodes = [
    { id: 'b', label: 'b', degree: 1, weight: 1, events: 5 },
    { id: 'a', label: 'a', degree: 1, weight: 1, events: 5 },
    { id: 'c', label: 'c', degree: 1, weight: 1, events: 5 },
    { id: 'd', label: 'd', degree: 1, weight: 2, events: 5 },
  ];
  const trimmed = trimGraph({ nodes, edges: [] }, { maxNodes: 2 });
  // Eviction order is (a, b, c, d); the tail survives.
  assert.deepEqual(trimmed.nodes.map((node) => node.id), ['c', 'd']);
  assert.equal(trimmed.droppedNodes, 2);
  assert.equal(trimmed.truncated, true);
});

test('edges keep the heaviest slice and are sorted weight DESC', () => {
  const graph = makeGraph();
  const trimmed = trimGraph(graph, { maxEdges: 2 });
  assert.equal(trimmed.edges.length, 2);
  assert.equal(trimmed.droppedEdges, 3);
  assert.equal(trimmed.truncated, true);
  assert.equal(trimmed.edges[0].weight, 9);
  assert.equal(trimmed.edges[1].weight, 5);
});

test('trimGraph is pure: new object, new arrays, input untouched', () => {
  const graph = makeGraph();
  const before = JSON.stringify(graph);
  const nodesRef = graph.nodes;
  const edgesRef = graph.edges;

  const trimmed = trimGraph(graph, { maxNodes: 10, maxEdges: 2 });
  assert.notEqual(trimmed, graph);
  assert.notEqual(trimmed.nodes, nodesRef);
  assert.notEqual(trimmed.edges, edgesRef);
  assert.equal(graph.nodes.length, 31);
  assert.equal(graph.edges.length, 5);
  assert.equal(JSON.stringify(graph), before);

  const first = graph.nodes.find((node) => node.id === trimmed.nodes[0].id);
  assert.notEqual(trimmed.nodes[0], first);
  trimmed.nodes[0].label = 'mutated';
  assert.equal(first.label, `node ${first.id.slice(1)}`);
});
