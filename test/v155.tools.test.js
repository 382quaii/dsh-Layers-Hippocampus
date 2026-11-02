/**
 * v1.5.3 — `tools.disabled`: prune redundant tool schemas (the per-turn token tax).
 *
 * Contract under test:
 *   1. Config is a closed vocabulary of SUFFIXES; unknown / core / duplicate names
 *      throw MEM_E_INVALID_TOOL_NAME and abort activation (no silent ignore).
 *   2. `apply()` skips registration for disabled suffixes AND the `memory` prompt
 *      section stops advertising them (schema pruning without prompt pruning lies
 *      to the model).
 *   3. The default (empty array) keeps all 10 tools registered — zero regression.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { CORE_TOOL_SUFFIXES, TOOL_SUFFIXES, resolveConfig } from '../src/config.js';
import { EDITABLE_CONFIG_KEYS, validatePatch } from '../src/webRoutes.js';
import { fakeCtx, tempDir } from './helpers.js';

async function withPlugin(rawConfig, body) {
  const dir = tempDir('v155-tools');
  const host = fakeCtx();
  try {
    await apply(host.ctx, { dataDir: dir, autoMaintainOnBoot: false, ...rawConfig });
    await getRuntime(host.ctx).ready;
    await body({ host, dir, runtime: getRuntime(host.ctx) });
  } finally {
    host.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 1. config contract -----------------------------------------------------

test('tools.disabled defaults to [] and the suffix vocabulary is closed', () => {
  const config = resolveConfig({});
  assert.deepEqual(config.tools.disabled, []);
  assert.deepEqual([...TOOL_SUFFIXES].sort(), [
    'admin',
    'bulk_ingest',
    'capture',
    'checkpoint',
    'forget',
    'recall',
    'reinforce',
    'remember',
    'space_transfer',
    'transfer_to_global',
  ]);
  assert.deepEqual([...CORE_TOOL_SUFFIXES].sort(), ['admin', 'recall', 'remember']);
  assert.equal(resolveConfig({ tools: { disabled: ['capture'] } }).tools.disabled[0], 'capture');
});

test('a typo (remeber) aborts config resolution with MEM_E_INVALID_TOOL_NAME', () => {
  assert.throws(
    () => resolveConfig({ tools: { disabled: ['remeber'] } }),
    (error) =>
      error.code === 'MEM_E_INVALID_TOOL_NAME' &&
      error.details?.name === 'remeber' &&
      Array.isArray(error.details?.known) &&
      error.details.known.includes('remember'),
    'a mistyped tool must be loud, never silently ignored',
  );
  // A full prefixed name is a different vocabulary, so it is rejected with a hint.
  assert.throws(
    () => resolveConfig({ tools: { disabled: ['memory_capture'] } }),
    (error) => error.code === 'MEM_E_INVALID_TOOL_NAME' && /suffix/i.test(error.message),
  );
});

test('core tools and duplicates are rejected (cannot brick the plugin from config)', () => {
  for (const name of CORE_TOOL_SUFFIXES) {
    assert.throws(
      () => resolveConfig({ tools: { disabled: [name] } }),
      (error) => error.code === 'MEM_E_INVALID_TOOL_NAME' && error.details?.reason === 'core',
      `${name} must never be disable-able`,
    );
  }
  assert.throws(
    () => resolveConfig({ tools: { disabled: ['capture', 'capture'] } }),
    (error) => error.code === 'MEM_E_INVALID_TOOL_NAME' && error.details?.reason === 'duplicate',
  );
  // Shape failures stay typed, not coerced.
  assert.throws(() => resolveConfig({ tools: { disabled: 'capture' } }), (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE');
  assert.throws(() => resolveConfig({ tools: { disabled: [42] } }), (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE');
});

test('tools.disabled is editable over HTTP as a nested array patch', () => {
  assert.ok(EDITABLE_CONFIG_KEYS.includes('tools.disabled'));
  assert.deepEqual(validatePatch({ 'tools.disabled': ['capture', 'bulk_ingest'] }), {
    tools: { disabled: ['capture', 'bulk_ingest'] },
  });
  // The patched shape resolves through the SAME validator (no second, laxer path).
  assert.deepEqual(resolveConfig(validatePatch({ 'tools.disabled': ['capture'] })).tools.disabled, ['capture']);
  assert.throws(
    () => resolveConfig(validatePatch({ 'tools.disabled': ['nope'] })),
    (error) => error.code === 'MEM_E_INVALID_TOOL_NAME',
  );
});

// ---- 2. registration + prompt pruning --------------------------------------

test('default: all tool suffixes are registered (zero regression)', async () => {
  await withPlugin({}, async ({ host }) => {
    const names = [...host.tools.keys()].sort();
    assert.equal(names.length, TOOL_SUFFIXES.length);
    for (const suffix of TOOL_SUFFIXES) assert.ok(names.includes(`memory_${suffix}`), `memory_${suffix} must be registered`);
  });
});

test('disabled [capture, bulk_ingest] skips registration and prompt advertisement', async () => {
  await withPlugin({ tools: { disabled: ['capture', 'bulk_ingest'] } }, async ({ host }) => {
    const names = [...host.tools.keys()].sort();
    assert.equal(names.length, TOOL_SUFFIXES.length - 2);
    assert.equal(names.includes('memory_capture'), false);
    assert.equal(names.includes('memory_bulk_ingest'), false);
    // Core tools survive; the rest stay registered.
    for (const suffix of CORE_TOOL_SUFFIXES) assert.ok(names.includes(`memory_${suffix}`));
    assert.ok(names.includes('memory_remember'));
    assert.ok(names.includes('memory_recall'));
    assert.ok(names.includes('memory_admin'));
    assert.ok(names.includes('memory_forget'));

    // Prompt advertisement follows the registered surface.
    const prompt = host.sections.find((section) => section.name === 'memory').text();
    assert.equal(prompt.includes('memory_capture'), false, 'a disabled tool must not be advertised');
    assert.equal(prompt.includes('memory_bulk_ingest'), false);
    assert.ok(prompt.includes('memory_remember'));
    assert.ok(prompt.includes('memory_recall'));
  });
});

// ---- 3. invalid config aborts activation -----------------------------------

test('an invalid tool name aborts activation before any tool is registered', async () => {
  const dir = tempDir('v155-tools-invalid');
  const host = fakeCtx();
  try {
    await assert.rejects(
      () => apply(host.ctx, { dataDir: dir, autoMaintainOnBoot: false, tools: { disabled: ['remeber'] } }),
      (error) => error.code === 'MEM_E_INVALID_TOOL_NAME',
    );
    assert.equal(host.tools.size, 0, 'activation must fail closed: zero tools registered');
  } finally {
    host.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
