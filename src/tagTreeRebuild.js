/**
 * L1.5 tree rebuild — derived state only, never mutated on the write path.
 *
 * Conventions (locked):
 *   'tech/frontend/vue3' -> root 'tech', mid 'frontend', leaf 'vue3'
 *   'tech'               -> flat root node, PROTECTED from pruning forever
 *   'tech/frontend'      -> root + mid (no leaf level)
 *
 * `rebuildTree` is pure: same events + parents + now -> byte-identical tree, so a
 * restart or a log replay converges instead of drifting.
 */
import { isSystemReservedTag } from './utils/reservedTags.js';

export const DAY_MS = 86_400_000;
/** Mid survives while its decay score is above this (wide-grace survival line). */
export const MID_DECAY_FLOOR = 0.05;
export const FLAT_PREFIX = 'flat:';

export function isFlatTag(tag) {
  return !String(tag).includes('/');
}

/** Split one tag into the three-level path (or null for a flat tag). */
export function parseTagPath(tag) {
  const text = String(tag ?? '');
  if (!text || isFlatTag(text)) return null;
  const parts = text.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return null;
  if (parts.length === 2) return { root: parts[0], mid: parts[1], leaf: null };
  return { root: parts[0], mid: parts[1], leaf: parts.slice(2).join('/') };
}

function decay(updatedAt, now, halfLifeDays) {
  if (!Number.isFinite(halfLifeDays)) return 1;
  const age = Math.max(0, now - updatedAt) / DAY_MS;
  return Math.pow(0.5, age / halfLifeDays);
}

/**
 * Build the tree from the current index (events with non-empty tag lists).
 * Flat tags keep their own root node and are marked `flat: true`.
 *
 * `config.midHalfLifeMultiplier` is the ONLY source of the mid half-life: the
 * charter forbids silent hard-coded lifetimes, and the value is user-facing.
 */
export function rebuildTree({ events = [], parents = {}, now = 0, config = {} } = {}) {
  const nodes = new Map();
  const parentMap = parents || {}; // optional: { mid: root } for tags that need a hint
  const midHalfLifeDays = Number.isFinite(config?.midHalfLifeMultiplier) ? config.midHalfLifeMultiplier : 3;
  const touch = (level, name, parentId, halfLifeDays) => {
    const id = `${level}:${name}`;
    let node = nodes.get(id);
    if (!node) {
      node = { id, level, name, parentId, refCount: 0, childCount: 0, flat: false, graceUntil: null, updatedAt: now, halfLifeDays };
      nodes.set(id, node);
    }
    return node;
  };
  for (const event of events) {
    const tags = Array.isArray(event.tags) ? event.tags : [];
    for (const tag of tags) {
      // v1.5.6: reserved bookkeeping tags are not part of the user's tag tree.
      if (isSystemReservedTag(tag)) continue;
      const path = parseTagPath(tag);
      if (!path) {
        const flat = touch('root', String(tag), null, Infinity);
        flat.flat = true;
        flat.refCount += 1;
        flat.updatedAt = Math.max(flat.updatedAt, event.eventTime ?? now);
        continue;
      }
      const root = touch('root', path.root, null, Infinity);
      root.refCount += 1;
      root.updatedAt = Math.max(root.updatedAt, event.eventTime ?? now);
      const midName = parentMap[path.mid] ?? path.mid;
      const mid = touch('mid', midName, root.id, midHalfLifeDays);
      mid.refCount += 1;
      mid.updatedAt = Math.max(mid.updatedAt, event.eventTime ?? now);
      if (path.leaf) {
        const leaf = touch('leaf', path.leaf, mid.id, 1);
        leaf.refCount += 1;
        leaf.updatedAt = Math.max(leaf.updatedAt, event.eventTime ?? now);
      }
    }
  }
  // childCount + decay score are derived once, not incremented piecemeal.
  for (const node of nodes.values()) {
    node.decayScore = Number(decay(node.updatedAt, now, node.halfLifeDays).toFixed(6));
  }
  for (const node of nodes.values()) {
    node.childCount = [...nodes.values()].filter((candidate) => candidate.parentId === node.id).length;
  }
  return { nodes, builtAt: now };
}

