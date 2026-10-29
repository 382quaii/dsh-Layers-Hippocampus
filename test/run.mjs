/**
 * In-process test runner with a hang watchdog.
 *
 * Why not `node --test`: it spawns one child process per file, and the Windows
 * sandbox refuses that piped spawn (EPERM). The files are imported into this
 * process instead; `node:test` still owns scheduling, assertions and the exit code.
 *
 * Why a watchdog: an unresolved promise inside a test makes the whole file hang
 * with no failing assertion and no name in the output. The watchdog reports WHAT
 * was still pending at the moment of the hang and then fails the run — it never
 * exits 0 to make the hang "go away".
 *
 * Which test hung: node:test's default reporter prints one line per finished
 * test, so the runner tee's stdout and remembers the LAST completed test. The
 * hang is inside the next test in the same file (or inside module import, when
 * the file name is all we have) — both are printed.
 *
 * Set MEM_TEST_TRACE=1 to see each file as it starts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HANG_TIMEOUT_MS = Number(process.env.MEM_TEST_TIMEOUT_MS ?? 30_000);

const dir = path.dirname(fileURLToPath(import.meta.url));
const only = process.env.MEM_TEST_ONLY;
const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith('.test.js'))
  .filter((name) => !only || name.includes(only))
  .sort();

const startedAt = Date.now();
const progress = { file: null, index: 0, lastTest: null, completed: 0 };

// Tee the reporter output: `✔ name (1.2ms)` / `✖ name (3ms)` lines are the only
// public signal node:test gives us about which test just ran.
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  for (const rawLine of text.split('\n')) {
    // Strip ANSI colour codes before matching.
    const line = rawLine.replace(/\u001b\[[0-9;]*m/g, '').trim();
    const finished = /^(✔|✖|﹣|✗)\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?$/.exec(line);
    if (finished) {
      progress.lastTest = `${finished[1]} ${finished[2].replace(/\s+\(\d+(\.\d+)?m?s\)$/, '')}`;
      progress.completed += 1;
    }
  }
  return originalWrite(chunk, encoding, callback);
};

function reportHang() {
  const elapsed = Date.now() - startedAt;
  const lines = [
    '',
    '==========================================================',
    `[watchdog] no completion after ${elapsed} ms (limit ${HANG_TIMEOUT_MS} ms, MEM_TEST_TIMEOUT_MS overrides)`,
    `[watchdog] hung while importing/executing: ${progress.file ?? '(none)'} (${progress.index}/${files.length})`,
    `[watchdog] last completed test: ${progress.lastTest ?? '(none)'} [${progress.completed} finished]`,
    `[watchdog] the hang is in the NEXT test of ${progress.file ?? 'that file'}, or in its module top-level await`,
    `[watchdog] active resources: ${(process.getActiveResourcesInfo?.() ?? []).join(', ') || '(none reported)'}`,
  ];
  // Timers are the usual suspect: an unref'd interval or a pending maintenance
  // promise keeps the loop alive long past the last assertion.
  for (const handle of process._getActiveHandles?.() ?? []) {
    if (handle?.constructor?.name === 'Timeout') {
      lines.push(`[watchdog] pending timer: ${handle._idleTimeout} ms :: ${String(handle._onTimeout).slice(0, 160)}`);
    }
  }
  lines.push('[watchdog] narrow it down with MEM_TEST_ONLY=<file-substring>');
  lines.push('[watchdog] rerun with MEM_TEST_TRACE=1 to see file-level progress');
  lines.push('==========================================================');
  console.error(lines.join('\n'));
  process.exitCode = 1;
  process.exit(1);
}

// The watchdog stays armed for the WHOLE run. `await import()` only REGISTERS the
// tests and returns; clearing here would disarm it before a single test body runs
// (that is how a previous hang went unnoticed for 3 minutes).
const watchdog = setTimeout(reportHang, HANG_TIMEOUT_MS);
watchdog.unref();

for (const [index, file] of files.entries()) {
  progress.file = file;
  progress.index = index + 1;
  progress.lastTest = null;
  if (process.env.MEM_TEST_TRACE === '1') {
    console.error(`[test] ${file} (${index + 1}/${files.length})`);
  }
  await import(pathToFileURL(path.join(dir, file)).href);
}
