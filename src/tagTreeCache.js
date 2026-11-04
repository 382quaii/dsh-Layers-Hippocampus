/**
 * L1.5 tag-tree cache — a DERIVED projection of the index, rebuilt only by
 * `maintain()` and written to `<dataDir>/state/tag-tree.json`.
 *
 * The project never reads the tag tree at request time: the Web UI and the recall
 * degradation path read the persisted file (or this in-memory copy), exactly like
 * the knowledge-graph cache. Delete the file and nothing is lost — the next
 * maintenance pass reconstructs the live tree from the index alone. What IS lost
 * is ghost history (see `mergePreviousTree`), because a pure rebuild only sees the
 * events that still exist.
 *
 * Pipeline per maintenance pass (`rebuild`):
 *   1. `rebuildTree` from the converged index (live events only)
 *   2. `mergePreviousTree`: carry nodes that lost their last reference forward
 *      with refCount 0, so a leaf can die while its mid ghosts instead of both
 *      vanishing in the same pass
 *   3. queue = persisted queue ∪ dead leaves derived from the merged tree
 *   4. `pruneBatch` consumes the queue in ONE bounded batch (config.pruneBatchSize)
 *   5. persist tree + ghosts + remaining queue atomically (temp file + rename)
 *
 * Invariants:
 *   - roots are immortal and are never pruned;
 *   - flat tags are roots and survive forever;
 *   - the queue survives a restart, so a storm drains across runs, not at once.
 */

import path from 'node:path';
import { readJson, writeJsonAtomic } from './util.js';
import {
  ghostMids,
  mergePreviousTree,
  pruneBatch,
  queueDeadLeaves,
  rebuildTree,
} from './tagTreeRebuild.js';
import { isSystemReservedTag } from './utils/reservedTags.js';

/** Bump when the persisted shape changes; older files are ignored, not migrated. */
export const TAG_TREE_SCHEMA = 1;

/** Same defaults as `config.tagTree`; the cache is defensive because it must never
 * fail maintenance when a caller (tests, embedders) omitted the group. */
const DEFAULTS = Object.freeze({
  midHalfLifeMultiplier: 3,
  midGracePeriodDays: 30,
  pruneBatchSize: 100,
  leafDecayFloor: 0,
});

const LEVELS = new Set(['root', 'mid', 'leaf']);

/**
 * Project index events into the flat shape `rebuildTree` consumes.
 * Index tags are `{tag, strength}` projections; the tree only needs the name.
 * `anchorTime` (not `eventTime`) is the recency anchor: when an event_time is
 * derived from the content hash it says nothing about when the memory happened.
 */
export function eventsFromIndex(indexEvents = []) {
  const events = [];
  for (const event of Array.isArray(indexEvents) ? indexEvents : []) {
    const tags = (event?.tags ?? [])
      .map((tag) => (typeof tag === 'string' ? tag : tag?.tag))
      .filter((tag) => typeof tag === 'string' && tag.length > 0);
    if (tags.length === 0) continue;
    events.push({ eventId: event.eventId, tags, eventTime: event.anchorTime ?? event.eventTime ?? 0 });
  }
  return events;
}

/** Serialise one live node for disk; Infinity half-life is stored as null. */
function slimNode(node) {
  return {
    id: node.id,
    level: node.level,
    name: node.name,
    parentId: node.parentId ?? null,
    refCount: node.refCount ?? 0,
    childCount: node.childCount ?? 0,
    flat: node.flat === true,
    graceUntil: node.graceUntil ?? null,
    updatedAt: node.updatedAt ?? 0,
    halfLifeDays: Number.isFinite(node.halfLifeDays) ? node.halfLifeDays : null,
    decayScore: Number.isFinite(node.decayScore) ? node.decayScore : 1,
  };
}

/** Rebuild the node Map from a persisted record; corrupt entries are dropped. */
function treeFromRecord(record) {
  const nodes = new Map();
  if (!record || record.schema !== TAG_TREE_SCHEMA || !Array.isArray(record.nodes)) return { nodes };
  for (const raw of record.nodes) {
    if (!raw || typeof raw.id !== 'string' || !LEVELS.has(raw.level)) continue;
    const fallbackHalfLife = raw.level === 'root' ? Infinity : raw.level === 'mid' ? DEFAULTS.midHalfLifeMultiplier : 1;
    nodes.set(raw.id, {
      id: raw.id,
      level: raw.level,
      name: typeof raw.name === 'string' ? raw.name : raw.id,
      parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
      refCount: Number.isFinite(raw.refCount) ? Math.max(0, raw.refCount) : 0,
      childCount: 0,
      flat: raw.flat === true,
      graceUntil: Number.isFinite(raw.graceUntil) ? raw.graceUntil : null,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
      halfLifeDays: raw.level === 'root' ? Infinity : Number.isFinite(raw.halfLifeDays) ? raw.halfLifeDays : fallbackHalfLife,
      decayScore: Number.isFinite(raw.decayScore) ? raw.decayScore : 1,
    });
  }
  return { nodes };
}

