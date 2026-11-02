/**
 * Append-only, segmented, generation-addressed event log — the truth source.
 *
 * Layout:
 *   <root>/CURRENT                 -> "gen-000007"
 *   <root>/gen-000007/manifest.json
 *   <root>/gen-000007/seg-000001.jsonl
 *
 * Invariants
 *   - A record, once written, is never edited. Corrections are new records.
 *   - A published generation is immutable. Mutating the log (physical delete,
 *     compaction) means building the *next* generation and atomically swapping the
 *     CURRENT pointer, so a concurrent reader keeps a coherent snapshot.
 *   - Appends go to the newest segment of the current generation. A generation may
 *     grow; it is only ever *replaced*, never rewritten in place.
 *   - Readers address records by `event_id`, never by (file, line). Compaction
 *     changes every line number in the log, and nothing breaks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { MemoryError, ErrorCodes } from '../errors.js';
import {
  appendLineDurable,
  ensureDir,
  genNumber,
  listGenerations,
  nextGenerationName,
  readJson,
  readText,
  sha256,
  writeFileAtomic,
  writeJsonAtomic,
  Mutex,
  fsyncDir,
} from '../util.js';
import { parseRecord, serialiseRecord } from './records.js';

const LOG_MANIFEST = 'manifest.json';
/** Max interval between manifest/fsync checkpoints on the append hot path. */
const FLUSH_INTERVAL_MS = 200;

function segmentName(index) {
  return `seg-${String(index).padStart(6, '0')}.jsonl`;
}

export class LogStore {
  /**
   * @param {object} opts
   * @param {string} opts.root log root (e.g. <dataDir>/log)
   * @param {string} [opts.archiveRoot] cold retention root (e.g. <dataDir>/archive)
   * @param {number} [opts.maxSegmentRecords]
   */
  constructor({ root, archiveRoot = null, maxSegmentRecords = 5000 }) {
    this.root = root;
    this.archiveRoot = archiveRoot;
    this.maxSegmentRecords = maxSegmentRecords;
    this._mutex = new Mutex();
    this._manifestCache = new Map(); // gen -> manifest
    // Hot-path append state: one open handle, one deferred manifest checkpoint.
    // Records land in the OS page cache synchronously (visible to every reader in
    // this process); fsync + manifest are checkpointed at most every
    // FLUSH_INTERVAL_MS, on close(), and before any rewrite/compaction.
    this._appendFd = null;
    this._appendHandleKey = null;
    this._manifestDirty = false;
    this._flushTimer = null;
    ensureDir(root);
  }

  _closeAppendHandle() {
    if (this._appendFd !== null) {
      try {
        fs.closeSync(this._appendFd);
      } catch {
        /* already closed */
      }
      this._appendFd = null;
    }
    this._appendHandleKey = null;
  }

  _appendChunk(gen, segment, chunk) {
    const key = `${gen}/${segment}`;
    if (this._appendHandleKey !== key) {
      this._closeAppendHandle();
      this._appendFd = fs.openSync(path.join(this.generationPath(gen), segment), 'a');
      this._appendHandleKey = key;
    }
    fs.writeSync(this._appendFd, chunk);
  }

