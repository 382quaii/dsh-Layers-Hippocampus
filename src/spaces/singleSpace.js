/**
 * Strict single-space core (v1.5.6 physical split).
 *
 * The multi-space router and the cross-space transfer engine now live in
 * `dsh-orchestrator`; this package compiles ONLY the owner's own space. The public
 * shape (`SpaceRouter` methods, `normaliseSpaceId`, `validateNewSpaceId`) is kept so
 * the rest of the engine and the existing tool/config surface keep working, but any
 * operation that names a second space fails fast with **MEM_E_FEATURE_DISABLED** —
 * never by silently routing to `default`.
 *
 * Installing `dsh-orchestrator` is what upgrades this core: its adapter is injected
 * through `Memory.open({ spaces })` and then named spaces work again.
 */

import path from 'node:path';
import { ErrorCodes, MemoryError } from '../errors.js';

/** The owner's own root directory. Every data dir has exactly one implicit space. */
export const DEFAULT_SPACE_ID = 'default';

/** Kept for input validation: space ids become directory names when multi-space exists. */
export const SPACE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Canonicalise a user-supplied space id. `default` (or omitted) is the only routable
 * id in the core; a valid-but-foreign id is a missing CAPABILITY, not a typo, so it
 * throws MEM_E_FEATURE_DISABLED with an actionable hint.
 */
export function normaliseSpaceId(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_SPACE_ID;
  if (typeof value !== 'string') {
    throw new MemoryError(ErrorCodes.INVALID_INPUT, 'space id must be a string', { got: typeof value });
  }
  if (value === DEFAULT_SPACE_ID) return DEFAULT_SPACE_ID;
  if (!SPACE_ID_PATTERN.test(value) || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new MemoryError(ErrorCodes.INVALID_INPUT, `invalid space id: ${JSON.stringify(value)}`, {
      pattern: SPACE_ID_PATTERN.source,
    });
  }
  throw new MemoryError(
    ErrorCodes.FEATURE_DISABLED,
    'multi-space routing is not part of the hippocampus core; install dsh-orchestrator to enable it',
    { spaceId: value, capability: 'multiSpace' },
  );
}

/** Creating a space is inherently a multi-space capability. */
export function validateNewSpaceId(value) {
  return normaliseSpaceId(value);
}

/**
 * Drop-in replacement for the v1.5.0 `SpaceRouter` with one space. The owner is the
 * `default` handle; there is no per-space FIFO chain because a single append log has
 * exactly one writer (the engine already serialises it).
 */
export class SingleSpaceManager {
  constructor({ owner = null, dataDir } = {}) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new MemoryError(ErrorCodes.INVALID_INPUT, 'SingleSpaceManager requires dataDir');
    }
    this.owner = owner;
    this.dataDir = path.resolve(dataDir);
    this.spacesDir = path.join(this.dataDir, 'spaces');
  }

  spaceDir(spaceId) {
    const id = normaliseSpaceId(spaceId);
    return id === DEFAULT_SPACE_ID ? this.dataDir : path.join(this.spacesDir, id);
  }

  async memoryFor(spaceId) {
    const id = normaliseSpaceId(spaceId);
    if (id === DEFAULT_SPACE_ID) return this.owner;
    // normaliseSpaceId already threw; this is unreachable belt-and-braces.
    throw new MemoryError(ErrorCodes.FEATURE_DISABLED, 'named spaces are not available', { spaceId: id });
  }

  all() {
    return [DEFAULT_SPACE_ID];
  }

  status() {
    return {
      available: false,
      multiSpace: false,
      ids: [DEFAULT_SPACE_ID],
      open: [],
      defaultSpaceId: DEFAULT_SPACE_ID,
    };
  }

  run(spaceId, task) {
    const id = normaliseSpaceId(spaceId);
    if (typeof task !== 'function') {
      throw new MemoryError(ErrorCodes.INVALID_INPUT, 'SingleSpaceManager.run requires a task function', { id });
    }
    return Promise.resolve().then(() => task(this.owner, id));
  }

  runMany(spaceIds, task) {
    const ids = [...new Set((spaceIds ?? []).map((spaceId) => normaliseSpaceId(spaceId)))];
    if (typeof task !== 'function') {
      throw new MemoryError(ErrorCodes.INVALID_INPUT, 'SingleSpaceManager.runMany requires a task function');
    }
    return Promise.resolve().then(() => task(new Map([[DEFAULT_SPACE_ID, this.owner]])));
  }

  pending() {
    return 0;
  }

  async closeAll() {
    return { closed: 0, errors: [] };
  }

  /** Named-space deletion is a multi-space capability (the core has only `default`). */
  async deleteSpace(spaceId) {
    const id = normaliseSpaceId(spaceId);
    // normaliseSpaceId already threw for a named id; this is unreachable in practice.
    throw new MemoryError(ErrorCodes.FEATURE_DISABLED, 'space deletion requires dsh-orchestrator', {
      spaceId: id,
      capability: 'multiSpace',
    });
  }
}

/** Backwards-compatible alias for the old import site in memory.js. */
export const SpaceRouter = SingleSpaceManager;
