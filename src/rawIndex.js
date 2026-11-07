/**
 * Sparse line index for raw daily shards (v1.6.1, performance audit item C).
 *
 * One `<day>.idx.json` per shard, sampled every `step` lines:
 *
 *   { schema, day, bytes, mtimeMs, lineCount, step, entries: [{ line, offset, timestamp }],
 *     minTimestamp, maxTimestamp, sorted }
 *
 * What it buys (honestly):
 *   - SHARD-level time-window pruning: a shard whose [minTimestamp, maxTimestamp]
 *     falls outside the requested window is skipped without opening it;
 *   - lineCount reuse: the absolute `hit.line` no longer needs an extra full pass;
 *   - forward seeks for future forward readers (offset per sampled line).
 *
 * It does NOT replace the reverse scan: deep_raw reads newest-first, and gzip is not
 * seekable at all. The index is a fast side-car and degrades silently when missing,
 * stale (bytes/mtime mismatch), corrupt, or when timestamps are not monotonic.
 */

import fs from 'node:fs';
import readline from 'node:readline';

export const RAW_INDEX_SCHEMA = 1;
export const DEFAULT_INDEX_STEP = 64;

/** Local forward line stream — keeps this module free of a rawStore import cycle. */
async function* streamLines(file) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    input.destroy();
  }
}

export function indexFileFor(shardFile) {
  return `${shardFile}.idx.json`;
}

export function isIndexFile(name) {
  return /\.jsonl\.idx\.json$/.test(String(name));
}

/**
 * Build the sparse index by streaming the shard once. `offset` is the byte offset of
 * the sampled line's first byte. Timestamps are parsed defensively: a malformed line
 * still consumes a line number but contributes no sample.
 */
export async function buildIndex({ shardFile, day, step = DEFAULT_INDEX_STEP }) {
  const stat = fs.statSync(shardFile);
  const entries = [];
  let line = 0;
  let offset = 0;
  let lineCount = 0;
  let minTimestamp = null;
  let maxTimestamp = null;
  let sorted = true;
  let previousTimestamp = null;
  for await (const text of streamLines(shardFile)) {
    line += 1;
    lineCount = line;
    const bytes = Buffer.byteLength(text, 'utf8') + 1;
    if ((line - 1) % step === 0) {
      let timestamp = null;
      try {
        const record = JSON.parse(text);
        if (typeof record?.timestamp === 'number' && Number.isFinite(record.timestamp)) timestamp = record.timestamp;
      } catch {
        /* a malformed line just gets no timestamp sample */
      }
      entries.push({ line, offset, timestamp });
    }
    try {
      const record = JSON.parse(text);
      if (typeof record?.timestamp === 'number' && Number.isFinite(record.timestamp)) {
        if (minTimestamp === null || record.timestamp < minTimestamp) minTimestamp = record.timestamp;
        if (maxTimestamp === null || record.timestamp > maxTimestamp) maxTimestamp = record.timestamp;
        if (previousTimestamp !== null && record.timestamp < previousTimestamp) sorted = false;
        previousTimestamp = record.timestamp;
      }
    } catch {
      /* ignore malformed */
    }
    offset += bytes;
  }
  return {
    schema: RAW_INDEX_SCHEMA,
    day,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    lineCount,
    step,
    entries,
    minTimestamp,
    maxTimestamp,
    sorted,
  };
}

/** Read + validate one index; `null` means "degrade to sequential scan". */
export function readIndex(shardFile) {
  const file = indexFileFor(shardFile);
  try {
    const stat = fs.statSync(shardFile);
    const index = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (index?.schema !== RAW_INDEX_SCHEMA) return null;
    if (index.bytes !== stat.size || index.mtimeMs !== stat.mtimeMs) return null;
    if (!Array.isArray(index.entries) || index.entries.length === 0) return null;
    if (!Number.isInteger(index.lineCount) || index.lineCount < 1) return null;
    return index;
  } catch {
    return null;
  }
}

export function writeIndex(shardFile, index) {
  const file = indexFileFor(shardFile);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** Shard-level time-window test; `null` timestamps mean "cannot prove absence". */
export function shardOverlapsWindow(index, startTime, endTime) {
  if (!index) return true;
  if (Number.isFinite(index.minTimestamp) && index.maxTimestamp !== null && index.minTimestamp !== null) {
    if (index.maxTimestamp < startTime) return false;
    if (index.minTimestamp > endTime) return false;
  }
  return true;
}
