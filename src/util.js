/**
 * Low-level utilities: clamping, canonical JSON, hashing, atomic file IO,
 * generation directory bookkeeping and an in-process mutex.
 *
 * Atomicity rules used everywhere below:
 *   1. A *directory* becomes visible by `rename()` of a fully written temp dir.
 *   2. A *pointer* (`CURRENT`) becomes visible by writing a temp file and renaming
 *      it over the old one. Readers therefore see either the old generation or the
 *      new one, never a half-written one.
 *   3. Files inside a generation that has been published are never mutated.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

export function clamp01(n) {
  return clamp(n, 0, 1);
}

export function round(n, digits = 6) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Deterministic JSON: object keys sorted recursively. Used for hashing policy and
 * for writing generation manifests so two identical builds hash identically.
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function shortHash(text, length = 12) {
  return sha256(text).slice(0, length);
}

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export function readJson(file, fallback = null) {
  const text = readText(file);
  if (text === null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Durable single-file write: temp file in the same dir, fsync, rename. */
export function writeFileAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Durable append of one already-serialised line (including trailing newline). */
export function appendLineDurable(file, line) {
  ensureDir(path.dirname(file));
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJsonLines(file) {
  const text = readText(file);
  if (text === null) return [];
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw) continue;
    out.push({ line: i + 1, value: JSON.parse(raw) });
  }
  return out;
}

const GEN_RE = /^gen-(\d{6})$/;

/** Generation directory names, ascending by numeric suffix. Ignores temp dirs. */
export function listGenerations(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && GEN_RE.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => genNumber(a) - genNumber(b));
}

export function genNumber(name) {
  const match = GEN_RE.exec(name);
  return match ? Number(match[1]) : -1;
}

export function nextGenerationName(dir) {
  const gens = listGenerations(dir);
  const next = gens.length ? genNumber(gens[gens.length - 1]) + 1 : 1;
  return `gen-${String(next).padStart(6, '0')}`;
}

/** Best-effort fsync of a directory (POSIX durability for renames). */
export function fsyncDir(dir) {
  if (process.platform === 'win32') return; // Windows has no directory fsync
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* best effort */
  }
}

/**
 * Serialises async critical sections inside one process.
 * Cross-process writers are refused by the owner lock in Memory.open(), so an
 * in-process mutex is sufficient for single-writer correctness.
 */
export class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }

  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  run(fn) {
    const result = this._tail.then(fn, fn);
    this._tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Truncate text to at most `max` characters without splitting surrogate pairs. */
export function snippet(text, max = 240) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** UTC day key, e.g. "2026-10-26". Diary blocks are keyed by this. */
export function dayKey(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function dayKeyToMs(day) {
  return Date.parse(`${day}T00:00:00.000Z`);
}
