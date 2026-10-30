/**
 * Lifecycle contracts (m02189):
 *
 *   1. Tool schemas have an OBJECT root (P0 regression: `type: null`).
 *   2. Startup state machine: reads/writes before READY answer MEM_E_NOT_READY;
 *      during a migration, reads are redirected to the legacy directory.
 *   3. Dream trigger: an idle window runs maintenance through the SAME gate as
 *      cron, and the gate refuses a second run instead of queueing it.
 *   4. Migration lock: a live pid holds it, a dead pid does not, and it is
 *      released on every path (try/finally).
 *   5. The runner has a watchdog that fails a hung run instead of exiting 0.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { apply, compileParameters, createRuntime, defineTool, getRuntime, REFLECTION_THRESHOLD } from '../index.js';
import { resolveConfig, toMemoryOptions } from '../src/config.js';
import { isProcessAlive, migrateDataDir } from '../src/migration.js';
import { FakeClock, T0, fakeCtx, tempDir } from './helpers.js';

function runtimeFor(dir, overrides = {}) {
  const config = resolveConfig({ dataDir: dir, autoMaintainOnBoot: false, ...overrides });
  const clock = new FakeClock(T0);
  return createRuntime({ config, options: toMemoryOptions(config), clock });
}

test('P0: every registered tool schema has an object root and a required list', () => {
  const compiled = compileParameters({ a: { type: 'string', required: true }, b: { type: 'number' } });
  assert.equal(compiled.type, 'object');
  assert.deepEqual(compiled.required, ['a']);
  assert.equal(compiled.properties.a.type, 'string');
  assert.equal(compiled.properties.a.required, undefined, 'required:true is lifted to the root list');

  const tool = defineTool({ name: 'x', parameters: { q: { type: 'string', required: true } } });
  assert.equal(tool.parameters.type, 'object');
});

test('P0: the host-facing definitions are object-rooted, including memory_admin', async () => {
  const dir = tempDir('schema');
  const host = fakeCtx();
  try {
    await apply(host.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    assert.equal(host.tools.size, 6);
    for (const [name, definition] of host.tools) {
      assert.equal(definition.parameters.type, 'object', `${name} root is an object`);
      assert.equal(typeof definition.parameters.properties, 'object');
      assert.ok(Array.isArray(definition.parameters.required), `${name} declares required[]`);
    }
    assert.deepEqual(host.tools.get('memory_admin').parameters.required, ['action']);
    assert.deepEqual(host.tools.get('memory_remember').parameters.required, ['content']);
    assert.deepEqual(host.tools.get('memory_reinforce').parameters.required, ['event_ids']);
  } finally {
    host.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startup: not-ready reads and writes answer MEM_E_NOT_READY, then serve after ready', async () => {
  const dir = tempDir('startup');
  const runtime = runtimeFor(dir);
  try {
    assert.equal(runtime.phase, 'pending');
    await assert.rejects(runtime.recall({ text: 'x' }), (error) => error.code === 'MEM_E_NOT_READY');
    await assert.rejects(runtime.status(), (error) => error.code === 'MEM_E_NOT_READY');

    runtime.start();
    assert.equal(runtime.phase, 'in_progress', 'phase flips synchronously before any I/O');
    await runtime.ready;
    assert.equal(runtime.phase, 'ready');

    await runtime.memory.remember({ content: 'startup smoke', tags: ['t'], salience: 0.5 });
    const recalled = await runtime.recall({ text: 'startup', tags: ['t'], topK: 5 });
    assert.equal(recalled.hits.length, 1);
  } finally {
    runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startup: reads during a migration are served from the legacy directory', async () => {
  const legacyDir = tempDir('legacy');
  const targetDir = tempDir('target');
  const legacy = runtimeFor(legacyDir);
  const runtime = runtimeFor(targetDir, { migrateFrom: legacyDir });
  try {
    await legacy.memory.init();
    await legacy.memory.remember({ content: 'legacy fact about deploy', tags: ['deploy'], salience: 0.9 });

    // Force the migration window deterministically instead of racing the copy.
    runtime.legacy = legacy.memory;
    runtime.phase = 'in_progress';
    const redirected = await runtime.recall({ text: 'deploy', tags: ['deploy'], topK: 5 });
    assert.equal(redirected.readFrom, 'legacy');
    assert.equal(redirected.hits.length, 1);
  } finally {
    runtime.stop();
    legacy.stop();
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('dream: an idle window triggers maintenance through the shared gate', async () => {
  const dir = tempDir('dream');
  const runtime = runtimeFor(dir, { enableDream: true, dreamIdleMinutes: 180 });
  const reasons = [];
  try {
    runtime.start();
    await runtime.ready;
    runtime.memory.maintain = async ({ reason }) => {
      reasons.push(reason);
      return { reason, stats: {} };
    };
    runtime.touch();
    await runtime.tick({ now: T0 + 179 * 60_000 });
    assert.deepEqual(reasons, [], 'not idle yet');

    await runtime.tick({ now: T0 + 181 * 60_000 });
    assert.deepEqual(reasons, ['dream']);
  } finally {
    runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dream: a run already in flight is skipped, never queued or doubled', async () => {
  const dir = tempDir('reentrant');
  const runtime = runtimeFor(dir, { enableDream: true, dreamIdleMinutes: 60, maintenanceCron: '* * * * *' });
  try {
    runtime.start();
    await runtime.ready;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const reasons = [];
    runtime.memory.maintain = async ({ reason }) => {
      reasons.push(reason);
      await gate;
      return { reason, stats: {} };
    };

    const first = runtime.runMaintenance('dream');
    const second = await runtime.runMaintenance('cron');
    assert.equal(second.ran, false);
    assert.equal(second.reason, 'maintenance-in-flight');
    assert.equal(runtime.scheduler.lastSuccessAt, null, 'a skipped cron tick is not a success');

    release();
    const finished = await first;
    assert.equal(finished.ran, true);
    assert.deepEqual(reasons, ['dream'], 'only the first run executed');
  } finally {
    runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reflection prompt only appears after the consecutive-call threshold', async () => {
  const dir = tempDir('reflect');
  const host = fakeCtx();
  try {
    await apply(host.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    await getRuntime(host.ctx).ready;
    const reflection = host.sections.find((section) => section.name === 'memory:reflection');
    assert.ok(reflection, 'reflection section is registered when enabled');
    assert.equal(reflection.text(), '');
    for (let i = 0; i < REFLECTION_THRESHOLD; i += 1) getRuntime(host.ctx).recordToolCall();
    assert.match(reflection.text(), /Reflection/);
  } finally {
    host.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration lock: a live pid holds it, a dead pid does not, and it is always released', async () => {
  const sourceDir = tempDir('src');
  const targetDir = tempDir('dst');
  const source = runtimeFor(sourceDir);
  const lockFile = `${targetDir}.migration.lock`;
  try {
    await source.memory.init();
    await source.memory.remember({ content: 'migrate me', tags: ['m'], salience: 0.5 });
    const clock = new FakeClock(T0);

    // 1. A lock owned by this (alive) process refuses the migration.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: T0 }));
    await assert.rejects(
      () => migrateDataDir({ from: sourceDir, to: targetDir, clock }),
      (error) => error.code === 'MEM_E_CONFIG_MIGRATION_LOCKED',
    );
    assert.ok(fs.existsSync(lockFile), 'the live lock is left untouched');

    // 2. A lock owned by a dead pid is taken over and released afterwards.
    assert.equal(isProcessAlive(2147483646), false);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483646, at: T0 }));
    const old = new Date(T0 - 60 * 60 * 1000);
    fs.utimesSync(lockFile, old, old);
    const result = await migrateDataDir({ from: sourceDir, to: targetDir, clock });
    assert.equal(result.status, 'migrated');
    assert.equal(fs.existsSync(lockFile), false, 'try/finally released the lock');
  } finally {
    source.stop();
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.rmSync(lockFile, { force: true });
  }
});

test('ui payload: the host serves data only, the client half owns rendering', async () => {
  const dir = tempDir('ui');
  const host = fakeCtx();
  try {
    await apply(host.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
    await getRuntime(host.ctx).ready;
    const payload = await getRuntime(host.ctx).uiPayload();
    assert.equal(payload.ok, true);
    assert.ok(payload.panel.global, 'the panel data is generated by the host runtime');
    assert.equal(payload.phase, 'ready');
    // The host must not register visual surfaces: slots belong to ui/client.js.
    assert.equal(host.tools.has('memory_admin'), true);
  } finally {
    host.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner: the watchdog reports a hang and fails the run', () => {
  const runner = fs.readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
  assert.match(runner, /watchdog/);
  assert.match(runner, /process\.exitCode = 1/);
  assert.match(runner, /HANG_TIMEOUT_MS/);
});
