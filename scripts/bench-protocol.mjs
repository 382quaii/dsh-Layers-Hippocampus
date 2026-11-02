#!/usr/bin/env node
/**
 * Benchmark Protocol v1 — the ONLY sanctioned way to publish a throughput number
 * for this repository.
 *
 * Why this file exists: the v1.5.2 review briefly concluded "30–57% write
 * regression" from single-run measurements whose run-to-run spread exceeded 2x
 * on the same machine. A single number is noise, not a benchmark. This protocol
 * makes the noise visible and forbids publishing an unqualified headline.
 *
 * ENFORCED PROTOCOL
 *   1. ISOLATED STORE      every measured run gets a fresh os.tmpdir() data dir,
 *                          removed afterwards. No shared cache/state between runs.
 *   2. SAME-PROCESS WARMUP one discarded run precedes the measured runs, so module
 *                          parse + JIT + page cache are paid once in this process.
 *   3. N = 5 MEASURED RUNS report MEDIAN as the headline, plus min/max/spread.
 *                          A report is invalid without the spread.
 *   4. FIXED WORKLOAD      sequential `memory.remember()`, unique content per op.
 *   5. NO SPEED ASSERTIONS exit 0 regardless of throughput: a shared/AV-scanned
 *                          machine must not fail CI, it must report.
 *
 * Usage:
 *   node scripts/bench-protocol.mjs
 *   node scripts/bench-protocol.mjs --json
 *   node scripts/bench-protocol.mjs --records 2000 --runs 5 --warmup 1
 *
 * Any other benchmark harness in this repo is obsolete; the previous single-run
 * scripts/confidence-ab.mjs was deleted together with the dead minInjectConfidence
 * config (v1.5.3).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Memory } from '../src/memory.js';

const MIN_RUNS = 3;

function parseArgs(argv) {
  const options = { records: 1000, runs: 5, warmup: 1, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--records') options.records = Number(argv[++index]);
    else if (arg === '--runs') options.runs = Number(argv[++index]);
    else if (arg === '--warmup') options.warmup = Number(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      console.log('node scripts/bench-protocol.mjs [--records 1000] [--runs 5] [--warmup 1] [--json]');
      process.exit(0);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(options.records) || options.records < 1) throw new Error('--records must be a positive integer');
  if (!Number.isInteger(options.runs) || options.runs < MIN_RUNS) throw new Error(`--runs must be an integer >= ${MIN_RUNS} (protocol)`);
  if (!Number.isInteger(options.warmup) || options.warmup < 1) throw new Error('--warmup must be an integer >= 1 (protocol)');
  return options;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** One isolated run: fresh temp store, sequential remember, close, delete. */
async function runOnce({ records, warmup = false, runIndex = 0 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bench-'));
  const clock = { now: () => Date.now() };
  let memory = null;
  try {
    memory = await Memory.open({ dataDir: dir, clock });
    // Warmup opens the same store shape but writes only a fraction; its numbers are
    // discarded (protocol step 2).
    const writes = warmup ? Math.min(200, records) : records;
    const startedAt = performance.now();
    for (let index = 0; index < writes; index += 1) {
      await memory.remember({
        content: `benchmark ${warmup ? 'warmup' : `run-${runIndex}`} record ${index} payload`,
        tags: ['benchmark'],
        salience: 0.5,
      });
    }
    const elapsedMs = performance.now() - startedAt;
    return { elapsedMs, records: writes, opsPerSecond: writes / (elapsedMs / 1000) };
  } finally {
    try {
      memory?.close();
    } catch {
      /* best effort: the temp dir is disposable */
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function markdownReport({ options, samples, warmupMs, stats }) {
  const lines = [];
  lines.push('## Benchmark Protocol v1 — write throughput');
  lines.push('');
  lines.push(`- environment: node ${process.version}, ${process.platform} ${process.arch}, ${os.cpus().length} cpus`);
  lines.push(`- workload: sequential memory.remember(), ${options.records} records per run, unique content`);
  lines.push(`- protocol: fresh tmp dir per run; ${options.warmup} same-process warmup run; ${options.runs} measured runs; median headline`);
  lines.push(`- warmup time (discarded): ${warmupMs.toFixed(1)} ms`);
  lines.push('');
  lines.push('| run | elapsed ms | ops/s |');
  lines.push('| --- | --- | --- |');
  samples.forEach((sample, index) => {
    lines.push(`| ${index + 1} | ${sample.elapsedMs.toFixed(1)} | ${Math.round(sample.opsPerSecond)} |`);
  });
  lines.push(`| **median** | **${stats.medianMs.toFixed(1)}** | **${Math.round(stats.medianOps)}** |`);
  lines.push('');
  lines.push(`- min ${Math.round(stats.minOps)} ops/s · max ${Math.round(stats.maxOps)} ops/s · spread ${(stats.spread * 100).toFixed(1)}% of median`);
  lines.push(`- publish rule: quote median AND spread; a single run is not a result.`);
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = performance.now();
  let warmupMs = 0;
  for (let index = 0; index < options.warmup; index += 1) {
    const warmup = await runOnce({ records: options.records, warmup: true, runIndex: -1 - index });
    warmupMs += warmup.elapsedMs;
  }
  const samples = [];
  for (let index = 0; index < options.runs; index += 1) {
    samples.push(await runOnce({ records: options.records, runIndex: index }));
  }
  const ops = samples.map((sample) => sample.opsPerSecond);
  const stats = {
    medianOps: median(ops),
    minOps: Math.min(...ops),
    maxOps: Math.max(...ops),
    medianMs: median(samples.map((sample) => sample.elapsedMs)),
    spread: (Math.max(...ops) - Math.min(...ops)) / median(ops),
  };
  const report = {
    protocol: 'benchmark-protocol-v1',
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length, totalMs: performance.now() - startedAt },
    options,
    warmupMs,
    samples,
    stats,
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(markdownReport({ options, samples, warmupMs, stats }));
}

main().catch((error) => {
  console.error(`benchmark protocol failed: ${error?.stack ?? error}`);
  process.exit(1);
});
