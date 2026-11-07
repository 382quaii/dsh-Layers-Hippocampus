/**
 * Raw-turn store — the black box.
 *
 * A raw record is four fields and nothing else:
 *   { turn_id, timestamp, role, content }
 *
 * No tags, salience, decay, event ids, graph links or metadata: all derived data
 * lives in `log/` (L1) and `index/`. Addressing is by (day file, line number) —
 * append-only makes line numbers stable, the only lawful exception to the
 * no-line-pointers rule.
 *
 * Defense properties:
 *   - writes are queued and flushed in batches (10 records or 1s), never sync;
 *   - secrets are redacted on READ (deep_raw snippets), disk keeps plaintext;
 *   - forget appends `{ type: 'raw_tombstone', hash, timestamp }` and scans skip
 *     any tombstoned content hash;
 *   - retention prunes whole day files strictly older than the cutoff (the file
 *     being written today is never deleted);
 *   - deep_raw has a token budget and says so when it truncates.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { MemoryError, ErrorCodes } from './errors.js';
import { dayKey, ensureDir, sha256 } from './util.js';
import { RawArchive, archiveMonthOf, isArchiveName, scanGzipArchive } from './rawArchive.js';
import { buildIndex, indexFileFor, isIndexFile, readIndex, shardOverlapsWindow, writeIndex } from './rawIndex.js';

export const RAW_DIR = 'raw';
/** Records queued before a forced flush. */
export const FLUSH_BATCH = 10;
/** Milliseconds before a queued record is flushed. */
export const FLUSH_DELAY_MS = 1000;
/** Head/tail bytes kept when one turn exceeds raw.maxTurnKb. */
export const TRUNCATE_KEEP_BYTES = 8 * 1024;
/** Marker appended to size-truncated content. */
export const TRUNCATE_MARKER = '…[truncated]…';
/** Appended when the result is cut for the token budget. */
export const TOKEN_TRUNCATION_NOTE = '由于预算限制，部分原始记录已被截断';
/** Characters per token estimate for the result budget. */
const CHARS_PER_TOKEN = 4;
/** Streaming read granularity. Peak scan memory is one chunk plus one partial line. */
export const READ_CHUNK_BYTES = 64 * 1024;
/** Engine-side hard ceiling on one scan's result set (never trust the caller). */
export const MAX_SCAN_RESULTS = 500;

const RUNTIME_CONTEXT_MARKER = /^Current runtime context\./i;
const SECRET_PATTERNS = [
  /(?:bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /(?:sk-|ghp_|xox[baprs]-)[A-Za-z0-9_\-]{16,}/g,
  /[A-Za-z0-9+/]{120,}={0,2}/g,
];

/** Redact obvious secrets from a string. Used on READ, never on write. */
export function redactSecrets(text) {
  if (typeof text !== 'string') return { text: '', redactions: 0 };
  let redactions = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, () => {
      redactions += 1;
      return '[redacted]';
    });
  }
  return { text: out, redactions };
}