  /** Durability checkpoint: fsync the open segment and publish the manifest. */
  flushSync() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._appendFd !== null) {
      try {
        fs.fsyncSync(this._appendFd);
      } catch {
        /* best effort: a read-only or vanished handle must not break the append path */
      }
    }
    if (!this._manifestDirty) return;
    const gen = this.currentGeneration();
    if (!gen) return;
    const manifest = this._manifestCache.get(gen) ?? readJson(path.join(this.generationPath(gen), LOG_MANIFEST), null);
    if (!manifest) return;
    writeJsonAtomic(path.join(this.generationPath(gen), LOG_MANIFEST), manifest);
    this._manifestDirty = false;
  }

  _scheduleManifestFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      try {
        this.flushSync();
      } catch {
        /* the next append or close retries */
      }
    }, FLUSH_INTERVAL_MS);
    this._flushTimer.unref?.();
  }

  /** Sync shutdown: checkpoint everything the buffered append path still owns. */
  close() {
    this.flushSync();
    this._closeAppendHandle();
  }

  currentGeneration() {
    const text = readText(path.join(this.root, 'CURRENT'));
    if (!text) return null;
    const gen = text.trim();
    if (!/^gen-\d{6}$/.test(gen)) {
      throw new MemoryError(ErrorCodes.LOG_CORRUPT, 'log CURRENT pointer is malformed', { value: gen });
    }
    return gen;
  }

  generationPath(gen) {
    return path.join(this.root, gen);
  }

  /** Create the first generation if the log does not exist yet. Idempotent. */
  async ensure() {
    return this._mutex.run(async () => {
      const current = this.currentGeneration();
      if (current) return current;
      const gen = 'gen-000001';
      const dir = this.generationPath(gen);
      ensureDir(dir);
      const seg = segmentName(1);
      writeFileAtomic(path.join(dir, seg), '');
      const manifest = {
        v: 1,
        gen,
        createdAt: null,
        updatedAt: null,
        recordCount: 0,
        lastLogTime: null,
        segments: [{ name: seg, records: 0, bytes: 0, sha256: sha256('') }],
        rewrittenFrom: null,
        reason: 'initial',
      };
      writeJsonAtomic(path.join(dir, LOG_MANIFEST), manifest);
      this._manifestCache.set(gen, manifest);
      writeFileAtomic(path.join(this.root, 'CURRENT'), `${gen}\n`);
      fsyncDir(this.root);
      return gen;
    });
  }

  readManifest(gen) {
    if (this._manifestCache.has(gen)) return this._manifestCache.get(gen);
    const manifest = readJson(path.join(this.generationPath(gen), LOG_MANIFEST));
    if (!manifest) throw new MemoryError(ErrorCodes.LOG_CORRUPT, 'log generation has no manifest', { gen });
    this._manifestCache.set(gen, manifest);
    return manifest;
  }

  /**
   * Append records to the live generation.
   * @param {object[]} records already-built records (see records.js)
   * @returns {Promise<{gen: string, appended: number, recordCount: number}>}
   */
  async append(records) {
    if (!Array.isArray(records) || records.length === 0) return { gen: this.currentGeneration(), appended: 0 };
    return this._mutex.run(async () => {
      const gen = await this._ensureLocked();
      const manifest = { ...this.readManifest(gen), segments: this.readManifest(gen).segments.map((s) => ({ ...s })) };
      let segment = manifest.segments[manifest.segments.length - 1];
      if (!segment) {
        segment = { name: segmentName(1), records: 0, bytes: 0, sha256: null };
        manifest.segments.push(segment);
      }

      let chunkRecords = 0;
      let chunk = '';
      for (const record of records) {
        const line = `${serialiseRecord(record)}\n`;
        if (segment.records + chunkRecords + 1 > this.maxSegmentRecords) {
          // finalise the current segment, then start a new one
          this._appendChunk(gen, segment.name, chunk);
          segment.bytes += Buffer.byteLength(chunk);
          segment.sha256 = null;
          const next = { name: segmentName(manifest.segments.length + 1), records: 0, bytes: 0, sha256: null };
          manifest.segments.push(next);
          segment = next;
          chunkRecords = 0;
          chunk = '';
        }
        chunk += line;
        chunkRecords += 1;
      }
      if (chunk) {
        this._appendChunk(gen, segment.name, chunk);
        segment.bytes += Buffer.byteLength(chunk);
      }
      segment.records += chunkRecords;
      segment.sha256 = null;

      manifest.recordCount += records.length;
      const last = records[records.length - 1];
      manifest.lastLogTime = last.log_time;
      manifest.updatedAt = last.log_time;
      if (manifest.createdAt === null) manifest.createdAt = records[0].log_time;
      // The manifest is a checkpoint, not a per-append commit: publish it on the
      // flush timer / close() / before a rewrite. The log lines themselves are
      // already written, so nothing a reader needs is waiting on this.
      this._manifestCache.set(gen, manifest);
      this._manifestDirty = true;
      this._scheduleManifestFlush();
      return { gen, appended: records.length, recordCount: manifest.recordCount };
    });
  }

  async _ensureLocked() {
    const current = this.currentGeneration();
    if (current) return current;
    // replicate ensure() body without re-entering the mutex
    const gen = 'gen-000001';
    const dir = this.generationPath(gen);
    ensureDir(dir);
    const seg = segmentName(1);
    writeFileAtomic(path.join(dir, seg), '');
    const manifest = {
      v: 1,
      gen,
      createdAt: null,
      updatedAt: null,
      recordCount: 0,
      lastLogTime: null,
      segments: [{ name: seg, records: 0, bytes: 0, sha256: sha256('') }],
      rewrittenFrom: null,
      reason: 'initial',
    };
    writeJsonAtomic(path.join(dir, LOG_MANIFEST), manifest);
    this._manifestCache.set(gen, manifest);
    writeFileAtomic(path.join(this.root, 'CURRENT'), `${gen}\n`);
    fsyncDir(this.root);
    return gen;
  }

  /**
   * Read a coherent snapshot of the current generation.
   * @returns {Promise<{gen: string, manifest: object, records: object[]}>}
   */
  async snapshot() {
    const gen = this.currentGeneration();
    if (!gen) {
      return { gen: null, manifest: null, records: [] };
    }
    const dir = this.generationPath(gen);
    const manifest = this.readManifest(gen);
    const records = [];
    for (const segment of manifest.segments) {
      const file = path.join(dir, segment.name);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          throw new MemoryError(ErrorCodes.LOG_CORRUPT, 'log segment is missing', { gen, segment: segment.name });
        }
        throw err;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i].trim();
        if (!raw) continue;
        records.push(parseRecord(raw, { gen, segment: segment.name, line: i + 1 }));
      }
    }
    return { gen, manifest, records };
  }

  /**
   * Records appended after `offset` (an absolute position in the current generation).
   * Used by the catch-up phase of an index rebuild. Returns `null` when the log was
   * rewritten in the meantime (generation changed), because positions are then
   * meaningless and the caller must fall back to a full build.
   *
   * @param {number} offset absolute record index the caller has already consumed
   * @returns {Promise<{gen: string|null, records: object[]}|null>}
   */
  async recordsSince(offset) {
    const snapshot = await this.snapshot();
    if (!Number.isInteger(offset) || offset < 0) return null;
    if (offset > snapshot.records.length) return null;
    return { gen: snapshot.gen, records: snapshot.records.slice(offset) };
  }

  /**
   * Write the filtered record set into a NEW generation and swap CURRENT.
   * Used by physical delete, archive, and compaction.
   *
   * @param {object} opts
   * @param {(record: object) => boolean} opts.keep predicate over parsed records
   * @param {string} opts.reason journal-visible reason
   * @returns {Promise<{gen: string, previousGen: string|null, kept: number, dropped: number, droppedRecords: object[]}>}
   */
  async rewrite({ keep, reason = 'rewrite' }) {
    return this._mutex.run(async () => {
      // A rewrite replaces the generation a buffered append handle points at:
      // checkpoint and close it FIRST, or pending bytes could land in a retired file.
      this.flushSync();
      this._closeAppendHandle();
      const snapshot = await this.snapshot();
      const kept = [];
      const dropped = [];
      for (const record of snapshot.records) (keep(record) ? kept : dropped).push(record);

      const gen = nextGenerationName(this.root);
      const dir = this.generationPath(gen);
      const tmp = path.join(this.root, `.tmp-${gen}-${Date.now().toString(36)}`);
      ensureDir(tmp);

      const segments = [];
      let index = 1;
      for (let offset = 0; offset < kept.length || index === 1; offset += this.maxSegmentRecords) {
        const chunk = kept.slice(offset, offset + this.maxSegmentRecords);
        const name = segmentName(index);
        const text = chunk.map((r) => `${serialiseRecord(r)}\n`).join('');
        writeFileAtomic(path.join(tmp, name), text);
        segments.push({ name, records: chunk.length, bytes: Buffer.byteLength(text), sha256: sha256(text) });
        index += 1;
        if (offset + this.maxSegmentRecords >= kept.length) break;
      }

      const manifest = {
        v: 1,
        gen,
        createdAt: kept.length ? kept[0].log_time : null,
        updatedAt: kept.length ? kept[kept.length - 1].log_time : null,
        recordCount: kept.length,
        lastLogTime: kept.length ? kept[kept.length - 1].log_time : null,
        segments,
        rewrittenFrom: snapshot.gen,
        reason,
      };
      writeJsonAtomic(path.join(tmp, LOG_MANIFEST), manifest);
      fs.renameSync(tmp, dir);
      fsyncDir(this.root);
      writeFileAtomic(path.join(this.root, 'CURRENT'), `${gen}\n`);
      fsyncDir(this.root);
      this._manifestCache.set(gen, manifest);
      this._manifestCache.delete(snapshot.gen);
      this._manifestDirty = false;
      return {
        gen,
        previousGen: snapshot.gen,
        kept: kept.length,
        dropped: dropped.length,
        droppedRecords: dropped,
      };
    });
  }

  /** Merge segments without changing content. Bound on segment count / bloat. */
  async compact() {
    return this.rewrite({ keep: () => true, reason: 'compaction' });
  }

  /** Cold retention. Appends records to an archive file; log generation untouched. */
  appendArchive(label, records) {
    if (!this.archiveRoot) {
      throw new MemoryError(ErrorCodes.INVALID_CONFIG, 'archive root is not configured');
    }
    ensureDir(this.archiveRoot);
    const file = path.join(this.archiveRoot, `cold-${label}.jsonl`);
    const text = records.map((r) => `${serialiseRecord(r)}\n`).join('');
    appendLineDurable(file, text);
    return file;
  }

  async status() {
    const gen = this.currentGeneration();
    if (!gen) return { gen: null, recordCount: 0, segments: 0, unflushedBytes: 0 };
    const manifest = this.readManifest(gen);
    const generations = listGenerations(this.root);
    // Crash visibility: bytes appended to a segment but not yet checkpointed into
    // the manifest are only detectable by size. bootCheck treats them as stale, so
    // an unclean shutdown can never hide records behind an "up to date" index.
    let unflushedBytes = 0;
    for (const segment of manifest.segments) {
      try {
        const size = fs.statSync(path.join(this.generationPath(gen), segment.name)).size;
        if (size > (segment.bytes ?? 0)) unflushedBytes += size - segment.bytes;
      } catch {
        /* a missing segment is a corruption case handled by snapshot() */
      }
    }
    return {
      gen,
      recordCount: manifest.recordCount,
      segments: manifest.segments.length,
      lastLogTime: manifest.lastLogTime,
      generationCount: generations.length,
      latestGenerationNumber: genNumber(generations[generations.length - 1] ?? 'gen-000000'),
      unflushedBytes,
    };
  }
}
