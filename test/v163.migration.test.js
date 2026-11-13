/**
 * v1.6.3 — config schema migration + startup safety net (regression lock for the
 * 1.6.2 incident).
 *
 * Incident: a profile written for an older schema (`raw.retentionDays: 30`, no
 * `raw.archiveAfterDays`) was validated against the NEW default (90) and threw
 * MEM_E_CONFIG_OUT_OF_RANGE inside apply(). The plugin never registered its routes,
 * so the settings card sat on "正在启动…" and the UI saw HTTP 404 forever.
 *
 * The engine now has two independent guards:
 *   1. migrate-then-validate: `migrateConfig()` runs BEFORE strict validation and
 *      may inject values (with a console.warn + a returned warning list);
 *   2. `strictStartup` (default true): when explicitly false, an out-of-range value
 *      degrades to the safe default and the plugin still activates.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG_SCHEMA_VERSION, DEFAULT_CONFIG, migrateConfig, resolveConfig } from '../src/config.js';

function silentLogger() {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(message) };
}

// ---------------------------------------------------------------------------
// Task 1: migration mechanism
// ---------------------------------------------------------------------------
test('migrateConfig upgrades a version-less legacy config and reports why', () => {
  const logger = silentLogger();
  const result = migrateConfig({ raw: { retentionDays: 30 } }, { logger });
  assert.equal(result.migrated, true);
  assert.equal(result.fromVersion, 0);
  assert.equal(result.input.configVersion, CONFIG_SCHEMA_VERSION);
  assert.equal(result.input.raw.archiveAfterDays, 29, 'derived strictly below retentionDays');
  assert.ok(result.warnings.length >= 2, 'version + derived value are both reported');
  assert.ok(logger.warnings.some((line) => line.includes('configVersion')));
  assert.ok(logger.warnings.some((line) => line.includes('archiveAfterDays')));
});

test('migrateConfig leaves a current config untouched', () => {
  const logger = silentLogger();
  const current = {
    configVersion: CONFIG_SCHEMA_VERSION,
    raw: { retentionDays: 365, archiveAfterDays: 90 },
  };
  const result = migrateConfig(current, { logger });
  assert.equal(result.migrated, false);
  assert.equal(result.fromVersion, CONFIG_SCHEMA_VERSION);
  assert.equal(result.input.raw.archiveAfterDays, 90, 'explicit value preserved');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(logger.warnings, []);
});

test('migrateConfig never throws and never invents a value the operator already set', () => {
  assert.doesNotThrow(() => migrateConfig(null));
  assert.doesNotThrow(() => migrateConfig(undefined));
  const explicit = migrateConfig({ raw: { retentionDays: 30, archiveAfterDays: 5 } });
  assert.equal(explicit.input.raw.archiveAfterDays, 5);
});

// ---------------------------------------------------------------------------
// Task 3 assertion 1: legacy config boots with derived archiveAfterDays = 29
// ---------------------------------------------------------------------------
test('a legacy profile (only retentionDays: 30) boots with archiveAfterDays derived to 29', () => {
  const config = resolveConfig({ raw: { retentionDays: 30 } });
  assert.equal(config.raw.retentionDays, 30);
  assert.equal(config.raw.archiveAfterDays, 29);
  assert.ok(config.raw.archiveAfterDays < config.raw.retentionDays);
  assert.equal(config.configVersion, CONFIG_SCHEMA_VERSION);
  assert.equal(config.startup.migrated, true);
  assert.equal(config.startup.degraded, false);
  assert.equal(config.startup.strict, true, 'strictStartup defaults to true');
  assert.ok(config.warnings.length > 0, 'migration is never silent');
});

// ---------------------------------------------------------------------------
// Task 3 assertion 2: explicit conflict — strict blocks, non-strict degrades
// ---------------------------------------------------------------------------
test('an explicit conflict is BLOCKED when strictStartup is true (default)', () => {
  assert.throws(
    () => resolveConfig({ raw: { retentionDays: 30, archiveAfterDays: 90 } }),
    (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
  );
  assert.throws(
    () => resolveConfig({ raw: { retentionDays: 30, archiveAfterDays: 90 }, strictStartup: true }),
    (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
  );
});

test('an explicit conflict DEGRADES to a safe default when strictStartup is false', () => {
  const config = resolveConfig({
    raw: { retentionDays: 30, archiveAfterDays: 90 },
    strictStartup: false,
  });
  assert.equal(config.startup.strict, false);
  assert.equal(config.startup.degraded, true);
  assert.equal(config.startup.degradedReason?.code, 'MEM_E_CONFIG_OUT_OF_RANGE');
  assert.equal(config.startup.degradedReason?.key, 'raw.archiveAfterDays');
  assert.ok(config.raw.archiveAfterDays < config.raw.retentionDays, 'safe value survives');
  assert.ok(
    config.warnings.some((warning) => warning.includes('strictStartup=false')),
    'degradation is reported, never silent',
  );
});

test('strictStartup:false does NOT swallow invalid types or unknown keys', () => {
  // Only out-of-range values degrade; a typo must still be loud.
  assert.throws(
    () => resolveConfig({ raw: { retentionDays: 30, archiveAfterDays: 90 }, strictStartup: false, notAKey: 1 }),
    (error) => error.code === 'MEM_E_CONFIG_UNKNOWN_KEY',
  );
  assert.throws(
    () => resolveConfig({ briefing: 'yes', strictStartup: false }),
    (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE',
  );
});

test('strictStartup must itself be a boolean', () => {
  assert.throws(
    () => resolveConfig({ strictStartup: 'no' }),
    (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE',
  );
  assert.equal(DEFAULT_CONFIG.strictStartup, true);
});

// ---------------------------------------------------------------------------
// The real-world profile shape from the incident
// ---------------------------------------------------------------------------
test('the exact 1.6.2 production profile shape now resolves cleanly', () => {
  const config = resolveConfig({
    dataDir: 'D:\\Users\\86135\\memory',
    briefing: true,
    enableDream: true,
    enableReflection: true,
    context: { maxTokens: 4000, threshold: 0.85, target: 0.7 },
    temp: { ttlDays: 30, promotionWindowDays: 20 },
    decay: { halfLifeDays: 30 },
    activeSet: { cap: 200 },
    index: { maxPostingsPerTag: 500 },
    tools: { disabled: [] },
    raw: { mode: 'salience', minSalience: 0.6, maxTotalMb: 256, retentionDays: 30, maxScanTurns: 5000 },
    delete: { graceHours: 24 },
    review: { enabled: true },
    tagTree: { midHalfLifeMultiplier: 3, midGracePeriodDays: 30, pruneBatchSize: 100, leafDecayFloor: 0 },
  });
  assert.equal(config.raw.retentionDays, 30);
  assert.equal(config.raw.archiveAfterDays, 29);
  assert.equal(config.startup.degraded, false);
  // This is the assertion that would have failed (with an exception) in 1.6.2.
  assert.ok(config.raw.archiveAfterDays >= 1);
});
