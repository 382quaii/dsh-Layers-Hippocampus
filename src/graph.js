/**
 * Knowledge graph: computed OFFLINE, served as a cheap slice.
 *
 * The UI never asks for "the graph"; it asks for "at most N edges", and N is a
 * config value that can change while the page is open. Sorting thousands of
 * edges inside a request would put CPU on the request path for no benefit, so:
 *
 *   - `maintain()` (the single maintenance gate) rebuilds the graph from the
 *     index — which is already "log minus tombstones" — and writes it to
 *     `<dataDir>/state/graph.json`;
 *   - the route reads that file and does `.slice(0, config.graphMaxEdges)`;
 *   - nothing re-sorts, re-scores, or re-reads the log at request time.
 *
 * Edge selection follows the spec:
 *   1. per node keep its Top-N strongest neighbours (a hub cannot swallow the map);
 *   2. then sort the surviving edges globally by weight;
 *   3. cap the cache at GRAPH_HARD_CAP (2000).
 *
 * The cache is a pure projection of the index: deleting it loses nothing, and a
 * stale one is recognisable by `sourceIndexGeneration`.
 */

import path from 'node:path';
import { ensureDir, readJson, round, writeJsonAtomic } from './util.js';

/** Hard ceiling of the cached graph (not the read-time limit). */
export const GRAPH_HARD_CAP = 2000;
/** Neighbours kept per node before the global sort. */
export const GRAPH_TOP_NEIGHBORS = 8;
/** Bump when the cached shape changes; older files are ignored, not migrated. */
export const GRAPH_SCHEMA = 1;

function nodeId(tag) {
  return String(tag);
}

/**
 * Build the graph from index events.
 *
 * Events already exclude tombstones (buildIndex filters them), so "log minus
 * tombstones" is exactly what we consume — no second scan, no second truth.
 *
 * @param {Array<{eventId: string, tags: Array<{tag: string, strength: number}>}>} events
 * @param {{maxEdges?: number, topNeighbors?: number, now?: number}} [options]
 */
export function buildGraph(events = [], { maxEdges = GRAPH_HARD_CAP, topNeighbors = GRAPH_TOP_NEIGHBORS, now = Date.now() } = {}) {
  const weights = new Map(); // "a\u0000b" -> weight, a < b
  const nodeMass = new Map(); // tag -> event mass
  const nodeEvents = new Map(); // tag -> event count

  for (const event of events) {
    const tags = (event?.tags ?? []).map((entry) => nodeId(entry.tag)).filter(Boolean);
    if (tags.length === 0) continue;
    const unique = [...new Set(tags)].sort();
    const salience = Number.isFinite(event?.salience) ? event.salience : 0.5;
    for (const tag of unique) {
      nodeMass.set(tag, (nodeMass.get(tag) ?? 0) + Math.max(0.05, salience));
      nodeEvents.set(tag, (nodeEvents.get(tag) ?? 0) + 1);
    }
    // Pair strength: both tags had to be in the same memory, so co-occurrence is
    // the signal; salience keeps important memories heavier than throwaway ones.
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const key = `${unique[i]}\u0000${unique[j]}`;
        weights.set(key, (weights.get(key) ?? 0) + Math.max(0.05, salience));
      }
    }
  }

  // ---- 1. per-node Top-N ---------------------------------------------------
  // An edge survives only when BOTH endpoints rank it inside their own Top-N.
  // Keeping the union would let a hub re-add every edge through its leaves' lists
  // (each leaf's only neighbour is the hub), which is exactly the map-swallowing
  // behaviour this step exists to prevent.
  const perNode = new Map(); // tag -> [{ other, weight }]
  for (const [key, weight] of weights) {
    const [a, b] = key.split('\u0000');
    if (!perNode.has(a)) perNode.set(a, []);
    if (!perNode.has(b)) perNode.set(b, []);
    perNode.get(a).push({ other: b, weight });
    perNode.get(b).push({ other: a, weight });
  }
  const topOf = new Map();
  for (const [tag, neighbours] of perNode) {
    neighbours.sort((x, y) => y.weight - x.weight || x.other.localeCompare(y.other));
    topOf.set(tag, new Set(neighbours.slice(0, topNeighbors).map((entry) => entry.other)));
  }
  const kept = new Map();
  for (const [key, weight] of weights) {
    const [a, b] = key.split('\u0000');
    if (!topOf.get(a)?.has(b) || !topOf.get(b)?.has(a)) continue;
    kept.set(key, weight);
  }

  // ---- 2. global weight order ---------------------------------------------
  const edges = [...kept.entries()]
    .map(([key, weight]) => {
      const [source, target] = key.split('\u0000');
      return { source, target, weight: round(weight, 4) };
    })
    .sort((x, y) => y.weight - x.weight || x.source.localeCompare(y.source) || x.target.localeCompare(y.target));

  const totalEdges = edges.length;
  const capped = edges.slice(0, Math.min(maxEdges, GRAPH_HARD_CAP));

  // ---- 3. nodes referenced by the kept edges (plus isolated hubs) ----------
  const degree = new Map();
  for (const edge of capped) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const nodes = [...degree.keys()]
    .map((id) => ({
      id,
      label: id,
      degree: degree.get(id) ?? 0,
      weight: round(nodeMass.get(id) ?? 0, 4),
      events: nodeEvents.get(id) ?? 0,
    }))
    .sort((x, y) => y.weight - x.weight || x.id.localeCompare(y.id));

  return {
    schema: GRAPH_SCHEMA,
    generatedAt: now,
    // Provenance: which index generation this projection came from. A mismatch
    // with the live index means "stale, rebuild on the next maintenance".
    sourceIndexGeneration: null,
    nodeCount: nodes.length,
    edgeCount: capped.length,
    totalEdges,
    truncated: totalEdges > capped.length,
    topNeighbors,
    nodes,
    edges: capped,
  };
}