/** Persisted entries only survive when their node still exists (no ghosts of ghosts). */
function usableQueue(entries, nodes) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  const queue = [];
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string') continue;
    if (!nodes.has(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    queue.push({
      id: entry.id,
      queuedBy: entry.queuedBy === 'forget' ? 'forget' : 'release',
      at: Number.isFinite(entry.at) ? entry.at : 0,
    });
  }
  return queue;
}

/** Union two queues by id, sorted: deterministic input for the bounded prune pass. */
function mergeQueues(persisted, derived) {
  const byId = new Map();
  for (const entry of persisted) byId.set(entry.id, entry);
  for (const entry of derived) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Route view: how many ghost nodes one graph response may carry.
 * Deliberately small — the graph is rendered by an O(n²) force layout, and a
 * "history" that dumps thousands of nodes into it would be a UI performance storm
 * for no readability gain. 50 ghosts already fill a 640×320 canvas.
 */
export const TAG_TREE_GHOST_VIEW_CAP = 50;

export class TagTreeCache {
  /**
   * @param {object} options
   * @param {string} options.dataDir absolute plugin data directory
   * @param {{now(): number}} [options.clock]
   * @param {() => object} [options.getConfig] resolved plugin config (tagTree group)
   */
  constructor({ dataDir, clock, getConfig = () => ({}) } = {}) {
    this.dataDir = dataDir;
    this.clock = clock ?? { now: () => Date.now() };
    this.getConfig = getConfig;
    this.file = path.join(dataDir, 'state', 'tag-tree.json');
    this._current = null;
    this._loaded = false;
  }

  /** Resolved, range-guarded lifecycle knobs. Validation itself lives in config.js. */
  config() {
    const section = this.getConfig?.()?.tagTree ?? {};
    const pick = (key, min, max) => {
      const value = Number(section[key]);
      return Number.isFinite(value) && value >= min && value <= max ? value : DEFAULTS[key];
    };
    return {
      midHalfLifeMultiplier: pick('midHalfLifeMultiplier', 1, 10),
      midGracePeriodDays: pick('midGracePeriodDays', 7, 180),
      pruneBatchSize: Math.trunc(pick('pruneBatchSize', 10, 500)),
      leafDecayFloor: pick('leafDecayFloor', 0, 1),
    };
  }

  /** Load once; a corrupt or older-schema file is treated as absent, never fatal. */
  read() {
    if (this._loaded) return this._current;
    this._loaded = true;
    const cached = readJson(this.file, null);
    this._current = cached && cached.schema === TAG_TREE_SCHEMA ? cached : null;
    return this._current;
  }

  /** Durability: temp file + fsync + rename, so a reader sees old or new, never half. */
  write(record) {
    const stored = {
      ...record,
      schema: TAG_TREE_SCHEMA,
      generatedAt: this.clock?.now?.() ?? record.generatedAt ?? null,
    };
    writeJsonAtomic(this.file, stored);
    this._current = stored;
    this._loaded = true;
    return stored;
  }

  /**
   * Rebuild + prune + persist. Called by `maintain()` only.
   *
   * @param {object} options
   * @param {Array<{eventId: string, tags: string[], eventTime: number}>} [options.events]
   * @param {string|null} [options.indexGeneration] provenance for staleness checks
   * @param {number} [options.now] injected clock instant for this pass
   */
  rebuild({ events = [], indexGeneration = null, now = this.clock.now() } = {}) {
    const config = this.config();
    const previous = this.read();
    const previousTree = treeFromRecord(previous);

    const tree = rebuildTree({ events, now, config: { midHalfLifeMultiplier: config.midHalfLifeMultiplier } });
    const { carried } = mergePreviousTree(tree, previousTree, {
      now,
      midGracePeriodDays: config.midGracePeriodDays,
    });
    // A carried node carries its OLD half-life from disk; the current config is the
    // only source of truth for a lifetime, so re-apply it (a config change must also
    // re-time the ghosts that are already fading).
    for (const node of tree.nodes.values()) {
      if (node.level === 'mid') node.halfLifeDays = config.midHalfLifeMultiplier;
    }

    const queue = mergeQueues(usableQueue(previous?.pendingQueue, tree.nodes), queueDeadLeaves(tree, { now }));
    const pruned = pruneBatch(tree, {
      now,
      batchSize: config.pruneBatchSize,
      queue,
      midGracePeriodDays: config.midGracePeriodDays,
      leafDecayFloor: config.leafDecayFloor,
    });

    const rawNodes = pruned.tree.nodes;
    // v1.5.6: a previous persisted tree (or an old index) may still carry reserved
    // nodes; drop them before they can be counted or shipped.
    const nodes = new Map([...rawNodes].filter(([, node]) => !isSystemReservedTag(node.name)));
    const remainingQueue = queue.slice(pruned.consumed).filter((entry) => nodes.has(entry.id));
    const ghosts = ghostMids(pruned.tree, now)
      .filter((ghost) => !isSystemReservedTag(ghost.name))
      .map((ghost) => ({ ...ghost, parentId: nodes.get(ghost.id)?.parentId ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id));

    const counts = { root: 0, mid: 0, leaf: 0 };
    for (const node of nodes.values()) counts[node.level] = (counts[node.level] ?? 0) + 1;

    return this.write({
      // Provenance first: a tag tree whose generation does not match the live index
      // is stale and must be rebuilt by the next maintenance pass.
      sourceIndexGeneration: indexGeneration,
      builtAt: now,
      nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)).map(slimNode),
      // Ghost metadata is the UI's "history view" input and the recall degradation
      // input: a mid inside its grace window is a memory that is fading, not gone.
      ghosts,
      // The queue is persisted so a storm drains across restarts, never at once.
      pendingQueue: remainingQueue,
      stats: {
        roots: counts.root,
        mids: counts.mid,
        leaves: counts.leaf,
        nodes: nodes.size,
        ghosts: ghosts.length,
        carried: carried.length,
        pendingQueue: remainingQueue.length,
      },
      prune: {
        removedLeaves: pruned.removedLeaves,
        removedMids: pruned.removedMids,
        consumed: pruned.consumed,
        remaining: pruned.remaining,
      },
    });
  }

  /**
   * Route payload: ghost metadata for the graph's history view. Nodes are NOT
   * shipped — the graph route already carries the live graph and the full tree
   * stays on disk. Capped so a pathological history cannot bloat one response.
   */
  view({ ghostLimit = TAG_TREE_GHOST_VIEW_CAP } = {}) {
    const tree = this.read();
    if (!tree) {
      return { available: false, generatedAt: null, sourceIndexGeneration: null, stats: null, totalGhosts: 0, truncated: false, ghosts: [] };
    }
    const ghosts = (Array.isArray(tree.ghosts) ? tree.ghosts : []).filter(
      (ghost) => !isSystemReservedTag(ghost?.name ?? ghost?.id),
    );
    const requested = Number(ghostLimit);
    const limit = Number.isFinite(requested) ? Math.max(0, Math.min(Math.trunc(requested), TAG_TREE_GHOST_VIEW_CAP)) : TAG_TREE_GHOST_VIEW_CAP;
    return {
      available: true,
      generatedAt: tree.generatedAt ?? null,
      sourceIndexGeneration: tree.sourceIndexGeneration ?? null,
      stats: tree.stats ?? null,
      totalGhosts: ghosts.length,
      truncated: ghosts.length > limit,
      ghosts: ghosts.slice(0, limit),
    };
  }

  /** Panel summary — counts only, never the nodes themselves. */
  status({ indexGeneration = null } = {}) {    const tree = this.read();
    if (!tree) {
      return {
        available: false,
        nodeCount: 0,
        ghostCount: 0,
        roots: 0,
        mids: 0,
        leaves: 0,
        pendingQueue: 0,
        generatedAt: null,
        sourceIndexGeneration: null,
        stale: false,
      };
    }
    return {
      available: true,
      nodeCount: tree.stats?.nodes ?? tree.nodes?.length ?? 0,
      ghostCount: tree.stats?.ghosts ?? tree.ghosts?.length ?? 0,
      roots: tree.stats?.roots ?? 0,
      mids: tree.stats?.mids ?? 0,
      leaves: tree.stats?.leaves ?? 0,
      pendingQueue: tree.pendingQueue?.length ?? 0,
      generatedAt: tree.generatedAt ?? null,
      sourceIndexGeneration: tree.sourceIndexGeneration ?? null,
      stale:
        indexGeneration !== null &&
        tree.sourceIndexGeneration !== null &&
        tree.sourceIndexGeneration !== undefined &&
        tree.sourceIndexGeneration !== indexGeneration,
    };
  }
}
