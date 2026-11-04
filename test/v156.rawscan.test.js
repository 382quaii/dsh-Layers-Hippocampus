/**
 * v1.5.6 — raw 按行游标扫描（分行索引）。
 *
 * Locked contracts:
 *   1. a scan reads the shard NEWEST-FIRST, one line at a time (O(chunk) memory,
 *      never O(file));
 *   2. `hit.line` stays a positive, absolute 1-based line number (the v1.4
 *      contract) even though the scan never loads the file;
 *   3. the turn/byte budget truncates loudly instead of reading to the head;
 *   4. the engine enforces its own result ceiling (MAX_SCAN_RESULTS), regardless
 *      of what the caller asks for.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DAY_MS, T0, makeMemory } from './helpers.js';
import { MAX_SCAN_RESULTS, READ_CHUNK_BYTES, readLinesReverse } from '../src/rawStore.js';

const DAY = new Date(T0).toISOString().slice(0, 10);
const WINDOW = { startTime: T0 - DAY_MS, endTime: T0 + DAY_MS };

/** Write one day shard directly: 1-based line N is record N. */
function writeShard(dir, count, { special = new Map() } = {}) {
  const shardDir = path.join(dir, 'raw');
  fs.mkdirSync(shardDir, { recursive: true });
  const file = path.join(shardDir, `${DAY}.jsonl`);
  const lines = [];
  for (let index = 1; index <= count; index += 1) {
    lines.push(
      JSON.stringify({
        turn_id: `turn_${index}`,
        timestamp: T0 + index,
        role: 'user',
        content: special.get(index) ?? `filler line ${index}`,
      }),
    );
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

test('deep_raw reads newest-first and keeps the absolute line number', async () => {
  const fixture = await makeMemory({
    config: { raw: { mode: 'all', maxScanTurns: 20_000, maxScanMb: 64, maxResultTokens: 100_000 } },
  });
  try {
    writeShard(fixture.dir, 5_000, { special: new Map([[5_000, 'unique needle newest']]) });
    const result = await fixture.memory.deepRaw({ text: 'unique needle newest', ...WINDOW, limit: 5 });

    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].line, 5_000, 'the newest line is line 5000, reported without loading the file');
    assert.ok(Number.isInteger(result.hits[0].line) && result.hits[0].line > 0);
    assert.equal(result.truncated, false);
    assert.equal(result.scanned.turns, 5_000, 'the whole shard was walked from the tail');
    assert.ok(result.scanned.peakBufferBytes > 0 && result.scanned.peakBufferBytes <= READ_CHUNK_BYTES + 512,
      'scan buffer stays chunk-sized, not file-sized');
  } finally {
    fixture.cleanup();
  }
});

test('deep_raw stops at raw.maxScanTurns and says truncated instead of reading the head', async () => {
  const fixture = await makeMemory({
    config: { raw: { mode: 'all', maxScanTurns: 500, maxScanMb: 64, maxResultTokens: 100_000 } },
  });
  try {
    writeShard(fixture.dir, 5_000, { special: new Map([[1, 'ancient needle only in line 1']]) });
    const result = await fixture.memory.deepRaw({ text: 'ancient needle', ...WINDOW, limit: 5 });

    assert.equal(result.hits.length, 0, 'the oldest line is outside the tail budget');
    assert.equal(result.truncated, true);
    assert.equal(result.scanned.turns, 500);
    assert.ok(result.notes.some((note) => note.includes('截断')));
  } finally {
    fixture.cleanup();
  }
});

test('the engine enforces its own result ceiling regardless of the caller', async () => {
  const fixture = await makeMemory({
    config: { raw: { mode: 'all', maxScanTurns: 20_000, maxScanMb: 64, maxResultTokens: 100_000 } },
  });
  try {
    writeShard(fixture.dir, 600, { special: new Map(Array.from({ length: 600 }, (_, index) => [index + 1, `hit token ${index + 1}`])) });
    const result = await fixture.memory.deepRaw({ text: 'hit token', ...WINDOW, limit: 5_000 });

    assert.equal(result.hits.length, MAX_SCAN_RESULTS, 'never more than the engine cap, even if asked for 5000');
    assert.equal(result.truncated, true);
    assert.equal(result.budget.maxHits, MAX_SCAN_RESULTS);
  } finally {
    fixture.cleanup();
  }
});

test('readLinesReverse peak buffer is one chunk plus one line, never the file', async () => {
  const fixture = await makeMemory();
  try {
    const file = path.join(fixture.dir, 'reverse-fixture.jsonl');
    const count = 20_000;
    const lines = [];
    for (let index = 1; index <= count; index += 1) {
      lines.push(JSON.stringify({ n: index, text: 'x'.repeat(40) }));
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    const fileBytes = fs.statSync(file).size;

    let peak = 0;
    let seen = 0;
    let longest = 0;
    let previous = count;
    for await (const line of readLinesReverse(file, {
      chunkSize: 4_096,
      onBuffer: (bytes) => {
        if (bytes > peak) peak = bytes;
      },
    })) {
      seen += 1;
      longest = Math.max(longest, Buffer.byteLength(line, 'utf8'));
      const record = JSON.parse(line);
      assert.equal(record.n, previous, 'lines arrive newest-first, one at a time');
      previous -= 1;
    }

    assert.equal(seen, count);
    assert.equal(previous, 0);
    assert.ok(peak <= 4_096 + longest + 1, `peak ${peak} must stay chunk + one line (${longest})`);
    assert.ok(peak * 10 < fileBytes, `peak ${peak} must be far below the ${fileBytes}-byte file`);
  } finally {
    fixture.cleanup();
  }
});

test('restoreByHash streams the shard and still finds the original turn', async () => {
  const fixture = await makeMemory({ config: { raw: { mode: 'all', maxScanTurns: 20_000 } } });
  try {
    const original = 'the exact turn to restore';
    const captured = await fixture.memory.captureRaw({ content: original, role: 'tool', kind: 'tool_output', force: true });
    assert.equal(captured.stored, true);
    const restored = await fixture.memory.deepRaw({ hash: captured.sha256.slice(0, 12) });
    assert.equal(restored.hits.length, 1);
    assert.equal(restored.hits[0].content, original);
  } finally {
    fixture.cleanup();
  }
});