/** Read-only view over the cached graph file. */
export class GraphCache {
  constructor({ dataDir, clock }) {
    this.dataDir = dataDir;
    this.clock = clock;
    this.file = path.join(dataDir, 'state', 'graph.json');
    this._current = null;
    this._loaded = false;
  }

  /** Load once; a corrupt or older-schema file is treated as absent, never fatal. */
  read() {
    if (this._loaded) return this._current;
    this._loaded = true;
    const cached = readJson(this.file, null);
    this._current = cached && cached.schema === GRAPH_SCHEMA ? cached : null;
    return this._current;
  }

  write(graph) {
    ensureDir(path.dirname(this.file));
    const record = { ...graph, schema: GRAPH_SCHEMA, generatedAt: this.clock?.now?.() ?? Date.now() };
    writeJsonAtomic(this.file, record);
    this._current = record;
    this._loaded = true;
    return record;
  }

  /** Rebuild from the live index and persist. Called by maintain() only. */
  rebuild(events, { indexGeneration = null, maxEdges = GRAPH_HARD_CAP, topNeighbors = GRAPH_TOP_NEIGHBORS } = {}) {
    const graph = buildGraph(events, { maxEdges: Math.min(maxEdges, GRAPH_HARD_CAP), topNeighbors, now: this.clock?.now?.() ?? Date.now() });
    graph.sourceIndexGeneration = indexGeneration;
    return this.write(graph);
  }

  /** Panel summary — never returns nodes or edges. */
  status({ limit = null, indexGeneration = null } = {}) {
    const graph = this.read();
    if (!graph) {
      return { available: false, nodeCount: 0, edgeCount: 0, totalEdges: 0, generatedAt: null, stale: false, limit };
    }
    return {
      available: true,
      nodeCount: graph.nodeCount,
      edgeCount: graph.edgeCount,
      totalEdges: graph.totalEdges,
      truncated: graph.truncated,
      generatedAt: graph.generatedAt,
      limit,
      stale: indexGeneration !== null && graph.sourceIndexGeneration !== null && graph.sourceIndexGeneration !== indexGeneration,
    };
  }

  /**
   * The route's whole job: cached edges, sliced to the configured ceiling.
   * No sorting, no filtering, no disk walk.
   */
  view({ limit = 500 } = {}) {
    const graph = this.read();
    if (!graph) {
      return { available: false, nodes: [], edges: [], totalEdges: 0, edgeCount: 0, nodeCount: 0, generatedAt: null, limit };
    }
    const safeLimit = Math.max(0, Math.min(Number(limit) || 0, GRAPH_HARD_CAP));
    const edges = graph.edges.slice(0, safeLimit);
    const visible = new Set();
    for (const edge of edges) {
      visible.add(edge.source);
      visible.add(edge.target);
    }
    return {
      available: true,
      nodes: graph.nodes.filter((node) => visible.has(node.id)),
      edges,
      nodeCount: graph.nodeCount,
      edgeCount: edges.length,
      totalEdges: graph.totalEdges,
      truncated: graph.truncated || edges.length < graph.edgeCount,
      generatedAt: graph.generatedAt,
      limit: safeLimit,
    };
  }
}
