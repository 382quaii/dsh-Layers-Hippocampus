/**
 * Raw-turn store — the forensic layer behind `episode`.
 *
 * Deliberately NOT part of the L1 event log: raw turns are never indexed, never
 * loaded at boot, and never scanned by normal recall. They live in day-sharded
 * JSONL files and are only read by `deep_raw` (bounded scan) and by maintenance
 * (retention), which keeps the "offline recompute, online minimal" rule intact.
 *
 * Growth is bounded by four independent limits:
 *   maxTurnKb        one turn (head+tail truncation beyond it)
 *   maxBytesPerDay   one shard's budget
 *   maxTotalMb       the whole raw directory
 *   retentionDays    age-based pruning (code/error shards get 90 days)
 *
 * Gating (`raw.mode`):
 *   off       nothing is stored
 *   salience  only high-salience turns, code, stack traces, tool output, or force
 *   all       every turn (still capped and deduped)
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { MemoryError, ErrorCodes } from './errors.js';
import { dayKey, ensureDir, readJson, sha256, writeJsonAtomic } from './util.js';

export const RAW_DIR = 'raw';
export const RAW_SCHEMA = 1;
/** Hard ceiling for one deep_raw call (turns). */
export const MAX_SCAN_TURNS = 5000;
/** Bytes kept from head and tail of an oversized turn. */
export const TRUNCATE_KEEP_BYTES = 8 * 1024;
/** Shards containing code/errors are kept longer than chat shards. */
export const CODE_RETENTION_DAYS = 90;
/** Long base64-ish runs and obvious secrets are redacted before writing. */
const SECRET_PATTERNS = [
  /(?:bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /(?:sk-|ghp_|xox[baprs]-)[A-Za-z0-9_\-]{16,}/g,
  /[A-Za-z0-9+/]{120,}={0,2}/g,
];

function redact(text) {
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
    this._hashes = new Map(); // day -> Set(sha256)
    this._dayBytes = new Map(); // day -> bytes
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
        try {
          const record = JSON.parse(line);
          if (record.sha256) set.add(record.sha256);
        } catch {
          // A torn line is ignored; the shard is still append-only.
        }
      }
    }
    this._hashes.set(day, set);
    return set;
  }

  _dayBytesFor(day) {
    if (this._dayBytes.has(day)) return this._dayBytes.get(day);
    const file = this.dayFile(day);
    const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    this._dayBytes.set(day, bytes);
    return bytes;
  }

  /** Total raw bytes; cached and refreshed by writes/prunes. */
  totalBytes() {
    if (this._total !== null) return this._total;
    let total = 0;
    for (const name of this.listShards()) {
      try {
        total += fs.statSync(path.join(this.dir, name)).size;
      } catch {
        // A shard removed mid-scan does not count.
      }
    }
    this._total = total;
    return total;
  }

  /** Whether this turn is allowed to take disk space. */
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
   * Capture one raw turn. Returns a verdict instead of throwing for gated turns;
   * a real I/O failure throws (never a silent drop).
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
    const hashes = this._hashesFor(day);
    if (hashes.has(hash)) return { stored: false, reason: 'duplicate', sha256: hash };

    const maxBytes = Math.max(1024, (config.maxTurnKb ?? 64) * 1024);
    let body = text;
    let truncated = false;
    if (Buffer.byteLength(body, 'utf8') > maxBytes) {
      const head = body.slice(0, TRUNCATE_KEEP_BYTES);
      const tail = body.slice(-TRUNCATE_KEEP_BYTES);
      body = `${head}\n…[truncated ${body.length - head.length - tail.length} chars]…\n${tail}`;
      truncated = true;
    }
    const redacted = redact(body);
    const bytes = Buffer.byteLength(redacted.text, 'utf8') + 512;

    const perDayLimit = Math.max(1024, (config.maxBytesPerDay ?? 8) * 1024 * 1024);
    if (this._dayBytesFor(day) + bytes > perDayLimit) return { stored: false, reason: 'daily-budget', limit: perDayLimit };
    const totalLimit = Math.max(1, (config.maxTotalMb ?? 256)) * 1024 * 1024;
    if (this.totalBytes() + bytes > totalLimit) return { stored: false, reason: 'total-budget', limit: totalLimit };

    ensureDir(this.dir);
    const record = {
      schema: RAW_SCHEMA,
      turn_id: turn.turnId ?? `turn_${hash.slice(0, 16)}`,
      at: Number.isFinite(turn.at) ? turn.at : now,
      session_id: turn.sessionId ?? null,
      role: turn.role ?? 'unknown',
      kind: turn.kind ?? 'chat',
      content: redacted.text,
      bytes,
      sha256: hash,
      truncated,
      redactions: redacted.redactions,
      salience: Number.isFinite(turn.salience) ? turn.salience : null,
      tags: Array.isArray(turn.tags) ? turn.tags.slice(0, 20) : [],
      ref_event_id: turn.refEventId ?? null,
      gated_by: decision.reason,
    };
    await fs.promises.appendFile(this.dayFile(day), `${JSON.stringify(record)}\n`, 'utf8');
    hashes.add(hash);
    this._dayBytes.set(day, this._dayBytesFor(day) + bytes);
    if (this._total !== null) this._total += bytes;
    return { stored: true, sha256: hash, bytes, day, truncated, redactions: redacted.redactions, gatedBy: decision.reason, file: this.dayFile(day) };
  }

  /**
   * Bounded deep scan. Never claims completeness: when the budget runs out the
   * caller gets `truncated: true` and the numbers that prove it.
   */
  async scan({ text = '', timeFrom = null, timeTo = null, limit = 20, regex = false, isTombstoned = null } = {}) {
    const config = this.config();
    if (!config || config.mode === 'off') {
      throw new MemoryError(ErrorCodes.RAW_DISABLED, 'raw storage is disabled (raw.mode=off); enable it to use deep_raw', {
        mode: config?.mode ?? 'off',
      });
    }
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
    const maxTurns = Math.min(MAX_SCAN_TURNS, (config.maxScanTurns ?? MAX_SCAN_TURNS));
    const shards = this.listShards()
      .filter((name) => {
        const day = name.replace('.jsonl', '');
        if (timeFrom !== null && day < dayKey(timeFrom)) return false;
        if (timeTo !== null && day > dayKey(timeTo)) return false;
        return true;
      })
      .reverse();

    const hits = [];
    const scanned = { turns: 0, bytes: 0, shards: 0 };
    let truncated = false;
    for (const name of shards) {
      if (truncated) break;
      const file = path.join(this.dir, name);
      scanned.shards += 1;
      const stream = fs.createReadStream(file, { encoding: 'utf8' });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let offset = 0;
      for await (const line of lines) {
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
        offset += lineBytes;
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
        if (record.tombstoned === true) continue;
        if (record.ref_event_id && typeof isTombstoned === 'function' && isTombstoned(record.ref_event_id)) continue;
        const haystack = `${record.content ?? ''}`;
        if (!matcher.test(haystack)) continue;
        const index = needle ? haystack.toLowerCase().indexOf(needle.toLowerCase()) : 0;
        const at = index >= 0 ? index : 0;
        hits.push({
          turnId: record.turn_id,
          at: record.at,
          role: record.role,
          kind: record.kind,
          snippet: haystack.slice(Math.max(0, at - 120), at + 120 + needle.length),
          byteOffset: offset - lineBytes,
          sha256: record.sha256,
          refEventId: record.ref_event_id ?? null,
          truncated: record.truncated === true,
          shard: name,
        });
        if (hits.length >= limit) break;
      }
      lines.close();
      stream.destroy();
    }
    return {
      mode: 'deep_raw',
      hits,
      scanned,
      truncated: truncated || hits.length >= limit,
      budget: { maxBytes, maxTurns },
      notes: truncated ? [`scan-budget-exhausted:${maxBytes} bytes / ${maxTurns} turns`] : [],
    };
  }

  /** Retention + cap enforcement. Called by maintenance only. */
  async prune({ now = this.clock.now() } = {}) {
    const config = this.config();
    const retention = Math.max(1, config.retentionDays ?? 30);
    const cutoffChat = now - retention * 86_400_000;
    const cutoffCode = now - Math.max(retention, CODE_RETENTION_DAYS) * 86_400_000;
    const removed = [];
    let freed = 0;
    for (const name of this.listShards()) {
      const file = path.join(this.dir, name);
      const day = name.replace('.jsonl', '');
      const dayMs = Date.parse(`${day}T00:00:00.000Z`);
      if (!Number.isFinite(dayMs)) continue;
      let keepCode = false;
      try {
        keepCode = fs.readFileSync(file, 'utf8').includes('"kind":"code"');
      } catch {
        keepCode = false;
      }
      const cutoff = keepCode ? cutoffCode : cutoffChat;
      if (dayMs >= cutoff) continue;
      try {
        const size = fs.statSync(file).size;
        fs.rmSync(file, { force: true });
        freed += size;
        removed.push(day);
      } catch {
        // A shard already removed by another pass is not an error.
      }
    }
    if (removed.length > 0) {
      this._total = null;
      this._hashes.clear();
      this._dayBytes.clear();
    }
    return { removed, freedBytes: freed, retentionDays: retention };
  }

  stats() {
    const shards = this.listShards();
    return {
      shards: shards.length,
      bytes: this.totalBytes(),
      newest: shards.at(-1) ?? null,
      oldest: shards[0] ?? null,
    };
  }
}
