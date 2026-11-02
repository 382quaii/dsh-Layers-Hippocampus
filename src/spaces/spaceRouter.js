/**
 * Multi-space routing — the physical layer of v1.5.0.
 *
 * A "space" is its own memory root directory (log, index, state, semantic) with
 * its own Memory handle. This router owns nothing semantic: it maps a space id to
 * a handle and guarantees the one concurrency contract the rest of the plugin
 * needs:
 *
 *   - operations on ONE space are serialised FIFO (a space is an append log),
 *   - operations on DIFFERENT spaces run concurrently (they share no file).
 *
 * A single global lock would be simpler but wrong: it turns two independent
 * spaces into one queue and reintroduces the cross-space stalls that spaces exist
 * to remove. `run()` therefore keeps one promise chain PER space id.
 *
 * Why a promise chain instead of a boolean "busy" flag: a chain queues every
 * caller without spinning, and it survives a rejected task (the chain swallows the
 * rejection so the next op still runs; the caller still receives the rejection).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ErrorCodes, MemoryError } from '../errors.js';

/** The owner's own root directory. Every data dir has one implicit space. */
export const DEFAULT_SPACE_ID = 'default';

/**
 * Space ids become DIRECTORY NAMES, so the pattern is deliberately narrow:
 *   - must start alphanumeric: no `.` / `..`, so `spaceDir()` cannot climb out;
 *   - no path separators (they are not in the class), so no traversal;
 *   - lowercase only: Windows paths are case-insensitive, so `Alpha` and `alpha`
 *     would silently alias the same directory on one OS and differ on another.
 */
export const SPACE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Device names Windows refuses (or aliases) as directory names. They are valid
 * against SPACE_ID_PATTERN but would either fail the mkdir with a raw IO error or
 * silently resolve to a device — exactly the sort of thing that must be a clean
 * MEM_E_SPACE_INVALID instead of a filesystem surprise.
 */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Validate a space id the caller wants to CREATE (not merely route to).
 *
 * Stricter than `normaliseSpaceId` on purpose:
 *   - `default` always exists -> conflict, not a valid creation;
 *   - trailing dot is an alias on Windows (`work.` == `work`);
 *   - Windows device names are reserved.
 *
 * Fail-Fast: every rejection is `MEM_E_SPACE_INVALID` (HTTP 400), and nothing
 * reaches the filesystem or a JSONL file.
 */
export function validateNewSpaceId(value) {
  if (typeof value !== 'string') {
    throw new MemoryError(ErrorCodes.SPACE_INVALID, 'space id must be a string', { got: typeof value });
  }
  const id = value.trim();
  if (!id) throw new MemoryError(ErrorCodes.SPACE_INVALID, 'space id must not be empty');
  if (id === DEFAULT_SPACE_ID) {
    throw new MemoryError(ErrorCodes.SPACE_INVALID, 'the default space always exists and cannot be created', { spaceId: id, reason: 'conflict' });
  }
  if (!SPACE_ID_PATTERN.test(id)) {
    throw new MemoryError(ErrorCodes.SPACE_INVALID, `invalid space id: ${JSON.stringify(id)}`, {
      spaceId: id,
      pattern: SPACE_ID_PATTERN.source,
      hint: 'lowercase letter/digit start; only a-z 0-9 . _ -; max 64 chars',
    });
  }
  if (id.endsWith('.')) {
    throw new MemoryError(ErrorCodes.SPACE_INVALID, 'space id must not end with a dot (Windows alias)', { spaceId: id, reason: 'reserved' });
  }
  if (WINDOWS_DEVICE.test(id.split('.')[0])) {
    throw new MemoryError(ErrorCodes.SPACE_INVALID, `space id is a reserved device name: ${JSON.stringify(id)}`, { spaceId: id, reason: 'reserved' });
  }
  return id;
}

