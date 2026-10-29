/**
 * Config resolution: fail-fast only. Every case below asserts a specific
 * `MEM_E_CONFIG_*` code, because a silent fallback is the bug this suite exists to
 * prevent (a typo in `threshold` must not quietly change retrieval behaviour).
 *
 * No clock is needed: resolving config must be a pure function of the raw object.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_CONFIG, resolveConfig, toMemoryOptions } from '../src/config.js';

function codeOf(fn) {
  let code = null;
  assert.throws(fn, (error) => {
    code = error.code;
    return typeof error.code === 'string';
  });
  return code;
}

test('config defaults are the documented values', () => {
  const config = resolveConfig({}, { env: { DSH_HOME: 'C:/dsh' } });
  assert.equal(config.maintenanceCron, '0 */6 * * *');
  assert.equal(config.retrieval.topK, 20);
  assert.equal(config.context.maxTokens, 4000);
  assert.equal(config.context.threshold, 0.85);
  assert.equal(config.context.target, 0.7);
  assert.equal(config.temp.ttlDays, 30);
  assert.equal(config.temp.promotionWindowDays, 20);
  assert.equal(config.identity.eventTimePolicy, 'content');
  assert.equal(config.dataDir, 'C:/dsh/memory');
  assert.ok(config.dataDir.endsWith('/memory'), 'dataDir lives under the DSH home directory');
  // Without DSH_HOME the default must stay ABSOLUTE: a relative path would resolve
  // against the host's cwd (the profile dir) and silently move the whole store.
  const fallback = resolveConfig({}, { env: {} }).dataDir;
  assert.ok(fallback.endsWith('/.dsh/memory'), `absolute fallback, got ${fallback}`);
  assert.ok(/^([A-Za-z]:[\\/]|\/)/.test(fallback), 'not relative');
});

test('graphMaxEdges defaults to 500 and is fail-fast outside 100..2000', () => {
  assert.equal(resolveConfig({}, { env: { DSH_HOME: 'C:/dsh' } }).graphMaxEdges, 500);
  assert.equal(resolveConfig({ graphMaxEdges: 100 }).graphMaxEdges, 100);
  assert.equal(resolveConfig({ graphMaxEdges: 2000 }).graphMaxEdges, 2000);
  for (const bad of [99, 2001, 0, -1, 1.5, '500', null]) {
    assert.throws(
      () => resolveConfig({ graphMaxEdges: bad }, { env: { DSH_HOME: 'C:/dsh' } }),
      (error) => String(error.code).startsWith('MEM_E_CONFIG'),
      `graphMaxEdges=${JSON.stringify(bad)} must be rejected, not clamped`,
    );
  }
});

test('the deprecated interval key is a hard error, not an ignored field', () => {
  let details = null;
  assert.throws(
    () => resolveConfig({ maintenanceIntervalMinutes: 120 }),
    (error) => {
      details = error.details;
      return error.code === 'MEM_E_CONFIG_DEPRECATED';
    },
  );
  assert.equal(details.key, 'maintenanceIntervalMinutes');
  assert.equal(details.replacement, 'maintenanceCron');
});

test('a bad cron expression fails with CONFIG_INVALID_CRON', () => {
  assert.equal(codeOf(() => resolveConfig({ maintenanceCron: '* * * *' })), 'MEM_E_CONFIG_INVALID_CRON');
  assert.equal(codeOf(() => resolveConfig({ maintenanceCron: '0 0 0 * * *' })), 'MEM_E_CONFIG_INVALID_CRON');
  assert.equal(codeOf(() => resolveConfig({ maintenanceCron: '60 * * * *' })), 'MEM_E_CONFIG_INVALID_CRON');
  assert.equal(codeOf(() => resolveConfig({ maintenanceCron: '*/0 * * * *' })), 'MEM_E_CONFIG_INVALID_CRON');
});

test('out-of-range thresholds fail instead of being clamped', () => {
  assert.equal(codeOf(() => resolveConfig({ context: { threshold: 1.5 } })), 'MEM_E_CONFIG_OUT_OF_RANGE');
  assert.equal(codeOf(() => resolveConfig({ context: { threshold: 0 } })), 'MEM_E_CONFIG_OUT_OF_RANGE');
  assert.equal(codeOf(() => resolveConfig({ context: { target: 0.9 } })), 'MEM_E_CONFIG_OUT_OF_RANGE');
  assert.equal(codeOf(() => resolveConfig({ retrieval: { topK: 0 } })), 'MEM_E_CONFIG_OUT_OF_RANGE');
  assert.equal(codeOf(() => resolveConfig({ retrieval: { topK: 101 }, maxRecallTopK: 100 })), 'MEM_E_CONFIG_OUT_OF_RANGE');
});

test('an unknown enum value fails with CONFIG_UNKNOWN_ENUM', () => {
  assert.equal(codeOf(() => resolveConfig({ identity: { eventTimePolicy: 'clock' } })), 'MEM_E_CONFIG_UNKNOWN_ENUM');
});

test('unknown keys and alias conflicts are rejected', () => {
  assert.equal(codeOf(() => resolveConfig({ dataDIR: '/tmp/x' })), 'MEM_E_CONFIG_UNKNOWN_KEY');
  assert.equal(
    codeOf(() => resolveConfig({ retrievalTopK: 5, retrieval: { topK: 5 } })),
    'MEM_E_CONFIG_CONFLICT',
  );
  // `_`-prefixed keys are reserved for loader comments and are ignored.
  assert.equal(resolveConfig({ _comment: 'hi', retrieval: { topK: 7 } }).retrieval.topK, 7);
});

test('flat aliases resolve to the canonical nested shape', () => {
  const config = resolveConfig({
    contextThreshold: 0.9,
    contextTarget: 0.6,
    tempTtlDays: 10,
    tempPromotionWindowDays: 5,
    eventTimePolicy: 'explicit',
  });
  assert.equal(config.context.threshold, 0.9);
  assert.equal(config.context.target, 0.6);
  assert.equal(config.temp.ttlDays, 10);
  assert.equal(config.identity.eventTimePolicy, 'explicit');
  assert.equal(config.context.maxTokens, DEFAULT_CONFIG.context.maxTokens);
});

test('toMemoryOptions maps config onto the Memory constructor without losing keys', () => {
  const config = resolveConfig({
    retrieval: { topK: 12 },
    context: { maxTokens: 2048, threshold: 0.8, target: 0.5 },
    temp: { ttlDays: 7, promotionWindowDays: 5 },
    identity: { eventTimePolicy: 'explicit' },
    maintenanceCron: '15 * * * *',
  });
  const options = toMemoryOptions(config);
  assert.equal(options.dataDir, config.dataDir);
  assert.equal(options.policy.identity.eventTimePolicy, 'explicit');
  assert.equal(options.policy.temp.ttlDays, 7);
  assert.equal(options.policy.temp.promotionWindowDays, 5);
  assert.equal(options.config.context.maxTokens, 2048);
  assert.equal(options.config.context.threshold, 0.8);
  assert.equal(options.config.context.target, 0.5);
  assert.equal(options.config.maintenanceCron, '15 * * * *');
  assert.equal(options.config.identity.eventTimePolicy, 'explicit');
  assert.equal(config.retrieval.topK, 12, 'retrieval.topK stays in the config namespace (the tools read it)');
});