/** Deterministic serialisation for replay checks. */
export function serializeTree(tree) {
  const nodes = [...tree.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ builtAt: tree.builtAt, nodes });
}

/**
 * Bounded prune pass. Flat roots are NEVER removed. A leaf leaves when it was
 * queued by an explicit forget (`queuedBy: 'forget'`) or because its reference
 * count already reached zero (`queuedBy: 'release'`), or when `leafDecayFloor > 0`
 * and its decay fell below it. Mid enters grace when it loses its last child, and
 * dies only after the grace deadline AND a decay score under MID_DECAY_FLOOR.
 */
export function pruneBatch(tree, { now = 0, batchSize = 100, queue = [], midGracePeriodDays = 30, leafDecayFloor = 0 } = {}) {
  const nodes = tree.nodes;
  // Decay is DERIVED state, so re-derive it against THIS pass's `now` before any
  // decision. A score frozen at rebuild time would let a mid that already sat out
  // its whole grace window still look freshly mounted, and it would survive
  // forever — pruning must judge the tree as it is now, not as it was built.
  for (const node of nodes.values()) {
    node.decayScore = Number(decay(node.updatedAt ?? tree.builtAt ?? now, now, node.halfLifeDays).toFixed(6));
  }
  const batch = queue.slice(0, Math.max(1, batchSize));
  const removedLeaves = [];
  const removedMids = [];
  const touchedMids = new Set();
  for (const item of batch) {
    const node = nodes.get(item.id);
    if (!node || node.level !== 'leaf') continue;
    if (node.refCount > 0) continue;
    if (node.flat) continue;
    const decayOk = leafDecayFloor > 0 && (node.decayScore ?? 1) < leafDecayFloor;
    // 'release' means the count already reached zero during the merge, so the leaf
    // is dead by definition; only the bounded batch cadence delays its removal.
    const forced = item.queuedBy === 'forget' || item.queuedBy === 'release';
    if (!forced && !decayOk) continue;
    nodes.delete(node.id);
    removedLeaves.push(node.id);
    // Decrement the parent here: rescanning the whole tree per touched mid would
    // make one batch quadratic on a wide fan-out (100 mids x 10k nodes).
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (parent) {
      parent.childCount = Math.max(0, parent.childCount - 1);
      touchedMids.add(parent.id);
    }
  }
  for (const midId of touchedMids) {
    const mid = nodes.get(midId);
    if (!mid) continue;
    if (mid.childCount === 0 && mid.refCount === 0 && mid.graceUntil === null) {
      mid.graceUntil = now + midGracePeriodDays * DAY_MS;
    }
  }
  for (const node of [...nodes.values()]) {
    if (node.level !== 'mid') continue;
    if (node.flat) continue;
    if (node.childCount > 0 || node.refCount > 0) continue;
    if (node.graceUntil !== null && node.graceUntil <= now && (node.decayScore ?? 1) < MID_DECAY_FLOOR) {
      nodes.delete(node.id);
      removedMids.push(node.id);
      // Keep the parent's child count truthful: the UI draws history from this
      // number, and a root that still claims a pruned child would be a lie.
      const parent = nodes.get(node.parentId);
      if (parent) parent.childCount = Math.max(0, parent.childCount - 1);
    }
  }
  return { tree: { ...tree, nodes }, removedLeaves, removedMids, consumed: batch.length, remaining: Math.max(0, queue.length - batch.length) };
}

