/**
 * Raw cold-tier archiving (v1.6.1, zero external dependencies).
 *
 * Old daily shards (`.jsonl`) are merged per calendar month into ONE gzip archive
 * (`raw-archive-YYYY-MM.jsonl.gz`) using Node's built-in `zlib`. Compression is
 * gated by THREE conditions and run at most once per month:
 *
 *   age  > archiveAfterDays (default 30)
 *   access_count over the last 30 days == 0
 *   no `pinned` / `status:handoff` / hot-tag event
 *
 * Readers decompress with `createGunzip()` streaming, line by line, so a cold
 * archive never materialises in memory.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ensureDir, readJson, writeJsonAtomic } from './util.js';
import {
  archiveExtension,
  createCompressStream,
  createDecompressStream,
  engineForArchive,
  isArchiveFile,
  resolveEngine,
} from './compression.js';

export const ARCHIVE_PREFIX = 'raw-archive-';
const MONTH_MS = 30 * 86_400_000;

export function archiveMonthOf(day) {
  return String(day).slice(0, 7); // YYYY-MM
}

export function archiveName(month, engine = 'brotli') {
  return `${ARCHIVE_PREFIX}${month}${archiveExtension(engine)}`;
}

export function isArchiveName(name) {
  return isArchiveFile(name);
}

export class RawArchive {
  constructor({ rawDir, stateDir, clock }) {
    this.rawDir = rawDir;
    this.stateDir = stateDir;
    this.clock = clock;
    this.accessFile = path.join(stateDir, 'raw-access.json');
    this.archiveFile = path.join(stateDir, 'raw-archive.json');
  }

  /** Per-shard access counters: `{ "YYYY-MM-DD": { count, lastAt } }`. */
  readAccess() {
    const value = readJson(this.accessFile, null);
    return value && typeof value === 'object' ? value : {};
  }

  recordAccess(day, at = this.clock.now()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return;
    try {
      const access = this.readAccess();
      const entry = access[day] ?? { count: 0, lastAt: 0 };
      entry.count += 1;
      entry.lastAt = at;
      access[day] = entry;
      ensureDir(this.stateDir);
      writeJsonAtomic(this.accessFile, access);
    } catch {
      /* observability only: a failed counter must never fail a scan */
    }
  }

  readState() {
    const value = readJson(this.archiveFile, null);
    return value && typeof value === 'object' ? value : { lastRunAt: null, archives: {} };
  }

  /** Persist the archive bookkeeping (used by prune when a whole month is dropped). */
  writeState(state) {
    ensureDir(this.stateDir);
    writeJsonAtomic(this.archiveFile, {
      lastRunAt: state?.lastRunAt ?? null,
      archives: state?.archives ?? {},
    });
  }

  listArchives() {
    try {
      return fs.readdirSync(this.rawDir).filter(isArchiveName).sort();
    } catch {
      return [];
    }
  }

  archivePath(name) {
    return path.join(this.rawDir, name);
  }

  /**
   * Build (or extend) the month archive from eligible shards.
   * @returns {Promise<{ archived: string[], month: string|null, bytes: number, skipped: string[], reason?: string }>}
   */
  async archive({ shards, eligible, now = this.clock.now(), engine = 'brotli' }) {
    const state = this.readState();
    const monthGateMs = Number(state.lastRunAt ?? 0);
    if (monthGateMs > 0 && now - monthGateMs < MONTH_MS) {
      return { archived: [], month: null, bytes: 0, skipped: [], reason: 'monthly-gate' };
    }
    const resolved = resolveEngine(engine);
    const byMonth = new Map();
    for (const day of eligible) {
      const month = archiveMonthOf(day);
      const list = byMonth.get(month) ?? [];
      list.push(day);
      byMonth.set(month, list);
    }
    const archived = [];
    const skipped = [];
    const archiveStats = new Map();
    const existing = new Set(this.listArchives().map((name) => name.slice(ARCHIVE_PREFIX.length, ARCHIVE_PREFIX.length + 7)));
    let bytes = 0;
    for (const [month, days] of byMonth) {
      if (existing.has(month)) {
        // A month already has an archive (any engine): re-merging would duplicate rows
        // in deep_raw, so the old archive stays authoritative.
        skipped.push(`${month}:already-archived`);
        continue;
      }
      const name = archiveName(month, resolved.engine);
      const target = this.archivePath(name);
      const sources = days.filter((day) => shards.includes(`${day}.jsonl`)).sort();
      if (sources.length === 0) {
        skipped.push(month);
        continue;
      }
      const bytesBefore = sources.reduce((sum, day) => {
        try {
          return sum + fs.statSync(path.join(this.rawDir, `${day}.jsonl`)).size;
        } catch {
          return sum;
        }
      }, 0);
      try {
        await mergeShardsToArchive({
          files: sources.map((day) => path.join(this.rawDir, `${day}.jsonl`)),
          target,
          engine: resolved.engine,
        });
        for (const day of sources) fs.rmSync(path.join(this.rawDir, `${day}.jsonl`), { force: true });
        archived.push(month);
        const targetBytes = fs.existsSync(target) ? fs.statSync(target).size : 0;
        bytes += targetBytes;
        archiveStats.set(month, { bytesBefore, bytesAfter: targetBytes });
      } catch (error) {
        skipped.push(`${month}:${error?.code ?? error?.message ?? 'failed'}`);
      }
    }
    if (archived.length > 0) {
      const archives = { ...(state.archives ?? {}) };
      for (const month of archived) archives[month] = { name: archiveName(month, resolved.engine), at: now, engine: resolved.engine, ...(archiveStats.get(month) ?? {}) };
      writeJsonAtomic(this.archiveFile, { lastRunAt: now, archives });
    }
    return { archived, month: archived[0] ?? null, bytes, skipped, engine: resolved.engine, fallback: resolved.fallback };
  }
}

/**
 * Concatenate `files` into ONE compressed line stream (engine: gzip | zstd). The
 * write is crash-safe: output goes to `<target>.tmp` and is renamed only after the
 * compressor has fully flushed.
 */
export async function mergeShardsToArchive({ files, target, engine = 'brotli' }) {
  ensureDir(path.dirname(target));
  const tmp = `${target}.tmp`;
  const out = fs.createWriteStream(tmp);
  const compressor = createCompressStream(engine);
  const finished = new Promise((resolve, reject) => {
    out.on('error', reject);
    out.on('finish', resolve);
    compressor.on('error', reject);
  });
  compressor.pipe(out);
  for (const file of files) {
    const input = fs.createReadStream(file);
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (!compressor.write(`${line}\n`)) {
        await new Promise((resolve) => compressor.once('drain', resolve));
      }
    }
  }
  compressor.end();
  await finished;
  fs.renameSync(tmp, target);
  return target;
}

/**
 * Stream one archive line by line, calling `onLine(record)` until it returns
 * `false`. Decompressor is chosen by extension (.gz → gunzip, .zst → zstd).
 * Peak memory is one chunk plus one line — never the archive.
 */
export async function scanArchive(file, onLine) {
  const input = fs.createReadStream(file);
  const decompressor = createDecompressStream(engineForArchive(file));
  const rl = readline.createInterface({ input: input.pipe(decompressor), crlfDelay: Infinity });
  let stopped = false;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (onLine(record) === false) {
        stopped = true;
        break;
      }
    }
  } finally {
    if (stopped) {
      rl.close();
      input.destroy();
      decompressor.destroy();
    }
  }
}

/** Back-compat aliases (1.6.1 pre-engine call sites/tests). */
export const mergeShardsToGzip = mergeShardsToArchive;
export const scanGzipArchive = scanArchive;
