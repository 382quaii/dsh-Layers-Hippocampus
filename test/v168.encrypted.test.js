/**
 * v1.6.8 — audit item A4: refuse ciphertext / high-entropy blobs on the WRITE side.
 *
 * Why this matters more than it looks: the raw log and the L1 event log are the two
 * things this plugin promises to keep forever. A ciphertext blob is the one payload
 * that can never be recalled (no substring), never summarised (nothing to say) and
 * never distilled (no tags) — yet it would occupy budget and retention forever.
 *
 * The detector must therefore be conservative: ordinary prose, source code, URLs,
 * file paths, identifiers and short base64 fragments all pass.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import {
  BASE64_ENTROPY_FLOOR,
  HEX_ENTROPY_FLOOR,
  MIN_RUN_CHARS,
  detectCiphertext,
  shannonEntropy,
} from '../src/entropy.js';
import { ErrorCodes } from '../src/errors.js';
import { makeMemory, tempDir } from './helpers.js';

/** Real ciphertext-shaped payload: base64 of random bytes. */
function highEntropyBase64(chars = 700) {
  return randomBytes(Math.ceil((chars * 3) / 4) + 8).toString('base64').slice(0, chars);
}

test('shannonEntropy is 0 for a constant string and > 4 for a flat alphabet', () => {
  assert.equal(shannonEntropy('aaaaaa'), 0);
  assert.equal(shannonEntropy(''), 0);
  assert.ok(shannonEntropy('abcd') > 1.9);
});

test('ordinary prose, code and short tokens are NOT rejected', () => {
  const safeSamples = [
    '这是一段普通的中文正文，讲的是发布门禁和回归测试，没有任何密文载荷。'.repeat(20),
    'const value = compute(a, b) + other(c); // a normal line of code\n'.repeat(30),
    'https://example.com/some/path?query=1&other=2',
    'C:\\Users\\86135\\Documents\\dsh\\workspace\\dsh-memory\\index.js',
    'dddddddddddddddddddddddddddddddddddddddddddddddd'.repeat(30), // long but low entropy
    'A'.repeat(600),
    // A real base64 image fragment shorter than the run floor.
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ];
  for (const sample of safeSamples) {
    assert.equal(detectCiphertext(sample), null, `false positive on: ${sample.slice(0, 40)}`);
  }
});

test('a high-entropy base64 payload IS rejected with an explainable verdict', () => {
  const payload = highEntropyBase64(MIN_RUN_CHARS + 200);
  assert.ok(shannonEntropy(payload) >= BASE64_ENTROPY_FLOOR, 'fixture must clear the floor');
  const verdict = detectCiphertext(`看这个：\n${payload}\n就这样`);
  assert.ok(verdict, 'must be rejected');
  assert.equal(verdict.reason, 'base64');
  assert.equal(verdict.runLength, payload.length);
  assert.ok(verdict.entropy >= BASE64_ENTROPY_FLOOR);
  assert.ok(verdict.at > 0, 'the offset points at the blob, not the prose');
});

test('a long high-entropy hex blob IS rejected', () => {
  const hex = '0123456789abcdef'.repeat(60); // 960 chars, flat hex alphabet
  assert.ok(shannonEntropy(hex) >= HEX_ENTROPY_FLOOR);
  const verdict = detectCiphertext(hex);
  assert.ok(verdict);
  assert.equal(verdict.reason, 'hex');
});

test('PEM armour is rejected even when short', () => {
  const verdict = detectCiphertext('-----BEGIN PGP MESSAGE-----\nabc\n-----END PGP MESSAGE-----');
  assert.ok(verdict);
  assert.equal(verdict.reason, 'pem');
});

test('the raw store refuses the blob and writes NOTHING', async () => {
  const dir = tempDir('a4-raw');
  const fixture = await makeMemory({ dir });
  try {
    const payload = highEntropyBase64(800);
    await assert.rejects(
      () => fixture.memory.raw.capture({ content: payload, role: 'user', salience: 1, force: true }),
      (error) => error.code === ErrorCodes.ENCRYPTED_RAW_REJECTED,
    );
    // Nothing queued, nothing flushed, nothing on disk.
    assert.equal(fixture.memory.raw.queue.length, 0);
    const rawDir = fixture.memory.paths.raw;
    const shards = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((n) => n.endsWith('.jsonl')) : [];
    for (const shard of shards) {
      const text = fs.readFileSync(`${rawDir}/${shard}`, 'utf8');
      assert.equal(text.includes(payload.slice(0, 64)), false, 'the blob must not reach disk');
    }
  } finally {
    fixture.cleanup();
  }
});

test('auto-capture reports a skip (not a failure) for a ciphertext turn', async () => {
  const dir = tempDir('a4-skip');
  // Auto-capture has to be ON for this path to be reached at all; the fixture's config
  // is the raw shape, so the flags must be explicit here.
  const fixture = await makeMemory({ dir, config: { raw: { autoCapture: true, mode: 'all' } } });
  try {
    const payload = highEntropyBase64(800);
    const result = await fixture.memory.captureSessionEvent(
      { id: 'session-a4' },
      { seq: 7, type: 'user/message', time: Date.now(), data: { content: [{ type: 'text', text: payload }] } },
    );
    assert.equal(result.stored, false);
    assert.equal(result.skipped, 'encrypted-blob');
  } finally {
    fixture.cleanup();
  }
});

test('remember() refuses the same payload on the durable path', async () => {
  const dir = tempDir('a4-remember');
  const fixture = await makeMemory({ dir });
  try {
    const payload = highEntropyBase64(800);
    await assert.rejects(
      () => fixture.memory.remember({ content: payload, tags: ['topic:cipher'], salience: 0.9 }),
      (error) => error.code === ErrorCodes.ENCRYPTED_RAW_REJECTED,
    );
    // And the plain payload-free write still works.
    const ok = await fixture.memory.remember({ content: '普通的发布记录：1.6.8 通过全量测试。', tags: ['topic:release'], salience: 0.9 });
    assert.ok(ok.eventId);
  } finally {
    fixture.cleanup();
  }
});
