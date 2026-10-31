/**
 * UI-triggered data migration: a BACKGROUND job, never a blocking request.
 *
 * `POST /config { dataDir }` validates the path, takes a lock, returns 202, and
 * the copy runs here with `fs.promises.cp`. Progress is written to
 * `state/migration.json` so `/stats` can render it; the plugin keeps serving the
 * OLD store until verification passes. On mismatch the target (only if this run
 * created it) is removed and the old store stays authoritative.
 */

import fs from 'node:fs';
import path from 'node:path';
import { MemoryError, ErrorCodes } from './errors.js';
import { isProcessAlive, logRecordCount, readLockOwner, dataDirHasData } from './migration.js';
import { ensureDir, writeJsonAtomic } from './util.js';

export const MIGRATION_SCHEMA = 1;
export const TARGET_MARKER = '.migration-target';
const ABSOLUTE = /^([A-Za-z]:[\\/]|\\\\|\/)/;

/** Path validation shared by the runner and its tests. */
export function validateMigrationPaths({ from, to }) {
  if (typeof to !== 'string' || !to.trim()) {
    throw new MemoryError(ErrorCodes.MIGRATION_PATH, 'dataDir must be a non-empty string');
  }
  if (!ABSOLUTE.test(to)) {
    throw new MemoryError(ErrorCodes.MIGRATION_PATH, 'dataDir must be an absolute path', { got: to });
  }
  const source = path.resolve(from);
  const target = path.resolve(to);
  if (source === target) throw new MemoryError(ErrorCodes.MIGRATION_PATH, 'target equals the current dataDir', { source, target });
  const relative = path.relative(source, target);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new MemoryError(ErrorCodes.MIGRATION_PATH, 'target must not live inside the current dataDir', { source, target });
  }
  const back = path.relative(target, source);
  if (back && !back.startsWith('..') && !path.isAbsolute(back)) {
    throw new MemoryError(ErrorCodes.MIGRATION_PATH, 'the current dataDir must not live inside the target', { source, target });
  }
  if (/^([A-Za-z]:[\\/]?)$/.test(target) || target === path.parse(target).root) {
    throw new MemoryError(ErrorCodes.MIGRATION_PATH, 'refusing to use a filesystem root as dataDir', { target });
  }
  return { source, target };
}

async function directoryBytes(dir) {
  let total = 0;
  const walk = async (current) => {
    let entries = [];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) total += (await fs.promises.stat(full)).size;
      } catch {
        // vanished mid-walk
      }
    }
  };
  await walk(dir);
  return total;
}

export class MigrationRunner {
  /**
   * @param {object} options
   * @param {string} options.stateFile   state/migration.json
   * @param {object} options.clock
   * @param {object|null} [options.logger]
   * @param {Function} [options.copy]     injectable for tests
   */
  constructor({ stateFile, clock, logger = null, copy = null }) {
    this.stateFile = stateFile;
    this.clock = clock;
    this.logger = logger;
    this.copy = copy ?? ((from, to) => fs.promises.cp(from, to, { recursive: true, force: false, errorOnExist: false }));
    this.running = null;
    this.lockFile = null;
  }

  read() {
    try {
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && parsed.schema === MIGRATION_SCHEMA ? parsed : null;
    } catch {
      return null;
    }
  }

  write(state) {
    writeJsonAtomic(this.stateFile, { schema: MIGRATION_SCHEMA, updatedAt: this.clock.now(), ...state });
  }

