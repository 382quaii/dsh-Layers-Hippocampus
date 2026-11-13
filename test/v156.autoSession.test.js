/**
 * v1.5.6 feature, REMOVED in v1.6.3 — "automatically open a new conversation on
 * handoff".
 *
 * Why it was removed (user report 2026-11-13): a handoff fires mid-conversation and
 * the host CONTINUES that same conversation, so the client-side controller opened a
 * dangling second conversation right after the marker — useless in the "append to the
 * existing conversation" flow and actively harmful to the experience.
 *
 * This suite now locks the REMOVAL, so the feature cannot silently grow back (and a
 * stale profile that still carries the three keys keeps booting instead of failing on
 * an unknown key).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { migrateConfig, resolveConfig } from '../src/config.js';
import { EDITABLE_CONFIG_KEYS } from '../src/webRoutes.js';
import { fakeCtx, tempDir } from './helpers.js';

const REMOVED = ['autoNewSession', 'autoNewSessionPoll', 'autoNewSessionIntervalSeconds'];

test('the three auto-new-session keys are gone from the resolved config', () => {
  const resolved = resolveConfig({});
  for (const key of REMOVED) {
    assert.equal(Object.prototype.hasOwnProperty.call(resolved.context, key), false, `${key} must not be resolved`);
  }
});

test('a legacy profile carrying the keys is migrated, not rejected', () => {
  const warnings = [];
  const legacy = { context: { autoNewSession: true, autoNewSessionPoll: 'once', autoNewSessionIntervalSeconds: 30 } };
  const migration = migrateConfig(legacy, { logger: { warn: (line) => warnings.push(String(line)) } });
  assert.equal(migration.migrated, true);
  for (const key of REMOVED) {
    assert.equal(Object.prototype.hasOwnProperty.call(migration.input.context, key), false);
  }
  assert.ok(
    warnings.some((line) => line.includes('autoNewSession')),
    'the migration must say what it dropped',
  );
  // And the whole pipeline still resolves (no MEM_E_CONFIG_UNKNOWN_KEY).
  const resolved = resolveConfig(legacy, { env: {} });
  assert.equal(resolved.context.coldStartInjectSummary, true);
  // Explicit values for the KEPT keys survive untouched.
  assert.equal(resolveConfig({ context: { coldStartInjectRecentTurns: false } }, { env: {} }).context.coldStartInjectRecentTurns, false);
});

test('neither route keys nor capabilities advertise autoNewSession', async () => {
  for (const key of REMOVED) {
    assert.equal(EDITABLE_CONFIG_KEYS.includes(`context.${key}`), false, `${key} must not be editable over HTTP`);
  }
  const dir = tempDir('auto-session-removed');
  const fixture = fakeCtx();
  try {
    await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    const runtime = getRuntime(fixture.ctx);
    await runtime.ready;
    const payload = await runtime.uiPayload();
    assert.equal('autoNewSession' in payload.capabilities, false);
    assert.equal('autoNewSession' in payload.handoff, false);
    assert.equal(payload.handoff.active, false, 'no handoff yet');
  } finally {
    fixture.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the client half no longer polls or opens conversations', () => {
  const source = fs.readFileSync(new URL('../ui/client.js', import.meta.url), 'utf8');
  for (const needle of [...REMOVED, 'startAutoNewSession', 'uiWorkspace']) {
    assert.equal(source.includes(needle), false, `ui/client.js must not reference ${needle}`);
  }
  // Cold-start injection switches remain, and "previous turns" now defaults ON.
  assert.ok(source.includes('context.coldStartInjectSummary'));
  assert.ok(source.includes('context.coldStartInjectRecentTurns'));
  assert.ok(
    source.includes('(config.context && config.context.coldStartInjectRecentTurns) !== false'),
    'recent-turn injection defaults on',
  );
});
