/**
 * L1.5 tag tree: hierarchical decay, cascade pruning, ghost nodes.
 *
 * Three levels with different life plans:
 *   root  — never dies, whatever happens below it
 *   mid   — half-life × multiplier; survives its leaves, then enters a grace
 *           period; if nothing mounts under it before the deadline, it dies
 *   leaf  — normal decay; dies the moment its reference count reaches zero
 *
 * Discipline: nothing here mutates the tree during a scan. Dead leaves go to a
 * pending queue and are pruned in bounded batches, and mid state is recomputed in
 * one pass — so `maintain()` cannot become a quadratic walk.
 */
export const LEVELS = Object.freeze(['root', 'mid', 'leaf']);
export const ROOT = 'root';
export const MID = 'mid';
export const LEAF = 'leaf';
export const DAY_MS = 86_400_000;

export class TagTree {
  /**
   * @param {object} options
   * @param {{now(): number}} options.clock
   * @param {() => object} [options.getConfig] resolved config (tagTree section)
   */
  constructor({ clock, getConfig = () => ({}) } = {}) {
    this.clock = clock;
    this.getConfig = getConfig;
    /** @type {Map<string, object>} */
    this.nodes = new Map();
    /** Queue of dead leaves: { id, at }. Never mutated during traversal. */
    this.pendingPruneQueue = [];
    this.lastSweep = null;
  }

  config() {
    const section = this.getConfig?.()?.tagTree ?? {};
    return {
      midHalfLifeMultiplier: section.midHalfLifeMultiplier ?? 3,
      midGracePeriodDays: section.midGracePeriodDays ?? 30,
      pruneBatchSize: section.pruneBatchSize ?? 100,
    };
  }

  key(level, name) {
    return `${level}:${name}`;
  }

  get(id) {
    return this.nodes.get(id) ?? null;
  }

  /** Root nodes are created lazily and never removed. */
  ensureRoot(name) {
    const id = this.key(ROOT, name);
    let node = this.nodes.get(id);
    if (!node) {
      node = { id, level: ROOT, name, parentId: null, refCount: 0, childCount: 0, createdAt: this.clock.now(), graceUntil: null, prunedAt: null };
      this.nodes.set(id, node);
    }
    return node;
  }

  ensureMid(rootName, midName) {
    const id = this.key(MID, midName);
    let node = this.nodes.get(id);
    if (!node) {
      // Missing parent means the mid was pruned earlier: rebuild through root so a
      // new leaf can never create an orphan.
      const root = this.ensureRoot(rootName);
      node = { id, level: MID, name: midName, parentId: root.id, refCount: 0, childCount: 0, createdAt: this.clock.now(), graceUntil: null, prunedAt: null };
      this.nodes.set(id, node);
      root.childCount += 1;
    }
    return node;
  }

  ensureLeaf(rootName, midName, leafName) {
    const mid = this.ensureMid(rootName, midName);
    const id = this.key(LEAF, leafName);
    let node = this.nodes.get(id);
    if (!node) {
      node = { id, level: LEAF, name: leafName, parentId: mid.id, refCount: 0, childCount: 0, createdAt: this.clock.now(), graceUntil: null, prunedAt: null };
      this.nodes.set(id, node);
      mid.childCount += 1;
    }
    // Mounting under a ghost mid revives it immediately (full health, no grace).
    if (mid.graceUntil !== null) {
      mid.graceUntil = null;
      mid.revivedAt = this.clock.now();
    }
    return node;
  }

  /** Register one memory reference along a root/mid/leaf path. */
  mount({ root, mid, leaf, count = 1 } = {}) {
    if (!root || !mid || !leaf) throw new Error('TagTree.mount requires root, mid and leaf');
    const leafNode = this.ensureLeaf(root, mid, leaf);
    const midNode = this.get(leafNode.parentId);
    leafNode.refCount += count;
    midNode.refCount += count;
    this.ensureRoot(root).refCount += count;
    leafNode.updatedAt = this.clock.now();
    return { root: this.get(this.key(ROOT, root)), mid: midNode, leaf: leafNode };
  }

