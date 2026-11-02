/**
 * v1.5.3 release hygiene — two contracts that are easy to regress:
 *
 *   A. `context.minInjectConfidence` is REMOVED (dead token tax). It must be gone
 *      from config, HTTP editability, retrieval code, recall payload and the UI.
 *      Supplying the old key fails fast instead of silently doing nothing.
 *
 *   B. Multi-space FIXED OVERHEAD is bounded and linear: N=10 physical spaces must
 *      not multiply boot cost (children are opened lazily) and their on-disk size
 *      must grow linearly with the same workload.
 *
 * Assertions are deliberately loose on wall-clock numbers (shared/AV-scanned CI
 * machines are noisy); the benchmark protocol script is where performance is
 * measured. Here we only lock the SHAPE: fixed, bounded, linear.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { Memory } from '../src/memory.js';
import { EDITABLE_CONFIG_KEYS } from '../src/webRoutes.js';
import { FakeClock, T0, makeMemory, tempDir } from './helpers.js';

const CLIENT_PATH = new URL('../ui/client.js', import.meta.url);

function dirBytes(dir) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
      } catch {
        /* vanished mid-walk */
      }
    }
  };
  walk(dir);
  return total;
}

// ---- A. dead config removal ------------------------------------------------

test('minInjectConfidence is removed end-to-end (loud config failure, no code path)', async () => {
  // 1) Supplying the removed key is a LOUD failure, with the exact path and version.
  assert.throws(
    () => resolveConfig({ context: { minInjectConfidence: 0.6 } }),
    (error) =>
      error.code === 'MEM_E_CONFIG_UNKNOWN_KEY' &&
      error.details?.key === 'context.minInjectConfidence' &&
      error.details?.removedIn === '1.5.3',
  );
  // 2) It is not part of the resolved config or the HTTP-editable surface.
  const config = resolveConfig({});
  assert.equal('minInjectConfidence' in config.context, false);
  assert.equal(EDITABLE_CONFIG_KEYS.includes('context.minInjectConfidence'), false);
  // 3) The retrieval implementation is gone (no orphan export to be re-wired).
  const retrieval = await import('../src/retrieval.js');
  assert.equal('applyConfidence' in retrieval, false);
  assert.equal('MIN_INJECT_CONFIDENCE' in retrieval, false);
  // 4) The UI does not mention the knob or the old low-confidence copy.
  const client = fs.readFileSync(CLIENT_PATH, 'utf8');
  assert.equal(client.includes('minInjectConfidence'), false, 'settings must not render the removed knob');
  assert.equal(client.includes('低置信'), false, 'the low-confidence hint copy must be gone');
});

test('recall returns hits verbatim: no confidence annotation, no low-confidence notes', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    await memory.remember({ content: 'conf identity probe alpha', tags: ['conf:probe'], salience: 0.6 });
    await memory.remember({ content: 'conf identity probe beta', tags: ['conf:probe'], salience: 0.7 });
    const result = await memory.recall({ tags: ['conf:probe'], topK: 10 });
    assert.ok(result.hits.length >= 2, 'both hits are returned');
    for (const hit of result.hits) {
      assert.equal('lowConfidence' in hit, false, 'no low-confidence degradation remains');
      assert.equal('confidence' in hit, false, 'no confidence ratio is annotated anymore');
    }
    assert.equal(result.notes.some((note) => String(note).startsWith('low-confidence-hints')), false);
  } finally {
    cleanup();
  }
});

// ---- B. multi-space fixed overhead ----------------------------------------

test('multi-space overhead: bounded lazy boot and linear storage for N=10', { timeout: 60_000 }, async () => {
  const N = 10;
  const PER_SPACE = 20;
  const rootDir = tempDir('v154-multispace');
  const clock = new FakeClock(T0);
  const policy = { activeSet: { minEvents: 1, minMass: 0.01 } };
  const root = await Memory.open({ dataDir: rootDir, clock, policy });
  try {
    // 1) Create N empty physical spaces and write the same workload to each.
    const createStarted = performance.now();
    for (let index = 0; index < N; index += 1) await root.createSpace(`space-${index}`);
    const createMs = performance.now() - createStarted;
    for (let index = 0; index < N; index += 1) {
      for (let record = 0; record < PER_SPACE; record += 1) {
        await root.remember({
          content: `space-${index} fact ${record} payload`,
          tags: [`space:${index}`],
          salience: 0.5,
          targetSpaceId: `space-${index}`,
        });
      }
    }
    // Root close flushes children; reopen measurements below are independent.
    root.close();

    // 2) Storage: same workload -> per-space size must be ~constant, total linear.
    const sizes = Array.from({ length: N }, (_, index) => dirBytes(path.join(rootDir, 'spaces', `space-${index}`)));
    const single = sizes[0];
    const totalBytes = sizes.reduce((sum, value) => sum + value, 0);
    const ratio = Math.max(...sizes) / Math.min(...sizes);
    assert.ok(single > 0, 'a space has real bytes on disk');
    assert.ok(ratio <= 1.35, `per-space storage must be uniform, got max/min=${ratio.toFixed(2)}`);
    assert.ok(totalBytes >= single * N * 0.7 && totalBytes <= single * N * 1.3, 'total storage grows linearly with N');
    assert.ok(single < 256 * 1024, `per-space fixed overhead must stay bounded (<256KB), got ${single}B`);

    // 3) Boot cost: opening each space (manifest + state read) is bounded and linear.
    const reopenStarted = performance.now();
    const reopenTimes = [];
    for (let index = 0; index < N; index += 1) {
      const started = performance.now();
      const space = await Memory.open({ dataDir: path.join(rootDir, 'spaces', `space-${index}`), clock, policy });
      space.close();
      reopenTimes.push(performance.now() - started);
    }
    const reopenMs = performance.now() - reopenStarted;
    const perSpaceMs = reopenMs / N;
    assert.ok(perSpaceMs < 500, `per-space boot must stay bounded (<500ms), got ${perSpaceMs.toFixed(1)}ms`);
    assert.ok(reopenMs < 5000, `booting ${N} spaces must stay bounded (<5s), got ${reopenMs.toFixed(1)}ms`);

    // 4) The fixed cost must be LAZY: opening the root must NOT open all children.
    const rootOpenStarted = performance.now();
    const rootAgain = await Memory.open({ dataDir: rootDir, clock, policy });
    const rootOpenMs = performance.now() - rootOpenStarted;
    try {
      assert.deepEqual(rootAgain.spaces.status().open, [], 'root boot must not eagerly open child stores');
      assert.equal(rootAgain.spaces.status().ids.length, N + 1, 'all spaces are listed without being opened');
      assert.ok(rootOpenMs < 2000, `root boot with ${N} spaces must stay bounded (<2s), got ${rootOpenMs.toFixed(1)}ms`);
    } finally {
      rootAgain.close();
    }

    // Visible, non-assertive telemetry for the release report.
    console.log(
      `[space-overhead] N=${N} perSpace=${PER_SPACE} create=${createMs.toFixed(1)}ms ` +
        `reopenTotal=${reopenMs.toFixed(1)}ms perSpaceBoot=${perSpaceMs.toFixed(1)}ms ` +
        `rootBoot=${rootOpenMs.toFixed(1)}ms bytes/space=${single} total=${totalBytes} size-ratio=${ratio.toFixed(2)}`,
    );
  } finally {
    try {
      root.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
