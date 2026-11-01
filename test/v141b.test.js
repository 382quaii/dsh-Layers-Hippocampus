import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply, slimToolPayload } from '../index.js';
import { fakeCtx } from './helpers.js';

test('oversized tool payload is slimmed with a recovery hash', async () => {
  const captured = [];
  const text = await slimToolPayload(
    { config: { context: {} } },
    { ok: true, hits: [{ snippet: 'x'.repeat(3000) }, { snippet: 'y'.repeat(3000) }] },
    {
      budgetTokens: 100,
      capture: async (full) => {
        captured.push(full);
        return { stored: true, sha256: 'a'.repeat(64) };
      },
    },
  );
  assert.ok(captured.length === 1, 'full payload is written to raw first');
  const slim = JSON.parse(text);
  assert.equal(slim.slimmed, true);
  assert.match(slim.hint, /\[Slimmed\] 内容过长已裁剪/);
  assert.match(slim.hint, /memory_recall\(mode="deep_raw", hash=/);
  assert.equal(slim.recovery_hash, `hash_${'a'.repeat(12)}`);
  assert.ok(Array.isArray(slim.key_entities));
});

test('small payloads pass through untouched', async () => {
  const text = await slimToolPayload({ config: { context: {} } }, { ok: true, hits: [{ snippet: 'short' }] }, { budgetTokens: 2000, capture: async () => ({ stored: false }) });
  assert.equal(JSON.parse(text).slimmed, undefined);
  assert.match(text, /short/);
});

test('prompt policy section carries the retrieval discipline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-policy-'));
  const host = fakeCtx();
  try {
    await apply(host.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const section = host.sections.find((entry) => entry.name === 'memory:policy');
    assert.ok(section, 'memory:policy section is registered');
    const text = typeof section.text === 'function' ? section.text() : section.text;
    assert.match(text, /必须优先调用/);
    assert.match(text, /严禁直接盲目读取外部超长文件/);
    assert.match(text, /[Slimmed]/);
    assert.match(text, /recovery_hash/);
  } finally {
    host.dispose();
  }
});
