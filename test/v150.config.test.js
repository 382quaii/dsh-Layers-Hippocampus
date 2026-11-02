/**
 * v1.5.0 configuration contract: the two new groups are strict, fail-fast and
 * reach both the running facade and the HTTP editor.
 *
 *   index.maxPostingsPerTag        tag-explosion defence (default 500)
 *   context.autoSpaceFollow        UI soft-follow (default false)
 *   context.autoRolloverEnabled    automatic handoff (default true)
 *   context.autoRolloverThreshold  handoff ratio (default 0.85)
 *   context.nativeTokenLimit       Qwen native window (default 8000)
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG, resolveConfig, toMemoryOptions } from '../src/config.js';
import { EDITABLE_CONFIG_KEYS, validatePatch } from '../src/webRoutes.js';
import { ErrorCodes } from '../src/errors.js';

test('documented v1.5.0 defaults', () => {
  const config = resolveConfig({});
  assert.equal(config.index.maxPostingsPerTag, 500);
  assert.equal(config.context.autoSpaceFollow, false);
  assert.equal(config.context.autoRolloverEnabled, true);
  assert.equal(config.context.autoRolloverThreshold, 0.85);
  assert.equal(config.context.nativeTokenLimit, 8000);
  assert.deepEqual({ ...DEFAULT_CONFIG.index }, { maxPostingsPerTag: 500 });
});

test('index.maxPostingsPerTag is range-checked, never clamped', () => {
  assert.equal(resolveConfig({ index: { maxPostingsPerTag: 1 } }).index.maxPostingsPerTag, 1);
  assert.equal(resolveConfig({ index: { maxPostingsPerTag: 100_000 } }).index.maxPostingsPerTag, 100_000);
  for (const bad of [0, -5, 100_001, 1.5, '500', null]) {
    assert.throws(
      () => resolveConfig({ index: { maxPostingsPerTag: bad } }),
      (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE' || error.code === 'MEM_E_CONFIG_INVALID_TYPE',
      `maxPostingsPerTag=${JSON.stringify(bad)} must be rejected`,
    );
  }
  // Top-level typos are rejected (nested-group keys follow the existing schema
  // convention: only declared fields are read).
  assert.throws(() => resolveConfig({ indices: { maxPostingsPerTag: 10 } }), (error) => error.code === 'MEM_E_CONFIG_UNKNOWN_KEY');
});

test('context rollover knobs are typed and bounded', () => {
  const config = resolveConfig({
    context: {
      autoSpaceFollow: true,
      autoRolloverEnabled: false,
      autoRolloverThreshold: 0.6,
      nativeTokenLimit: 1024,
    },
  });
  assert.deepEqual(
    {
      follow: config.context.autoSpaceFollow,
      enabled: config.context.autoRolloverEnabled,
      threshold: config.context.autoRolloverThreshold,
      native: config.context.nativeTokenLimit,
    },
    { follow: true, enabled: false, threshold: 0.6, native: 1024 },
  );

  // 0.5..0.99: below 0.5 would hand off on any short session, 1.0 can never fire.
  for (const bad of [0.49, 1, 0, 2]) {
    assert.throws(
      () => resolveConfig({ context: { autoRolloverThreshold: bad } }),
      (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
      `threshold=${bad} must be rejected`,
    );
  }
  for (const bad of [1, 511, 1_000_001, 1.5]) {
    assert.throws(
      () => resolveConfig({ context: { nativeTokenLimit: bad } }),
      (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE' || error.code === 'MEM_E_CONFIG_INVALID_TYPE',
      `nativeTokenLimit=${bad} must be rejected`,
    );
  }
  assert.throws(
    () => resolveConfig({ context: { autoSpaceFollow: 'yes' } }),
    (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE',
  );
  assert.throws(
    () => resolveConfig({ context: { autoRolloverEnabled: 1 } }),
    (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE',
  );
});

test('toMemoryOptions projects the new groups onto the running facade', () => {
  const config = resolveConfig({
    index: { maxPostingsPerTag: 42 },
    context: { nativeTokenLimit: 2048, autoRolloverThreshold: 0.9 },
  });
  const options = toMemoryOptions(config);
  assert.equal(options.config.index.maxPostingsPerTag, 42);
  assert.equal(options.config.context.nativeTokenLimit, 2048);
  assert.equal(options.config.context.autoRolloverThreshold, 0.9);
  // The context group is projected as a whole: every v1.5.0 key must survive.
  for (const key of ['autoSpaceFollow', 'autoRolloverEnabled', 'autoRolloverThreshold', 'nativeTokenLimit']) {
    assert.ok(key in options.config.context, `${key} must reach Memory/ContextEngine`);
  }
});

test('the five new keys are editable over HTTP and nested by validatePatch', () => {
  for (const key of [
    'index.maxPostingsPerTag',
    'context.autoSpaceFollow',
    'context.autoRolloverEnabled',
    'context.autoRolloverThreshold',
    'context.nativeTokenLimit',
  ]) {
    assert.ok(EDITABLE_CONFIG_KEYS.includes(key), `${key} must be editable from the settings panel`);
  }
  assert.deepEqual(
    validatePatch({
      'index.maxPostingsPerTag': 500,
      'context.autoSpaceFollow': true,
      'context.autoRolloverEnabled': true,
      'context.autoRolloverThreshold': 0.9,
      'context.nativeTokenLimit': 16000,
    }),
    {
      index: { maxPostingsPerTag: 500 },
      context: {
        autoSpaceFollow: true,
        autoRolloverEnabled: true,
        autoRolloverThreshold: 0.9,
        nativeTokenLimit: 16000,
      },
    },
  );
});

test('v1.5.0 error codes are stable strings (append-only contract)', () => {
  assert.equal(ErrorCodes.TIME_RANGE_REQUIRED, 'MEM_E_TIME_RANGE_REQUIRED');
  assert.equal(ErrorCodes.PRIVACY_BLOCKED, 'MEM_E_PRIVACY_BLOCKED');
});