function looksLikeCode(text) {
  return /```|(^|\n)\s{4}\S|(^|\n)(function|class|import|export|const|let|def|public|private)\s/.test(text);
}

function looksLikeStack(text) {
  return /Error:|Exception:|at\s+[\w.$]+\s*\([^)]*:\d+:\d+\)/.test(text);
}

const GATED_KINDS = new Set(['code', 'error', 'tool_output']);

/** Strip a trailing carriage return (CRLF files) without copying the line twice. */
function stripCr(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Forward line iterator with O(chunk) memory: `readline` over a file stream.
 * Used by restore/hash/tombstone passes, which must not load a whole shard.
 */
export async function* readLinesForward(file, { chunkSize = READ_CHUNK_BYTES } = {}) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: chunkSize });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) yield line;
  } finally {
    reader.close();
    stream.destroy();
  }
}

/**
 * NEWEST-FIRST line iterator: reads the file backwards in bounded chunks and
 * splits it into lines without ever materialising the whole shard. This is the
 * primitive that makes `deep_raw`'s tail scan O(chunk) instead of O(file).
 *
 * A file produced by this store never contains blank lines, so the trailing
 * newline does not yield a phantom empty line: the first yield of a file that
 * ends with '\n' is its final record.
 *
 * @param {string} file
 * @param {{chunkSize?: number, onBuffer?: (bytes: number) => void}} [options]
 *   `onBuffer` reports the current buffer size (chunk + carry) after each read;
 *   tests use it to prove peak memory stays bounded.
 */
export async function* readLinesReverse(file, { chunkSize = READ_CHUNK_BYTES, onBuffer = null } = {}) {
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    let position = size;
    let carry = Buffer.alloc(0);
    let firstChunk = true;
    while (position > 0) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      await handle.read(chunk, 0, length, position);
      const combined = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      onBuffer?.(combined.length);
      let end = combined.length;
      for (let index = combined.length - 1; index >= 0; index -= 1) {
        if (combined[index] !== 0x0a) continue;
        let line = combined.subarray(index + 1, end).toString('utf8');
        end = index;
        line = stripCr(line);
        // A file ending in '\n' would otherwise yield one phantom empty line.
        if (firstChunk && index === combined.length - 1 && line === '') {
          firstChunk = false;
          continue;
        }
        firstChunk = false;
        if (line.length > 0) yield line;
      }
      carry = combined.subarray(0, end);
      onBuffer?.(carry.length);
    }
    if (carry.length > 0) {
      const line = stripCr(carry.toString('utf8'));
      if (line.length > 0) yield line;
    }
  } finally {
    await handle.close();
  }
}

/**
 * Synchronous forward iterator (StringDecoder keeps multi-byte boundaries
 * intact). Only `stats()`/tombstone loading need a sync pass; memory is still
 * bounded by `chunkSize`, never by the file.
 */
export function* readLinesForwardSync(file, { chunkSize = READ_CHUNK_BYTES } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(chunkSize);
  try {
    let carry = '';
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, chunkSize, null);
      if (bytes === 0) break;
      const text = carry + decoder.write(buffer.subarray(0, bytes));
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        const clean = stripCr(line);
        if (clean.length > 0) yield clean;
      }
    }
    carry += decoder.end();
    const last = stripCr(carry);
    if (last.length > 0) yield last;
  } finally {
    fs.closeSync(fd);
  }
}

export class RawStore {
  constructor({ dataDir, clock, getConfig, getHotTags = null }) {
    this.dir = path.join(dataDir, RAW_DIR);
    this.clock = clock;
    this.getConfig = getConfig;
    this.getHotTags = getHotTags;
    this.archive = new RawArchive({
      rawDir: this.dir,
      stateDir: path.join(dataDir, 'state'),
      clock,
    });
    this.queue = [];
    this._flushTimer = null;
    this._flushChain = Promise.resolve();
    this._hashes = new Map(); // day -> Set(sha256)
    this._dayBytes = new Map(); // day -> bytes
    this._tombstones = null; // Set(sha256), loaded lazily
    this._total = null;
  }

  config() {
    return this.getConfig?.()?.raw ?? {};
  }

  dayFile(day) {
    return path.join(this.dir, `${day}.jsonl`);
  }

  listShards() {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort();
  }

  async _hashesFor(day) {
    if (this._hashes.has(day)) return this._hashes.get(day);
    const set = new Set();
    try {
      for await (const line of readLinesForward(this.dayFile(day))) {
        if (!line) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof record.turn_id === 'string' && typeof record.content === 'string') set.add(sha256(record.content));
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    this._hashes.set(day, set);
    return set;
  }

  _dayBytesFor(day) {
    if (this._dayBytes.has(day)) return this._dayBytes.get(day);
    const bytes = fs.existsSync(this.dayFile(day)) ? fs.statSync(this.dayFile(day)).size : 0;
    this._dayBytes.set(day, bytes);
    return bytes;
  }

  totalBytes() {
    if (this._total !== null) return this._total;
    let total = 0;
    for (const name of this.listShards()) {
      try {
        total += fs.statSync(path.join(this.dir, name)).size;
      } catch {
        /* removed mid-scan */
      }
    }
    this._total = total;
    return total;
  }

  /** Append-side gate (manual captures only; auto-capture passes force). */
  gate({ mode, salience, kind, text, force }) {
    const config = this.config();
    const effective = mode ?? config.mode ?? 'salience';
    if (effective === 'off' && force !== true) return { store: false, reason: 'raw-disabled' };
    if (force === true) return { store: true, reason: 'forced' };
    if (effective === 'all') return { store: true, reason: 'mode-all' };
    if (!effective || effective === 'off') return { store: false, reason: 'raw-disabled' };
    if (Number(salience) >= (config.minSalience ?? 0.6)) return { store: true, reason: 'salience' };
    if (GATED_KINDS.has(kind)) return { store: true, reason: `kind:${kind}` };
    if (looksLikeCode(text)) return { store: true, reason: 'code-shape' };
    if (looksLikeStack(text)) return { store: true, reason: 'stack-shape' };
    return { store: false, reason: 'below-threshold' };
  }

  /**
   * Queue one raw turn. Returns a verdict synchronously (dedupe/budget/gate);
   * the bytes land on disk via the background flush.
   */
  async capture(turn = {}) {
    const config = this.config();
    const text = typeof turn.content === 'string' ? turn.content : '';
    if (!text.trim()) throw new MemoryError(ErrorCodes.INVALID_INPUT, 'raw turn content must be a non-empty string');
    const decision = this.gate({ mode: config.mode, salience: turn.salience, kind: turn.kind, text, force: turn.force });
    if (!decision.store) return { stored: false, reason: decision.reason };

    const now = this.clock.now();
    const day = dayKey(now);
    const hash = sha256(text);
    const hashes = await this._hashesFor(day);
    if (hashes.has(hash)) return { stored: false, reason: 'duplicate', sha256: hash };

    const maxBytes = Math.max(1024, (config.maxTurnKb ?? 64) * 1024);
    let content = text;
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      const head = content.slice(0, TRUNCATE_KEEP_BYTES);
      const tail = content.slice(-TRUNCATE_KEEP_BYTES);
      content = `${head}\n${TRUNCATE_MARKER}\n${tail}`;
    }
    const record = {
      turn_id: turn.turnId ?? `turn_${hash.slice(0, 16)}`,
      timestamp: Number.isFinite(turn.at) ? turn.at : now,
      role: turn.role === 'assistant' || turn.role === 'tool' ? turn.role : 'user',
      content,
    };
    const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8') + 1;
    const perDayLimit = Math.max(1024, (config.maxBytesPerDay ?? 8) * 1024 * 1024);
    if (this._dayBytesFor(day) + bytes > perDayLimit) return { stored: false, reason: 'daily-budget', limit: perDayLimit };
    const totalLimit = Math.max(1, config.maxTotalMb ?? 256) * 1024 * 1024;
    if (this.totalBytes() + bytes > totalLimit) return { stored: false, reason: 'total-budget', limit: totalLimit };

    hashes.add(hash);
    this._dayBytes.set(day, this._dayBytesFor(day) + bytes);
    if (this._total !== null) this._total += bytes;
    this.queue.push({ day, line: JSON.stringify(record) });
    if (this.queue.length >= FLUSH_BATCH) {
      this.flush().catch(() => {});
    } else {
      this._scheduleFlush();
    }
    return { stored: true, queued: true, sha256: hash, turnId: record.turn_id, day };
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush().catch(() => {});
    }, FLUSH_DELAY_MS);
    this._flushTimer.unref?.();
  }

  /** Flush every queued record. Awaited by scans, maintenance and tests. */
  flush() {
    this._flushChain = this._flushChain.then(async () => {
      if (this.queue.length === 0) return;
      const pending = this.queue.splice(0, this.queue.length);
      ensureDir(this.dir);
      const byDay = new Map();
      for (const item of pending) {
        if (!byDay.has(item.day)) byDay.set(item.day, []);
        byDay.get(item.day).push(item.line);
      }
      for (const [day, lines] of byDay) {
        await fs.promises.appendFile(this.dayFile(day), `${lines.join('\n')}\n`, 'utf8');
      }
    });
    return this._flushChain;
  }

  /**
   * Release the raw store (v1.5.6): clear the flush timer, persist anything still
   * queued synchronously (close must not lose the last turns), and drop every
   * in-memory cache so the instance can be GC'd. Idempotent.
   */
  close() {
    if (this._closed === true) return;
    this._closed = true;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this.queue.length > 0) {
      const pending = this.queue.splice(0, this.queue.length);
      try {
        ensureDir(this.dir);
        const byDay = new Map();
        for (const item of pending) {
          if (!byDay.has(item.day)) byDay.set(item.day, []);
          byDay.get(item.day).push(item.line);
        }
        for (const [day, lines] of byDay) {
          fs.appendFileSync(this.dayFile(day), `${lines.join('\n')}\n`, 'utf8');
        }
      } catch {
        /* best effort: a failing disk must not make close() throw */
      }
    }
    this._flushChain = Promise.resolve();
    this._hashes.clear();
    this._dayBytes.clear();
    this._tombstones = null;
    this._total = null;
  }

  /** Tombstone content hashes at the raw layer (called after a purge). */
  async tombstone(hashes = [], { at = this.clock.now() } = {}) {
    const unique = [...new Set(hashes)].filter(Boolean);
    if (unique.length === 0) return { tombstoned: 0 };
    ensureDir(this.dir);
    const day = dayKey(at);
    const lines = unique.map((hash) => JSON.stringify({ type: 'raw_tombstone', hash, timestamp: at }));
    await fs.promises.appendFile(this.dayFile(day), `${lines.join('\n')}\n`, 'utf8');
    if (this._tombstones) for (const hash of unique) this._tombstones.add(hash);
    this._total = null;
    this._dayBytes.delete(day);
    return { tombstoned: unique.length };
  }

  _loadTombstones() {
    if (this._tombstones) return this._tombstones;
    const set = new Set();
    for (const name of this.listShards()) {
      try {
        for (const line of readLinesForwardSync(path.join(this.dir, name))) {
          if (!line.includes('"raw_tombstone"')) continue;
          try {
            const record = JSON.parse(line);
            if (record.type === 'raw_tombstone' && record.hash) set.add(record.hash);
          } catch {
            /* torn line */
          }
        }
      } catch (error) {
        // A shard pruned between listShards() and the read is not an error.
        if (!error || error.code !== 'ENOENT') throw error;
      }
    }
    this._tombstones = set;
    return set;
  }

  /** Non-empty line count of one shard (bounded streaming pass, no full read). */
  async _countLines(file) {
    let total = 0;
    try {
      for await (const line of readLinesForward(file)) {
        if (line.length > 0) total += 1;
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    return total;
  }

  /**
   * Bounded deep scan with a mandatory time window (enforced by the caller) and
   * a token budget. Returns redacted snippets; disk remains plaintext.
   */
  async scan({ text = '', startTime, endTime, limit = 20, regex = false, maxTokens } = {}) {
    const config = this.config();
    if (!config || config.mode === 'off') {
      throw new MemoryError(ErrorCodes.RAW_DISABLED, 'raw storage is disabled (raw.mode=off); enable it to use deep_raw', {
        mode: config?.mode ?? 'off',
      });
    }
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      throw new MemoryError(ErrorCodes.INVALID_INPUT, 'deep_raw requires start_time and end_time (epoch ms)', {
        startTime: startTime ?? null,
        endTime: endTime ?? null,
      });
    }
    if (endTime < startTime) {
      throw new MemoryError(ErrorCodes.INVALID_INPUT, 'end_time must be >= start_time', { startTime, endTime });
    }
    await this.flush();
    const now = this.clock.now();
    const tombstones = this._loadTombstones();
    const needle = String(text ?? '');
    let matcher;
    if (regex) {
      try {
        matcher = new RegExp(needle, 'i');
      } catch (error) {
        throw new MemoryError(ErrorCodes.INVALID_INPUT, `invalid regex for deep_raw: ${error.message}`, { pattern: needle.slice(0, 80) });
      }
    } else {
      matcher = { test: (value) => value.toLowerCase().includes(needle.toLowerCase()) };
    }
    const maxBytes = Math.max(1, config.maxScanMb ?? 16) * 1024 * 1024;
    // Bounded turn budget from config (fail-fast validated upstream). The old code
    // hard-capped it at 5000 and always scanned from the HEAD of the shard, so the
    // newest 5000 turns could never be found in a large day file — the exact
    // opposite of a black box's job.
    const maxTurns = Math.max(1, Number(config.maxScanTurns ?? 5000));
    const tokenBudget = Math.max(1, Number(maxTokens ?? config.maxResultTokens ?? 1000));
    const shards = this.listShards()
      .filter((name) => {
        const day = name.replace('.jsonl', '');
        return day >= dayKey(startTime) && day <= dayKey(endTime);
      })
      .reverse();
    // Cold-tier archives overlapping the requested window. Compressed shards have no
    // seekable line index, so they are streamed start-to-end with an early stop.
    const wantedMonths = new Set();
    for (let cursor = startTime; cursor <= endTime; cursor += 86_400_000) wantedMonths.add(archiveMonthOf(dayKey(cursor)));
    const archives = this.archive
      .listArchives()
      .filter((name) => wantedMonths.has(name.replace(/^raw-archive-/, '').replace(/\.jsonl\.(gz|zst)$/, '')));

    const hits = [];
    const archiveErrors = [];
    const notes = [];
    const scanned = { turns: 0, bytes: 0, shards: 0, tombstonesSkipped: 0, peakBufferBytes: 0 };
    // The caller's `limit` is advisory; the engine enforces its own ceiling so a
    // direct embedder can never request an unbounded result set.
    const effectiveLimit = Math.min(Math.max(1, Math.floor(Number(limit) || 20)), MAX_SCAN_RESULTS);
    let truncated = false;
    let tokensUsed = 0;
    let indexedShards = 0;
    for (const name of shards) {
      if (truncated) break;
      const file = path.join(this.dir, name);
      // v1.6.1 sparse index (best-effort): skip a shard whose [minTs, maxTs] cannot
      // overlap the window, and reuse its lineCount instead of a second pass.
      const shardIndex = readIndex(file);
      if (shardIndex) {
        indexedShards += 1;
        if (!shardOverlapsWindow(shardIndex, startTime, endTime)) {
          notes.push(`index-skip:${name}`);
          continue;
        }
      }
      scanned.shards += 1;
      const shardHits = [];
      let tailIndex = 0; // 0 = the shard's last physical line
      try {
        // NEWEST FIRST, one line at a time: the file is read backwards in fixed
        // chunks, so peak memory is O(chunk + one line), never O(file).
        for await (const line of readLinesReverse(file, {
          onBuffer: (bytes) => {
            if (bytes > scanned.peakBufferBytes) scanned.peakBufferBytes = bytes;
          },
        })) {
          const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
          scanned.bytes += lineBytes;
          if (scanned.bytes > maxBytes || scanned.turns >= maxTurns) {
            truncated = true;
            break;
          }
          scanned.turns += 1;
          const fromTail = tailIndex;
          tailIndex += 1;
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          if (record.type === 'raw_tombstone') continue;
          // A raw turn carries no `type`: the four-field shape is the record.
          if (typeof record.turn_id !== 'string' || typeof record.content !== 'string') continue;
          if (record.timestamp < startTime || record.timestamp > endTime) continue;
          if (tombstones.has(sha256(record.content))) {
            scanned.tombstonesSkipped += 1;
            continue;
          }
          const haystack = record.content;
          if (!matcher.test(haystack)) continue;
          const at = needle ? haystack.toLowerCase().indexOf(needle.toLowerCase()) : 0;
          const snippet = redactSecrets(haystack.slice(Math.max(0, at - 120), at + 120 + needle.length));
          const snippetTokens = Math.ceil(snippet.text.length / CHARS_PER_TOKEN);
          if (tokensUsed + snippetTokens > tokenBudget) {
            truncated = true;
            break;
          }
          tokensUsed += snippetTokens;
          shardHits.push({
            turnId: record.turn_id,
            timestamp: record.timestamp,
            role: record.role,
            snippet: snippet.text,
            redactions: snippet.redactions,
            shard: name,
            fromTail,
          });
          if (hits.length + shardHits.length >= effectiveLimit) break;
        }
      } catch (error) {
        if (error && error.code === 'ENOENT') continue;
        throw error;
      }
      if (shardHits.length > 0) {
        // Absolute line numbers need the shard's line count. A FRESH sparse index
        // already knows it; otherwise pay ONE extra bounded streaming pass.
        const total = shardIndex?.lineCount ?? (await this._countLines(file));
        for (const hit of shardHits) {
          hit.line = total - hit.fromTail;
          delete hit.fromTail;
        }
        hits.push(...shardHits);
        this.archive.recordAccess(name.replace('.jsonl', ''), now);
      }
    }
    // ---- cold archives ------------------------------------------------------
    for (const archiveName of archives) {
      if (truncated || hits.length >= effectiveLimit) break;
      scanned.shards += 1;
      const file = this.archive.archivePath(archiveName);
      try {
        await scanGzipArchive(file, (record) => {
          scanned.turns += 1;
          if (record?.type === 'raw_tombstone') return true;
          if (typeof record?.turn_id !== 'string' || typeof record?.content !== 'string') return true;
          if (record.timestamp < startTime || record.timestamp > endTime) return true;
          if (tombstones.has(sha256(record.content))) {
            scanned.tombstonesSkipped += 1;
            return true;
          }
          if (!matcher.test(record.content)) return true;
          const at = needle ? record.content.toLowerCase().indexOf(needle.toLowerCase()) : 0;
          const snippet = redactSecrets(record.content.slice(Math.max(0, at - 120), at + 120 + needle.length));
          const snippetTokens = Math.ceil(snippet.text.length / CHARS_PER_TOKEN);
          if (tokensUsed + snippetTokens > tokenBudget) {
            truncated = true;
            return false;
          }
          tokensUsed += snippetTokens;
          hits.push({
            turnId: record.turn_id,
            timestamp: record.timestamp,
            role: record.role,
            snippet: snippet.text,
            redactions: snippet.redactions,
            archive: archiveName,
          });
          if (hits.length >= effectiveLimit) return false;
          return true;
        });
      } catch (error) {
        if (error && error.code === 'ENOENT') continue;
        // Fail-fast per archive, never for the whole scan: one corrupt cold file must
        // not hide hits that live in the other archives / plaintext shards.
        archiveErrors.push({
          archive: archiveName,
          code: ErrorCodes.CORRUPTED_ARCHIVE,
          message: `raw archive unreadable: ${archiveName}: ${error?.message ?? error}`,
        });
        notes.push(`archive-corrupt:${archiveName}`);
      }
    }
    const notesTruncated = truncated || hits.length >= effectiveLimit;
    if (notesTruncated) notes.push(TOKEN_TRUNCATION_NOTE);
    return {
      mode: 'deep_raw',
      hits,
      scanned: { ...scanned, indexedShards },
      truncated: notesTruncated,
      budget: { maxBytes, maxTurns, maxTokens: tokenBudget, tokensUsed, maxHits: MAX_SCAN_RESULTS },
      notes,
      ...(archiveErrors.length > 0 ? { archiveErrors } : {}),
    };
  }

  async restoreByHash(hash) {
    await this.flush();
    const wanted = String(hash).replace(/^hash_/, '');
    const tombstones = this._loadTombstones();
    const hits = [];
    for (const name of this.listShards().reverse()) {
      let line = 0;
      try {
        for await (const rawLine of readLinesForward(path.join(this.dir, name))) {
          if (!rawLine.trim()) continue;
          line += 1;
          let record;
          try {
            record = JSON.parse(rawLine);
          } catch {
            continue;
          }
          if (record.type === 'raw_tombstone' || typeof record.content !== 'string') continue;
          const digest = sha256(record.content);
          if (!digest.startsWith(wanted) || tombstones.has(digest)) continue;
          hits.push({ turnId: record.turn_id, timestamp: record.timestamp, role: record.role, content: record.content, hash: digest, shard: name, line, restored: true });
        }
      } catch (error) {
        if (error && error.code === 'ENOENT') continue;
        throw error;
      }
    }
    // Cold archives: same hash lookup, streamed (no seek, no full materialisation).
    for (const name of this.archive.listArchives().reverse()) {
      if (hits.length >= 5) break;
      try {
        await scanGzipArchive(this.archive.archivePath(name), (record) => {
          if (hits.length >= 5) return false;
          if (record?.type === 'raw_tombstone' || typeof record?.content !== 'string') return true;
          const digest = sha256(record.content);
          if (!digest.startsWith(wanted) || tombstones.has(digest)) return true;
          hits.push({
            turnId: record.turn_id,
            timestamp: record.timestamp,
            role: record.role,
            content: record.content,
            hash: digest,
            archive: name,
            restored: true,
          });
          return hits.length < 5;
        });
      } catch (error) {
        if (error && error.code === 'ENOENT') continue;
        /* a corrupt archive must not fail hash restore of plaintext shards */
      }
    }
    return { mode: 'deep_raw', hits: hits.slice(0, 5), truncated: hits.length > 5, notes: hits.length === 0 ? ['hash not found'] : [], restored: hits.length > 0 };
  }

  /**
   * Cold-tier archiving (v1.6.1). Runs at most once per month, merges all eligible
   * daily shards of a calendar month into `raw-archive-YYYY-MM.jsonl.gz`.
   *
   * Eligibility (ALL must hold):
   *   1. shard day is older than `raw.archiveAfterDays` (default 30);
   *   2. access_count over the last 30 days is 0 (counter in state/raw-access.json);
   *   3. the shard contains no pinned / status:handoff / hot-tag event.
   */
  async archiveCold({ now = this.clock.now(), hotTags = null, archiveAfterDays = null } = {}) {
    const config = this.config();
    const afterDays = Math.max(1, Number(archiveAfterDays ?? config.archiveAfterDays ?? 30));
    const access = this.archive.readAccess();
    const cutoff = dayKey(now - afterDays * 86_400_000);
    const recentCutoff = now - 30 * 86_400_000;
    const hot = new Set(Array.isArray(hotTags) ? hotTags : []);
    const eligible = [];
    const skipped = [];
    for (const name of this.listShards()) {
      const day = name.replace('.jsonl', '');
      if (day >= cutoff) continue; // too fresh
      const counter = access[day];
      if (counter && (Number(counter.count) > 0 || Number(counter.lastAt) > recentCutoff)) {
        skipped.push(`${day}:recent-access`);
        continue;
      }
      let blocked = null;
      try {
        for await (const line of readLinesForward(path.join(this.dir, name))) {
          if (!line.trim()) continue;
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          if (record?.type === 'raw_tombstone') continue;
          if (record?.pinned === true || record?.salience === 'pinned') {
            blocked = 'pinned';
            break;
          }
          if (Array.isArray(record?.tags) && record.tags.some((tag) => String(tag).includes('status:handoff'))) {
            blocked = 'handoff';
            break;
          }
          if (hot.size > 0 && Array.isArray(record?.tags) && record.tags.some((tag) => hot.has(String(tag)))) {
            blocked = 'hot-tag';
            break;
          }
        }
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      if (blocked) {
        skipped.push(`${day}:${blocked}`);
        continue;
      }
      eligible.push(day);
    }
    const result = await this.archive.archive({
      shards: this.listShards(),
      eligible,
      now,
      engine: config.compressionEngine ?? 'gzip',
    });
    if (result.archived.length > 0) {
      this._total = null;
      this._hashes.clear();
      this._dayBytes.clear();
    }
    return { ...result, eligible: eligible.length, skipped };
  }

  /** TTL: delete whole shards strictly older than `today - retentionDays`. */  async prune({ now = this.clock.now() } = {}) {
    const config = this.config();
    const retention = Math.max(1, config.retentionDays ?? 30);
    const today = dayKey(now);
    const cutoff = dayKey(now - retention * 86_400_000);
    const removed = [];
    let freed = 0;
    for (const name of this.listShards()) {
      const day = name.replace('.jsonl', '');
      if (day === today) continue; // the file being written today is never deleted
      if (day >= cutoff) continue;
      try {
        const file = path.join(this.dir, name);
        const size = fs.statSync(file).size;
        fs.rmSync(file, { force: true });
        // The side-car index has no meaning without its shard.
        fs.rmSync(indexFileFor(file), { force: true });
        freed += size;
        removed.push(day);
      } catch {
        /* already gone */
      }
    }
    if (removed.length > 0) {
      this._total = null;
      this._hashes.clear();
      this._dayBytes.clear();
      this._tombstones = null;
    }
    return { removed, freedBytes: freed, retentionDays: retention, today };
  }

  /**
   * v1.6.1 sparse index maintenance: build/refresh one `.idx.json` per shard when
   * missing or stale. Runs offline (maintain), never on the capture path.
   */
  async ensureIndexes({ step = 64, limit = Infinity } = {}) {
    const built = [];
    const errors = [];
    const shards = this.listShards();
    for (const name of shards.slice(0, limit)) {
      const file = path.join(this.dir, name);
      try {
        if (readIndex(file)) continue;
        const index = await buildIndex({ shardFile: file, day: name.replace('.jsonl', ''), step });
        writeIndex(file, index);
        built.push(name);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        errors.push({ shard: name, message: error?.message ?? String(error) });
      }
    }
    return { indexed: built.length, total: shards.length, built, errors };
  }

  stats() {
    const shards = this.listShards();
    const indexedShards = shards.filter((name) => readIndex(path.join(this.dir, name)) !== null).length;
    const archives = this.archive.listArchives();
    let archivedBytes = 0;
    const archiveMonths = [];
    for (const name of archives) {
      try {
        archivedBytes += fs.statSync(path.join(this.dir, name)).size;
      } catch {
        /* removed mid-read */
      }
      archiveMonths.push({
        name,
        month: name.slice('raw-archive-'.length, 'raw-archive-'.length + 7),
        engine: name.endsWith('.zst') ? 'zstd' : 'gzip',
        bytes: (() => {
          try {
            return fs.statSync(path.join(this.dir, name)).size;
          } catch {
            return 0;
          }
        })(),
      });
    }
    const plaintextBytes = this.totalBytes();
    const archiveState = this.archive.readState();
    let savedBytes = 0;
    let beforeKnown = 0;
    let afterKnown = 0;
    for (const record of Object.values(archiveState.archives ?? {})) {
      if (Number.isFinite(record?.bytesBefore) && Number.isFinite(record?.bytesAfter)) {
        beforeKnown += record.bytesBefore;
        afterKnown += record.bytesAfter;
        savedBytes += Math.max(0, record.bytesBefore - record.bytesAfter);
      }
    }
    const compressionRatio = beforeKnown > 0 ? Math.round((afterKnown / beforeKnown) * 1000) / 1000 : null;
    return {
      shards: shards.length,
      indexedShards,
      bytes: plaintextBytes,
      newest: shards.at(-1) ?? null,
      oldest: shards[0] ?? null,
      tombstones: this._loadTombstones().size,
      archiveCount: archives.length,
      archivedBytes,
      totalBytes: plaintextBytes + archivedBytes,
      archiveMonths: archiveMonths.slice(-12),
      engines: {
        gzip: archiveMonths.filter((entry) => entry.engine === 'gzip').length,
        zstd: archiveMonths.filter((entry) => entry.engine === 'zstd').length,
      },
      savedBytes,
      compressionRatio,
    };
  }
}