  /** Synchronous lock acquisition: two concurrent UI requests cannot both win. */
  acquire(target) {
    const lockFile = `${target}.migration.lock`;
    let existing = null;
    try {
      existing = { stat: fs.statSync(lockFile), owner: readLockOwner(lockFile) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing) {
      const alive = existing.owner ? isProcessAlive(existing.owner.pid) : false;
      if (alive) {
        throw new MemoryError(ErrorCodes.MIGRATION_LOCKED, 'another migration is already running', {
          lockFile,
          pid: existing.owner?.pid ?? null,
        });
      }
      fs.rmSync(lockFile, { force: true });
    }
    ensureDir(path.dirname(lockFile));
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: this.clock.now() }), { flag: 'wx' });
    } catch (error) {
      if (error.code === 'EEXIST') throw new MemoryError(ErrorCodes.MIGRATION_LOCKED, 'another migration is already running', { lockFile });
      throw error;
    }
    this.lockFile = lockFile;
    return lockFile;
  }

  release() {
    if (this.lockFile) {
      try {
        fs.rmSync(this.lockFile, { force: true });
      } catch {
        // best effort
      }
      this.lockFile = null;
    }
  }

  /**
   * Start the job. Returns immediately with the job descriptor; the caller's HTTP
   * request must not wait on the copy.
   */
  start({ from, to, timeoutMs = 600_000, onSuccess = null, onFailure = null }) {
    if (this.running) {
      throw new MemoryError(ErrorCodes.MIGRATION_LOCKED, 'another migration is already running', { id: this.running.id });
    }
    const { source, target } = validateMigrationPaths({ from, to });
    this.acquire(target);
    const id = `mig_${this.clock.now().toString(36)}`;
    const state = {
      id,
      status: 'running',
      phase: 'copying',
      from: source,
      to: target,
      startedAt: this.clock.now(),
      copiedBytes: 0,
      totalBytes: null,
      error: null,
    };
    this.write(state);
    this.running = { id, state };
    const job = this.run({ id, source, target, timeoutMs, onSuccess, onFailure });
    // The promise is observed internally; callers poll `read()`.
    job.catch(() => {});
    return this.read();
  }

  async run({ id, source, target, timeoutMs, onSuccess, onFailure }) {
    const started = this.clock.now();
    let createdTarget = false;
    try {
      if (dataDirHasData(target)) {
        throw new MemoryError(ErrorCodes.MIGRATION_TARGET_BUSY, 'target already contains a memory store', { target });
      }
      const totalBytes = await directoryBytes(source);
      this.write({ ...this.read(), totalBytes });
      ensureDir(target);
      createdTarget = true;
      await fs.promises.writeFile(path.join(target, TARGET_MARKER), id, 'utf8');

      const copyPromise = this.copy(source, target);
      const timeout = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new MemoryError(ErrorCodes.MIGRATION_TIMEOUT, `migration exceeded ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      });
      await Promise.race([copyPromise, timeout]);
      if (this.clock.now() - started > timeoutMs) {
        throw new MemoryError(ErrorCodes.MIGRATION_TIMEOUT, `migration exceeded ${timeoutMs}ms`);
      }

      this.write({ ...this.read(), phase: 'verifying', copiedBytes: totalBytes });
      const sourceCount = await logRecordCount(source);
      const targetCount = await logRecordCount(target);
      if (sourceCount.recordCount !== targetCount.recordCount) {
        throw new MemoryError(ErrorCodes.MIGRATION_MISMATCH, 'record count mismatch after copy', {
          from: source,
          to: target,
          sourceRecords: sourceCount.recordCount,
          targetRecords: targetCount.recordCount,
        });
      }
      fs.writeFileSync(path.join(target, '.migration-complete'), JSON.stringify({ id, at: this.clock.now(), source, target }));
      const done = { ...this.read(), status: 'ready', phase: 'done', finishedAt: this.clock.now(), copiedBytes: totalBytes };
      this.write(done);
      if (typeof onSuccess === 'function') await onSuccess({ ...done });
      return done;
    } catch (error) {
      // Roll back only a target this run created; never touch a pre-existing dir.
      if (createdTarget) {
        try {
          await fs.promises.rm(target, { recursive: true, force: true });
        } catch {
          // best effort; the marker makes a manual cleanup unambiguous
        }
      }
      const failed = {
        ...this.read(),
        status: 'failed',
        phase: 'failed',
        finishedAt: this.clock.now(),
        error: { code: error.code ?? ErrorCodes.MIGRATION_IO, message: error.message },
      };
      this.write(failed);
      this.logger?.warn?.(`hippocampus: migration failed: ${error.message}`);
      if (typeof onFailure === 'function') await onFailure(failed);
      return failed;
    } finally {
      this.running = null;
      this.release();
    }
  }
}
