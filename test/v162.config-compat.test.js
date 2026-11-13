/**
 * v1.6.2 — config compatibility regression (the "设置页一直正在启动 / HTTP 404" bug).
 *
 * Root cause: a profile written before 1.6.2 pins `raw.retentionDays: 30` and has no
 * `raw.archiveAfterDays`. The new default archiveAfterDays is 90, so the strict
 * "archiveAfterDays < retentionDays" rule threw MEM_E_CONFIG_OUT_OF_RANGE during
 * apply() — the plugin never registered its routes, so the UI polled
 * /api/hippocampus/stats and got 404 forever.
 *
 * Contract now:
 *   - archiveAfterDays NOT stated by the caller -> derive a valid value (retention-1)
 *     and flag `archiveAfterDaysDerived`, so legacy profiles keep booting;
 *   - archiveAfterDays EXPLICITLY stated and out of range -> still fail fast.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';

test('a legacy profile (retentionDays 30, no archiveAfterDays) still boots', () => {
  const legacy = resolveConfig({
    raw: { mode: 'salience', minSalience: 0.6, maxTotalMb: 256, retentionDays: 30, maxScanTurns: 5000 },
  });
  assert.equal(legacy.raw.retentionDays, 30);
  assert.equal(legacy.raw.archiveAfterDays, 29, 'derived to stay strictly below retention');
  assert.equal(legacy.raw.archiveAfterDaysDerived, true);
  assert.ok(legacy.raw.archiveAfterDays < legacy.raw.retentionDays);
});

test('defaults are still the documented 90 / 365 pair', () => {
  const config = resolveConfig({});
  assert.equal(config.raw.archiveAfterDays, 90);
  assert.equal(config.raw.retentionDays, 365);
  assert.equal(config.raw.coldAccessWindowDays, 90);
  assert.equal(config.raw.archiveAfterDaysDerived, false);
});

test('an EXPLICIT out-of-range archiveAfterDays still fails fast', () => {
  assert.throws(
    () => resolveConfig({ raw: { retentionDays: 30, archiveAfterDays: 90 } }),
    (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
  );
  assert.throws(
    () => resolveConfig({ raw: { retentionDays: 90, archiveAfterDays: 90 } }),
    (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
  );
});

test('an explicit VALID archiveAfterDays is preserved verbatim', () => {
  const config = resolveConfig({ raw: { retentionDays: 180, archiveAfterDays: 60 } });
  assert.equal(config.raw.archiveAfterDays, 60);
  assert.equal(config.raw.archiveAfterDaysDerived, false);
});

test('prune also drops archives that fell out of retention (no unbounded .br)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { RawStore, RAW_DIR } = await import('../src/rawStore.js');
  const { FakeClock, tempDir } = await import('./helpers.js');
  const dir = tempDir('prune-archive');
  const now = Date.UTC(2026, 5, 1);
  try {
    const store = new RawStore({
      dataDir: dir,
      clock: new FakeClock(now),
      getConfig: () => ({ raw: { mode: 'all', retentionDays: 30, archiveAfterDays: 29 } }),
    });
    fs.mkdirSync(path.join(dir, RAW_DIR), { recursive: true });
    // A month far outside the 30-day retention window.
    const oldArchive = path.join(dir, RAW_DIR, 'raw-archive-2026-01.jsonl.br');
    fs.writeFileSync(oldArchive, 'compressed');
    // A month that is still inside the window must survive.
    const freshArchive = path.join(dir, RAW_DIR, 'raw-archive-2026-05.jsonl.br');
    fs.writeFileSync(freshArchive, 'compressed');

    const result = await store.prune({ now });
    assert.deepEqual(result.removedArchives, ['2026-01']);
    assert.ok(!fs.existsSync(oldArchive), 'expired archive removed');
    assert.ok(fs.existsSync(freshArchive), 'in-window archive kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