  /** Release references; a leaf that reaches zero is queued, not removed. */
  release({ root, mid, leaf, count = 1 } = {}) {
    const leafNode = this.get(this.key(LEAF, leaf));
    if (!leafNode) return { queued: false };
    leafNode.refCount = Math.max(0, leafNode.refCount - count);
    const midNode = this.get(leafNode.parentId);
    if (midNode) midNode.refCount = Math.max(0, midNode.refCount - count);
    const rootNode = root ? this.get(this.key(ROOT, root)) : null;
    if (rootNode) rootNode.refCount = Math.max(0, rootNode.refCount - count);
    if (leafNode.refCount === 0) {
      const already = this.pendingPruneQueue.some((item) => item.id === leafNode.id);
      if (!already) {
        this.pendingPruneQueue.push({ id: leafNode.id, at: this.clock.now() });
        return { queued: true, id: leafNode.id };
      }
    }
    return { queued: false };
  }

  /** Half-life in days for a node level: leaf 1×, mid multiplier×, root ∞. */
  halfLifeDays(level) {
    if (level === ROOT) return Infinity;
    const { midHalfLifeMultiplier } = this.config();
    return level === MID ? midHalfLifeMultiplier : 1;
  }

  /** Decay score in [0,1]; root is always 1. */
  decayScore(node, now = this.clock.now()) {
    const halfLife = this.halfLifeDays(node.level);
    if (!Number.isFinite(halfLife)) return 1;
    const ageDays = Math.max(0, (now - (node.updatedAt ?? node.createdAt)) / DAY_MS);
    return Math.pow(0.5, ageDays / halfLife);
  }

  /** True when the mid is in its 30-ish day grace window (UI ghost, recall meta-only). */
  isGhost(node, now = this.clock.now()) {
    return Boolean(node && node.level === MID && node.graceUntil !== null && node.graceUntil > now);
  }

  /**
   * Bounded prune pass. Queued leaves die first; dead mids are collected in one
   * pass afterwards, so the tree is walked at most twice per batch.
   */
  prune({ now = this.clock.now() } = {}) {
    const { pruneBatchSize, midGracePeriodDays } = this.config();
    const batch = this.pendingPruneQueue.splice(0, Math.max(1, pruneBatchSize));
    const removedLeaves = [];
    const touchedMids = new Set();
    for (const item of batch) {
      const node = this.nodes.get(item.id);
      if (!node || node.refCount > 0) continue; // reference came back while queued
      this.nodes.delete(node.id);
      removedLeaves.push(node.id);
      const parent = this.nodes.get(node.parentId);
      if (parent) {
        parent.childCount = Math.max(0, parent.childCount - 1);
        touchedMids.add(parent.id);
      }
    }
    // One pass: every mid that lost its last child enters (or stays in) grace.
    const removedMids = [];
    for (const midId of touchedMids) {
      const mid = this.nodes.get(midId);
      if (!mid || mid.childCount > 0 || mid.refCount > 0) continue;
      if (mid.graceUntil === null) mid.graceUntil = now + midGracePeriodDays * DAY_MS;
    }
    if (batch.length > 0) {
      for (const node of [...this.nodes.values()]) {
        if (node.level !== MID) continue;
        if (node.childCount > 0 || node.refCount > 0) continue;
        if (node.graceUntil !== null && node.graceUntil <= now) {
          this.nodes.delete(node.id);
          removedMids.push(node.id);
          const parent = this.nodes.get(node.parentId);
          if (parent) parent.childCount = Math.max(0, parent.childCount - 1);
        }
      }
    }
    const report = { removedLeaves, removedMids, batchSize: batch.length, pending: this.pendingPruneQueue.length, now };
    this.lastSweep = report;
    return report;
  }

  /** Ghost list for the graph UI ("show history" view). */
  ghosts({ now = this.clock.now() } = {}) {
    return [...this.nodes.values()].filter((node) => this.isGhost(node, now)).map((node) => ({ id: node.id, name: node.name, graceUntil: node.graceUntil }));
  }

  /** Read model used by recall metadata-only responses. */
  status(nodeId, now = this.clock.now()) {
    const node = this.nodes.get(nodeId);
    if (!node) return null;
    return {
      id: node.id,
      level: node.level,
      name: node.name,
      refCount: node.refCount,
      childCount: node.childCount,
      ghost: this.isGhost(node, now),
      graceUntil: node.graceUntil,
      decay: Number(this.decayScore(node, now).toFixed(4)),
    };
  }

  snapshot({ now = this.clock.now() } = {}) {
    return [...this.nodes.values()].map((node) => this.status(node.id, now));
  }
}