/**
 * Carry history forward across maintenance runs.
 *
 * A full rebuild only knows the LIVE events, so a node whose last reference just
 * disappeared would vanish in the same pass — leaf, mid and all — and the layered
 * lifecycle (`leaf dies -> mid ghosts -> mid dies after grace -> root stays`) could
 * never be observed or shown as a ghost. The previous derived tree supplies that
 * history: every node absent from the live rebuild is merged back with refCount 0.
 *
 * The previous tree is a DERIVED CACHE, never a truth source. Deleting
 * `state/tag-tree.json` loses the ghost history and nothing else; the next rebuild
 * reconstructs the live tree from the index alone.
 *
 * Orphans are dropped, never repaired: a carried child whose parent is missing
 * would be unreachable and must not masquerade as a root.
 */
export function mergePreviousTree(liveTree, previousTree, { now = 0, midGracePeriodDays = 30 } = {}) {
  const nodes = liveTree.nodes;
  const carried = [];
  if (!previousTree || !(previousTree.nodes instanceof Map)) return { carried, tree: liveTree };
  for (const [id, node] of previousTree.nodes) {
    if (!node || node.id !== id || typeof id !== 'string') continue;
    if (nodes.has(id)) continue; // live data wins: fresh counts, cleared grace
    nodes.set(id, { ...node, refCount: 0, childCount: 0 });
    carried.push(id);
  }
  // Drop orphans until stable: a chain can be several levels deep.
  let removed = true;
  while (removed) {
    removed = false;
    for (const [id, node] of nodes) {
      if (node.parentId === null || node.parentId === undefined) continue;
      if (nodes.has(node.parentId)) continue;
      nodes.delete(id);
      removed = true;
    }
  }
  // Child counts are derived for the MERGED tree, never carried from the file.
  for (const node of nodes.values()) node.childCount = 0;
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (parent) parent.childCount += 1;
  }
  // A carried mid whose last child is already gone enters its grace window now,
  // so it can be revived by a new leaf before the deadline.
  for (const id of carried) {
    const node = nodes.get(id);
    if (!node || node.level !== 'mid') continue;
    if (node.childCount > 0 || node.refCount > 0) continue;
    if (node.graceUntil === null || node.graceUntil === undefined) {
      node.graceUntil = now + midGracePeriodDays * DAY_MS;
    }
  }
  const kept = carried.filter((id) => nodes.has(id));
  kept.sort((a, b) => a.localeCompare(b));
  return { carried: kept, tree: liveTree };
}

/**
 * Leaves whose reference count is zero are dead — every live event that mounted
 * them is gone. They become queue entries the bounded prune pass consumes; the
 * queue is what lets 10k dead leaves drain over several runs instead of one storm.
 */
export function queueDeadLeaves(tree, { now = 0 } = {}) {
  const queue = [];
  for (const node of tree.nodes.values()) {
    if (node.level !== 'leaf') continue;
    if (node.refCount > 0) continue;
    queue.push({ id: node.id, queuedBy: 'release', at: now });
  }
  queue.sort((a, b) => a.id.localeCompare(b.id));
  return queue;
}

/** UI/recall view: ghosts are mids inside their grace window. */
export function ghostMids(tree, now = 0) {
  return [...tree.nodes.values()]
    .filter((node) => node.level === 'mid' && node.graceUntil !== null && node.graceUntil > now)
    .map((node) => ({ id: node.id, name: node.name, graceUntil: node.graceUntil, refCount: node.refCount }));
}

/**
 * Classify one hit: 'direct' wins whenever a flat tag or a leaf tag matched.
 * Only a hit that reached us purely through a ghost mid is degraded to metadata.
 */
export function classifyHit(tags = [], ghostMids = []) {
  const ghostNames = new Set(ghostMids.map((mid) => mid.name));
  let pathOnly = false;
  for (const tag of tags) {
    const path = parseTagPath(tag);
    if (!path) return 'direct'; // flat tag: always direct
    if (path.leaf) return 'direct'; // direct leaf hit: never degraded
    if (path.mid && ghostNames.has(path.mid)) pathOnly = true;
  }
  return pathOnly ? 'path-only' : 'direct';
}