/**
 * Canonicalise a user-supplied space id.
 *
 * Omitted / null / empty means "the default space" — callers may pass an absent
 * option rather than having to branch. Anything else must be a string that
 * matches SPACE_ID_PATTERN; invalid input is a programming error, so it throws a
 * MemoryError instead of being silently downgraded to `default` (silently
 * routing a typo to the default space would write memories into the wrong log).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normaliseSpaceId(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_SPACE_ID;
  if (typeof value !== 'string') {
    throw new MemoryError(ErrorCodes.INVALID_INPUT, 'space id must be a string', { got: typeof value });
  }
  if (value === DEFAULT_SPACE_ID) return DEFAULT_SPACE_ID;
  if (!SPACE_ID_PATTERN.test(value)) {
    throw new MemoryError(ErrorCodes.INVALID_INPUT, `invalid space id: ${JSON.stringify(value)}`, {
      pattern: SPACE_ID_PATTERN.source,
    });
  }
  // Belt and braces: the pattern already forbids a leading dot and both path
  // separators, but this is the check that actually keeps spaceDir() inside
  // dataDir if the pattern is ever relaxed.
  if (value === '..' || value.includes('/') || value.includes('\\')) {
    throw new MemoryError(ErrorCodes.INVALID_INPUT, `invalid space id: ${JSON.stringify(value)}`, { reason: 'path' });
  }
  return value;
}

/**
 * @typedef {object} SpaceHandle a Memory-like child handle
 * @property {Function} [close]
 */

