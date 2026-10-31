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
import { createHash } from 'node:crypto';
import { MemoryError, ErrorCodes } from './errors.js';
import { dayKey, ensureDir, sha256 } from './util.js';

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

export class RawStore {
  constructor({ dataDir, clock, getConfig }) {
    this.dir = path.join(dataDir, RAW_DIR);
    this.clock = clock;
    this.getConfig = getConfig;
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

  _hashesFor(day) {
    if (this._hashes.has(day)) return this._hashes.get(day);
    const set = new Set();
    const file = this.dayFile(day);
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof record.turn_id === 'string' && typeof record.content === 'string') set.add(sha256(record.content));
      }
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
  capture(turn = {}) {
    const config = this.config();
    const text = typeof turn.content === 'string' ? turn.content : '';
    if (!text.trim()) throw new MemoryError(ErrorCodes.INVALID_INPUT, 'raw turn content must be a non-empty string');
    const decision = this.gate({ mode: config.mode, salience: turn.salience, kind: turn.kind, text, force: turn.force });
    if (!decision.store) return { stored: false, reason: decision.reason };

    const now = this.clock.now();
    const day = dayKey(now);
    const hash = sha256(text);
    const hashes = this._hashesFor(day);
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
      let text = '';
      try {
        text = fs.readFileSync(path.join(this.dir, name), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.includes('"raw_tombstone"')) continue;
        try {
          const record = JSON.parse(line);
          if (record.type === 'raw_tombstone' && record.hash) set.add(record.hash);
        } catch {
          /* torn line */
        }
      }
    }
    this._tombstones = set;
    return set;
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
    const maxTurns = Math.min(5000, config.maxScanTurns ?? 5000);
    const tokenBudget = Math.max(1, Number(maxTokens ?? config.maxResultTokens ?? 1000));
    const shards = this.listShards()
      .filter((name) => {
        const day = name.replace('.jsonl', '');
        return day >= dayKey(startTime) && day <= dayKey(endTime);
      })
      .reverse();

    const hits = [];
    const scanned = { turns: 0, bytes: 0, shards: 0, tombstonesSkipped: 0 };
    let truncated = false;
    let tokensUsed = 0;
    for (const name of shards) {
      if (truncated) break;
      const file = path.join(this.dir, name);
      scanned.shards += 1;
      const stream = fs.createReadStream(file, { encoding: 'utf8' });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let lineNumber = 0;
      for await (const line of lines) {
        lineNumber += 1;
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
        scanned.bytes += lineBytes;
        if (scanned.bytes > maxBytes || scanned.turns >= maxTurns) {
          truncated = true;
          break;
        }
        scanned.turns += 1;
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
        const index = needle ? haystack.toLowerCase().indexOf(needle.toLowerCase()) : 0;
        const at = index >= 0 ? index : 0;
        const snippet = redactSecrets(haystack.slice(Math.max(0, at - 120), at + 120 + needle.length));
        const snippetTokens = Math.ceil(snippet.text.length / CHARS_PER_TOKEN);
        if (tokensUsed + snippetTokens > tokenBudget) {
          truncated = true;
          break;
        }
        tokensUsed += snippetTokens;
        hits.push({
          turnId: record.turn_id,
          timestamp: record.timestamp,
          role: record.role,
          snippet: snippet.text,
          redactions: snippet.redactions,
          shard: name,
          line: lineNumber,
        });
        if (hits.length >= limit) break;
      }
      lines.close();
      stream.destroy();
    }
    const notes = [];
    const notesTruncated = truncated || hits.length >= limit;
    if (notesTruncated) notes.push(TOKEN_TRUNCATION_NOTE);
    return {
      mode: 'deep_raw',
      hits,
      scanned,
      truncated: notesTruncated,
      budget: { maxBytes, maxTurns, maxTokens: tokenBudget, tokensUsed },
      notes,
    };
  }

  /** TTL: delete whole shards strictly older than `today - retentionDays`. */
  async prune({ now = this.clock.now() } = {}) {
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

  stats() {
    const shards = this.listShards();
    return {
      shards: shards.length,
      bytes: this.totalBytes(),
      newest: shards.at(-1) ?? null,
      oldest: shards[0] ?? null,
      tombstones: this._loadTombstones().size,
    };
  }
}
