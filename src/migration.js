/**
 * Data-directory migration (legacy `<DSH_HOME>/.dsh-memory` -> `<DSH_HOME>/memory`).
 *
 * Contract:
 *   1. Copy with `fs.cpSync` into a directory that is EMPTY (or absent).
 *   2. Verify the copy with the SAME counter the business code uses
 *      (`LogStore.status().recordCount`, i.e. records in the append-only log —
 *      rejected payloads live in the DLQ and are not log records, so they are
 *      excluded by construction, not by a second ad-hoc count).
 *   3. Write `.migration-complete` LAST. Its presence is the proof that the copy
 *      finished; its absence with data present means a previous run died halfway.
 *   4. Never delete the source. The old directory stays as a backup until a human
 *      removes it (README documents the command).
 *
 * Interrupted state is a hard error (`CONFIG_MIGRATION_INTERRUPTED`): re-copying
 * over a half-written directory is how two stores get silently blended.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryError, ErrorCodes } from './errors.js';
import { LogStore } from './log/logStore.js';
import { ensureDir, writeJsonAtomic } from './util.js';

export const MIGRATION_MARKER = '.migration-complete';
/** A lock older than this is considered abandoned (process crashed). */
const LOCK_STALE_MS = 10 * 60 * 1000;

/** In-process locks: two Memory instances in one process cannot race each other. */
const ACTIVE_LOCKS = new Set();

export function migrationMarkerPath(dataDir) {
  return path.join(dataDir, MIGRATION_MARKER);
}

/** Is `dir` an existing, non-empty data directory (marker excluded)? */
export function dataDirHasData(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  return entries.some((entry) => entry.name !== MIGRATION_MARKER && entry.name !== '.migration.lock');
}

export function readMigrationState(dir) {
  const markerFile = migrationMarkerPath(dir);
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new MemoryError(ErrorCodes.CONFIG_MIGRATION_MISMATCH, 'migration marker is not valid JSON', {
        file: markerFile,
        message: err.message,
      });
    }
  }
  return { complete: raw !== null, marker: raw, path: markerFile };
}

/** Business-identical count: records in the append-only log, nothing else. */
export async function logRecordCount(dir) {
  // `dir` is a data directory; the append-only log lives in `<dir>/log`.
  const store = new LogStore({ root: path.join(dir, 'log') });
  const status = await store.status();
  return { recordCount: status.recordCount, generation: status.gen ?? null, segments: status.segments };
}

function lockedError(to) {
  return new MemoryError(ErrorCodes.CONFIG_MIGRATION_LOCKED, `another migration is already writing to ${to}`, {
    dataDir: to,
    hint: 'wait for the running migration, or remove a stale <dataDir>.migration.lock if no process is alive',
  });
}

/**
 * Is a process with this pid still alive?
 *
 * `process.kill(pid, 0)` sends no signal: it only asks the OS whether the pid
 * exists. EPERM means "exists but is not ours", which still counts as alive —
 * treating it as dead would let us steal a lock from a live process.
 */
export function isProcessAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Read a lock file's payload; `null` when it is missing or unparsable. */
export function readLockOwner(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  } catch {
    return null;
  }
}

function acquireLock(to) {
  if (ACTIVE_LOCKS.has(to)) throw lockedError(to);
  const lockFile = `${to}.migration.lock`;
  let existing = null;
  try {
    const stat = fs.statSync(lockFile);
    existing = { stat, owner: readLockOwner(lockFile) };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (existing) {
    const owner = existing.owner;
    // Two independent facts decide ownership: pid liveness (authoritative) and
    // age (fallback for lock files written before pids were recorded).
    const alive = owner ? isProcessAlive(owner.pid) : Date.now() - existing.stat.mtimeMs < LOCK_STALE_MS;
    if (alive) throw lockedError(to);
    fs.rmSync(lockFile, { force: true });
  }
  ACTIVE_LOCKS.add(to);
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: process.pid, at: Date.now(), host: os.hostname() }),
      { flag: 'wx' },
    );
  } catch (err) {
    ACTIVE_LOCKS.delete(to);
    if (err.code === 'EEXIST') throw lockedError(to);
    throw err;
  }
  // try/finally at the call site is the only guaranteed release; this disposer is
  // idempotent so a thrown release cannot mask the migration's own error.
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ACTIVE_LOCKS.delete(to);
    try {
      fs.rmSync(lockFile, { force: true });
    } catch {
      /* best effort: pid liveness will clear it on the next attempt */
    }
  };
}

/**
 * @param {object} opts
 * @param {string|null} opts.from legacy directory (config.migrateFrom)
 * @param {string} opts.to target dataDir
 * @param {{now(): number}} opts.clock injected clock (records `at`)
 * @returns {Promise<{status:'disabled'|'no-source'|'already-migrated'|'migrated',
 *                    recordCount?: number, from?: string, to?: string, at?: number}>}
 */
export async function migrateDataDir({ from, to, clock }) {
  if (!from) return { status: 'disabled' };
  const source = path.resolve(from);
  const target = path.resolve(to);
  if (source === target) {
    throw new MemoryError(ErrorCodes.CONFIG_MIGRATION_MISMATCH, 'migrateFrom and dataDir are the same directory', {
      from: source,
    });
  }
  if (!fs.existsSync(source)) return { status: 'no-source', from: source, to: target };

  // A source without a log is not a memory store: refuse rather than copy junk.
  if (!fs.existsSync(path.join(source, 'log', 'CURRENT'))) {
    throw new MemoryError(ErrorCodes.CONFIG_MIGRATION_MISMATCH, 'migrateFrom does not look like a memory store', {
      from: source,
      expected: 'log/CURRENT',
    });
  }

  const release = acquireLock(target);
  try {
    const targetHasData = dataDirHasData(target);
    const state = readMigrationState(target);
    if (targetHasData) {
      if (state.complete) return { status: 'already-migrated', from: source, to: target, marker: state.marker };
      throw new MemoryError(
        ErrorCodes.CONFIG_MIGRATION_INTERRUPTED,
        'target data directory already has data but no .migration-complete marker: a previous migration did not finish',
        {
          dataDir: target,
          hint: 'inspect the directory; delete it to restart the migration, or write the marker manually if the copy is known good',
        },
      );
    }

    ensureDir(path.dirname(target));
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: true, errorOnExist: false });

    const sourceCount = await logRecordCount(source);
    const targetCount = await logRecordCount(target);
    if (sourceCount.recordCount !== targetCount.recordCount) {
      throw new MemoryError(
        ErrorCodes.CONFIG_MIGRATION_MISMATCH,
        `migrated record count ${targetCount.recordCount} does not match source ${sourceCount.recordCount}`,
        { from: source, to: target, source: sourceCount, target: targetCount },
      );
    }

    const at = clock.now();
    const marker = {
      plugin: 'dsh-memory',
      from: source,
      to: target,
      recordCount: targetCount.recordCount,
      generation: targetCount.generation,
      at,
      methodology: 'LogStore.status().recordCount (append-only log records; DLQ/placeholder rows excluded)',
    };
    writeJsonAtomic(migrationMarkerPath(target), marker);
    return { status: 'migrated', from: source, to: target, recordCount: marker.recordCount, at, kept: true };
  } finally {
    release();
  }
}