export class SpaceRouter {
  /**
   * @param {object}   options
   * @param {object}   options.owner     Memory instance that owns the default space
   * @param {string}   options.dataDir   root data directory (the default space's dir)
   * @param {Function} options.openChild async (childDir) => initialised child handle
   */
  constructor({ owner, dataDir, openChild } = {}) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new MemoryError(ErrorCodes.INVALID_INPUT, 'SpaceRouter requires dataDir');
    }
    if (typeof openChild !== 'function') {
      throw new MemoryError(ErrorCodes.INVALID_INPUT, 'SpaceRouter requires openChild(dir)');
    }
    this.owner = owner ?? null;
    this.dataDir = path.resolve(dataDir);
    this.openChild = openChild;
    /** @type {Map<string, Promise<SpaceHandle>>} opened child handles, by id */
    this._memories = new Map();
    /** @type {Map<string, Promise<unknown>>} per-space FIFO tails */
    this._chains = new Map();
    /** @type {Map<string, number>} queued + in-flight ops, by id */
    this._pendingOps = new Map();
  }

  get spacesDir() {
    return path.join(this.dataDir, 'spaces');
  }

  /** Directory that backs one space. `default` is the owner's own dataDir. */
  spaceDir(spaceId) {
    const id = normaliseSpaceId(spaceId);
    return id === DEFAULT_SPACE_ID ? this.dataDir : path.join(this.spacesDir, id);
  }

  /**
   * Handle for a space. The default space is the owner; a child is opened lazily
   * ONCE and the PROMISE (not the handle) is cached, so concurrent callers share a
   * single open instead of racing two Memory instances onto one directory.
   * A failed open is removed from the cache so a later call can retry.
   *
   * @param {string} spaceId
   * @returns {Promise<SpaceHandle>}
   */
  async memoryFor(spaceId) {
    const id = normaliseSpaceId(spaceId);
    if (id === DEFAULT_SPACE_ID) return this.owner;
    const cached = this._memories.get(id);
    if (cached) return cached;
    const opening = Promise.resolve()
      .then(() => this.openChild(this.spaceDir(id)))
      .then((handle) => {
        if (!handle) {
          throw new MemoryError(ErrorCodes.INVALID_INPUT, `openChild returned no handle for space ${id}`, { id });
        }
        return handle;
      })
      .catch((error) => {
        // Do not poison the cache with a transient failure: the next call retries.
        if (this._memories.get(id) === opening) this._memories.delete(id);
        throw error;
      });
    this._memories.set(id, opening);
    return opening;
  }

  /**
   * Spaces visible on disk: 'default' first, then matching child directories
   * sorted by name. Synchronous on purpose — the status panel renders it on every
   * poll and must not await a directory scan. A missing spaces/ dir simply means
   * no child space has ever been opened.
   *
   * @returns {string[]}
   */
  all() {
    const ids = [DEFAULT_SPACE_ID];
    let entries;
    try {
      entries = fs.readdirSync(this.spacesDir, { withFileTypes: true });
    } catch {
      return ids;
    }
    const children = entries
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name !== DEFAULT_SPACE_ID && SPACE_ID_PATTERN.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    return ids.concat(children);
  }

  _incPending(id) {
    this._pendingOps.set(id, (this._pendingOps.get(id) ?? 0) + 1);
  }

  _decPending(id) {
    const left = (this._pendingOps.get(id) ?? 0) - 1;
    if (left <= 0) this._pendingOps.delete(id);
    else this._pendingOps.set(id, left);
  }

  /**
   * Run `task(memory, id)` serialised against every other op on the SAME space.
   * Different ids own different chains, so they never block each other.
   *
   * The stored tail is settled-and-swallowed (`then(() => undefined, ...)`): a
   * rejected task must not block the queue behind it, and the stored promise must
   * never be an unhandled rejection. The caller's promise still rejects.
   *
   * @param {string} spaceId
   * @param {(memory: SpaceHandle, id: string) => unknown} task
   * @returns {Promise<unknown>}
   */
  run(spaceId, task) {
    const id = normaliseSpaceId(spaceId);
    if (typeof task !== 'function') {
      throw new MemoryError(ErrorCodes.INVALID_INPUT, 'SpaceRouter.run requires a task function', { id });
    }
    const prev = this._chains.get(id) ?? Promise.resolve();
    const next = prev.then(() => this.memoryFor(id)).then((memory) => task(memory, id));
    this._chains.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    this._incPending(id);
    next.then(
      () => this._decPending(id),
      () => this._decPending(id),
    );
    return next;
  }

  /**
   * Run one task across several spaces under a deterministic lock order.
   *
   * The ids are normalised, deduped and SORTED before acquisition. Acquiring in
   * sorted order makes an ABBA deadlock impossible: both `runMany(['a','b'])` and
   * `runMany(['b','a'])` take a first, so they cannot hold one and wait for the
   * other. Acquisition is nested (a is held while b is acquired), which is what
   * makes the handoff atomic from the caller's point of view.
   *
   * @param {string[]} spaceIds
   * @param {(memories: Map<string, SpaceHandle>) => unknown} task
   * @returns {Promise<unknown>}
   */
  runMany(spaceIds, task) {
    if (typeof task !== 'function') {
      throw new MemoryError(ErrorCodes.INVALID_INPUT, 'SpaceRouter.runMany requires a task function');
    }
    const ids = [...new Set((spaceIds ?? []).map((spaceId) => normaliseSpaceId(spaceId)))].sort((a, b) =>
      a.localeCompare(b),
    );
    const acquire = (index, held) => {
      if (index >= ids.length) return task(held);
      const id = ids[index];
      return this.run(id, (memory) => {
        const nextHeld = new Map(held);
        nextHeld.set(id, memory);
        return acquire(index + 1, nextHeld);
      });
    };
    return Promise.resolve().then(() => acquire(0, new Map()));
  }

  /** Queue depth + open child ids; synchronous, so status polling never awaits. */
  status() {
    return {
      available: true,
      ids: this.all(),
      open: [...this._memories.keys()].sort(),
      defaultSpaceId: DEFAULT_SPACE_ID,
    };
  }

  /** Number of queued + in-flight operations for one space (tests/observability). */
  pending(spaceId) {
    return this._pendingOps.get(normaliseSpaceId(spaceId)) ?? 0;
  }

  /**
   * Close every child handle. The OWNER is not closed here: it belongs to the
   * plugin lifecycle, and closing it from a router would double-close the default
   * space during shutdown. A child that fails to close must not stop the others.
   */
  async closeAll() {
    const openings = [...this._memories.entries()];
    this._memories.clear();
    this._chains.clear();
    this._pendingOps.clear();
    const errors = [];
    for (const [id, opening] of openings) {
      try {
        const handle = await opening;
        if (typeof handle?.close === 'function') await handle.close();
      } catch (error) {
        errors.push({ id, error: error?.code ?? String(error) });
      }
    }
    return { closed: openings.length - errors.length, errors };
  }
}
