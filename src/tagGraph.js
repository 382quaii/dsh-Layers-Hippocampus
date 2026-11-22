/**
 * Tag adjacency — the O(1) half of "1-hop associative recall" (v1.6.9).
 *
 * The L1.5 knowledge graph is already rebuilt offline (`src/graph.js` →
 * `state/graph.json`): its edges are co-occurrence weights between tags that
 * appeared in the same memory. What recall needed was not another traversal —
 * it was a LOOKUP TABLE, so this module turns the edge list into
 * `Map<tag, neighbours[]>` once per index generation.
 *
 * Hard rules (they are the whole point of this file):
 *   - **Exactly one hop.** `MAX_ASSOCIATIVE_HOPS = 1`; anything larger throws
 *     instead of quietly costing O(n) or, worse, walking a dense hub graph.
 *     `assertAssociativeHops()` is the only validator, so "no BFS/DFS anywhere"
 *     is a property you can check by grepping for it.
 *   - **No allocation on the read path.** `expandOneHop()` reads the map and a
 *     pre-sorted neighbour list; it never sorts, filters or scans the edge list.
 *   - **Bounded neighbours.** Each node keeps at most `ADJACENCY_NEIGHBOUR_CAP`
 *     strongest neighbours, so one hub cannot make a query expensive.
 */

import { ErrorCodes, MemoryError } from './errors.js';

/** The ONLY supported number of hops. Kept as a named constant for tests. */
export const MAX_ASSOCIATIVE_HOPS = 1;
/** Neighbours kept per tag in the adjacency map. */
export const ADJACENCY_NEIGHBOUR_CAP = 8;

/**
 * Validate a caller-supplied hop count.
 *
 * `0` means "no expansion" (the pre-1.6.9 behaviour) and is allowed; `1` is the
 * supported expansion; anything else is refused. Silent clamping would turn a
 * caller's performance expectation into a lie.
 */
export function assertAssociativeHops(value) {
  const hops = value === undefined || value === null ? MAX_ASSOCIATIVE_HOPS : Number(value);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new MemoryError(ErrorCodes.INVALID_INPUT, 'maxAssociativeHops must be an integer 0 or 1', { value });
  }
  if (hops > MAX_ASSOCIATIVE_HOPS) {
    throw new MemoryError(
      ErrorCodes.INVALID_INPUT,
      `maxAssociativeHops must be <= ${MAX_ASSOCIATIVE_HOPS}: associative recall is a single O(1) lookup, not a graph walk`,
      { value: hops, max: MAX_ASSOCIATIVE_HOPS },
    );
  }
  return hops;
}

/**
 * Build the adjacency map from graph edges.
 *
 * Edges are `{source, target, weight}` (see `buildGraph`). The map is
 * symmetric (both directions), each neighbour list is de-duplicated and sorted by
 * weight DESC, and then truncated to `cap`.
 *
 * @param {Array<{source?: string, target?: string, weight?: number}>} edges
 * @param {{cap?: number}} [options]
 * @returns {Map<string, Array<{tag: string, weight: number}>>}
 */
export function buildAdjacency(edges = [], { cap = ADJACENCY_NEIGHBOUR_CAP } = {}) {
  const limit = Number.isFinite(cap) && cap >= 1 ? Math.trunc(cap) : ADJACENCY_NEIGHBOUR_CAP;
  /** @type {Map<string, Map<string, number>>} */
  const raw = new Map();
  const add = (self, other, weight) => {
    if (!self || !other || self === other) return;
    if (!raw.has(self)) raw.set(self, new Map());
    const neighbours = raw.get(self);
    neighbours.set(other, Math.max(neighbours.get(other) ?? 0, Number(weight) || 0));
  };
  for (const edge of Array.isArray(edges) ? edges : []) {
    const source = edge?.source;
    const target = edge?.target;
    const weight = edge?.weight ?? 0;
    add(source, target, weight);
    add(target, source, weight);
  }
  const adjacency = new Map();
  for (const [tag, neighbours] of raw) {
    const sorted = [...neighbours.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([other, weight]) => ({ tag: other, weight }));
    adjacency.set(tag, sorted);
  }
  return adjacency;
}

/**
 * Resolve the strongest neighbours of `seeds`, one hop only.
 *
 * @param {{adjacency?: Map|null, seeds?: Iterable<string>, exclude?: Iterable<string>, limit?: number}} input
 * @returns {Array<{tag: string, via: string, weight: number}>}
 */
export function expandOneHop({ adjacency = null, seeds = [], exclude = [], limit = 1 } = {}) {
  if (!(adjacency instanceof Map) || adjacency.size === 0) return [];
  const perSeed = Number.isFinite(limit) && limit >= 1 ? Math.trunc(limit) : 1;
  const blocked = new Set(exclude ?? []);
  const picked = [];
  const taken = new Set();
  for (const seed of seeds ?? []) {
    if (typeof seed !== 'string' || seed.length === 0) continue;
    const neighbours = adjacency.get(seed); // O(1)
    if (!neighbours || neighbours.length === 0) continue;
    let added = 0;
    for (const neighbour of neighbours) {
      if (added >= perSeed) break;
      if (blocked.has(neighbour.tag) || taken.has(neighbour.tag)) continue;
      taken.add(neighbour.tag);
      picked.push({ tag: neighbour.tag, via: seed, weight: neighbour.weight });
      added += 1;
    }
  }
  return picked;
}

/** Panel/status view: how big the lookup table is, without dumping it. */
export function adjacencyStatus(adjacency) {
  if (!(adjacency instanceof Map)) return { nodes: 0, edges: 0, maxHops: MAX_ASSOCIATIVE_HOPS };
  let edges = 0;
  for (const neighbours of adjacency.values()) edges += neighbours.length;
  return { nodes: adjacency.size, edges, maxHops: MAX_ASSOCIATIVE_HOPS };
}
