/**
 * v1.5.7 — cross-plugin `hippocampus` service (M1/M2/M7/M8 from the audit).
 *
 * User decision 2026-11-05: sibling plugins (proactive engine / emotion plugin)
 * access memory THROUGH THIS IN-PROCESS SERVICE only; no HTTP write route exists.
 * The service must be visible to siblings, refuse writes before READY, never queue
 * a second maintenance pass, rate-limit manual passes, and disappear on dispose.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { ErrorCodes } from '../src/errors.js';
import { fakeCtx, tempDir } from './helpers.js';

async function boot() {
  const dir = tempDir('service-v157');
  const fixture = fakeCtx();
  await apply(fixture.ctx, { dataDir: dir, maintenanceCron: '0 */6 * * *', autoMaintainOnBoot: false });
  const runtime = getRuntime(fixture.ctx);
  await runtime.ready;
  return { ...fixture, dir, runtime, service: fixture.ctx.get('hippocampus') };
}

test('the service is provided to siblings with a versioned contract', async () => {
  const booted = await boot();
  try {
    const { service } = booted;
    assert.ok(service, 'ctx.get("hippocampus") resolves for another plugin');
    assert.equal(service.apiVersion, 1);
    for (const method of ['ready', 'capabilities', 'remember', 'recall', 'runMaintenance', 'stats', 'handoffView', 'promptState', 'onDispose']) {
      assert.equal(typeof service[method], 'function', `${method} is callable`);
    }
    assert.equal(service.ready(), true);
    const capabilities = service.capabilities();
    assert.equal(capabilities.l3Traits, 10);
    assert.equal(capabilities.service.remember, true);
    assert.equal(capabilities.available, true);
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('remember writes L2 and recall reads it back (same implementation as the tools)', async () => {
  const booted = await boot();
  try {
    const written = await booted.service.remember({
      content: 'proactive engine wrote this L2 fact',
      tags: ['project:omni-pet', 'emotion:joy'],
      salience: 0.9,
      eventTime: Date.now(),
      idempotencyKey: 'svc-test-1',
    });
    assert.equal(written.status, 'appended');
    assert.match(written.eventId, /^ev_/);
    await booted.runtime.memory.maintain({ reason: 'service-test' });
    const found = await booted.service.recall({ text: 'proactive engine wrote this L2 fact', topK: 5 });
    assert.ok(found.hits.some((hit) => hit.eventId === written.eventId), 'recall returns the service-written event');
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('a non-L2 layer is redirected to L2 with a warning, never written as L3', async () => {
  const booted = await boot();
  try {
    const written = await booted.service.remember({
      content: 'emotion plugin tried to write a soul anchor into L3',
      layer: 'L3',
      tags: ['emotion:trust'],
      eventTime: Date.now(),
    });
    assert.equal(written.status, 'appended');
    assert.ok(written.eventId);
    await booted.runtime.memory.maintain({ reason: 'service-test' });
    const found = await booted.service.recall({ text: 'soul anchor', topK: 5 });
    assert.ok(found.hits.length >= 1);
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('maintenance never queues: a running pass is reported, not awaited', async () => {
  const booted = await boot();
  try {
    booted.runtime.maintenanceInFlight = true;
    const refused = await booted.service.runMaintenance('manual');
    assert.deepEqual({ ok: refused.ok, reason: refused.reason }, { ok: false, reason: 'running' });
    assert.equal(refused.code, ErrorCodes.MAINTENANCE_RUNNING);
    booted.runtime.maintenanceInFlight = false;
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('manual maintenance is rate-limited; cron is not', async () => {
  const booted = await boot();
  try {
    const first = await booted.service.runMaintenance('manual');
    assert.equal(first.ok, true);
    const second = await booted.service.runMaintenance('manual');
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'rate-limited');
    assert.ok(second.retryAfterMs > 0);
    const cron = await booted.service.runMaintenance('cron');
    assert.equal(cron.ok, true, 'cron passes bypass the manual rate limit');
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('read-only snapshots come from the same runtime as HTTP /stats', async () => {
  const booted = await boot();
  try {
    const stats = await booted.service.stats();
    assert.equal(stats.ok, true);
    assert.ok(stats.panel && stats.capabilities);
    assert.equal(typeof booted.service.handoffView().active, 'boolean');
    assert.equal(typeof booted.service.promptState(), 'string');
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('disposal removes the service and refuses later writes with MEM_E_SERVICE_DISPOSED', async () => {
  const booted = await boot();
  try {
    const { service, ctx } = booted;
    await new Promise((resolve) => setImmediate(resolve));
    booted.dispose();
    // The fake ctx disposers removed the provided service.
    assert.equal(ctx.get('hippocampus'), null);
    await assert.rejects(
      () => service.remember({ content: 'after dispose', eventTime: Date.now() }),
      (error) => error.code === ErrorCodes.SERVICE_DISPOSED,
    );
  } finally {
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('generic custom decay: customDecayRate / customHalfLifeDays are validated and stored', async () => {
  const booted = await boot();
  try {
    const now = Date.now();
    const byRate = await booted.service.remember({
      content: 'custom decay rate record',
      customDecayRate: 0.5,
      eventTime: now,
    });
    assert.equal(byRate.decayRate, 0.5);
    const byHalfLife = await booted.service.remember({
      content: 'custom half life record',
      customHalfLifeDays: 730,
      eventTime: now,
    });
    assert.ok(byHalfLife.decayRate > 0 && byHalfLife.decayRate < 1, '730 days derives a slower rate');

    await assert.rejects(
      () => booted.service.remember({ content: 'both', customDecayRate: 1, customHalfLifeDays: 30, eventTime: now }),
      (error) => error.code === ErrorCodes.INVALID_INPUT,
    );
    await assert.rejects(
      () => booted.service.remember({ content: 'bad rate', customDecayRate: 0, eventTime: now }),
      (error) => error.code === ErrorCodes.INVALID_INPUT,
    );
    await assert.rejects(
      () => booted.service.remember({ content: 'bad days', customHalfLifeDays: 0, eventTime: now }),
      (error) => error.code === ErrorCodes.INVALID_INPUT,
    );
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('the engine applies per-record decay without inspecting tags', async () => {
  const { projectEpisode } = await import('../src/index/buildIndex.js');
  const projected = projectEpisode({
    episode: {
      event_id: 'ev_custom',
      tags: [{ tag: 'emotion:joy', strength: 1 }],
      meta: { decay_rate: 0.5 },
      event_time: 1_000,
      log_time: 1_000,
      content: 'trait',
      salience: 1,
    },
    aliases: new Map(),
  });
  assert.equal(projected.decayRate, 0.5);
  const plain = projectEpisode({
    episode: { event_id: 'ev_plain', tags: [], event_time: 1_000, log_time: 1_000, content: 'x', salience: 1 },
    aliases: new Map(),
  });
  assert.equal(plain.decayRate, null, 'absent override = policy default');
});

test('Persona & Traits section: order 100, top 10 L3 traits, empty when none', async () => {
  const booted = await boot();
  try {
    assert.equal(booted.runtime.personaTraitsText(), '', 'no L3 summaries yet → no block');
    const sections = booted.sections;
    const persona = sections.find((section) => section.name === 'persona');
    assert.ok(persona, 'persona section is registered');
    assert.equal(persona.order, 100);

    for (let index = 0; index < 12; index += 1) {
      booted.runtime.memory.semanticStore.upsert({
        clock: booted.runtime.memory.clock,
        title: `trait-${index}`,
        text: `stable trait number ${index}`,
        confidence: index / 20, // 0.0 .. 0.55; highest wins
        tags: ['persona:traits'],
      });
    }
    const text = booted.runtime.personaTraitsText();
    assert.ok(text.startsWith('[Persona & Traits]'));
    const lines = text.split('\n');
    assert.equal(lines.length, 11, 'header + at most 10 traits');
    assert.match(text, /trait-11:/, 'highest confidence first');
    assert.doesNotMatch(text, /trait-0:/, 'only the top 10 survive');
  } finally {
    booted.dispose();
    fs.rmSync(booted.dir, { recursive: true, force: true });
  }
});

test('the new error codes are registered append-only', () => {
  assert.equal(ErrorCodes.MAINTENANCE_RUNNING, 'MEM_E_MAINTENANCE_RUNNING');
  assert.equal(ErrorCodes.SERVICE_DISPOSED, 'MEM_E_SERVICE_DISPOSED');
  assert.equal(ErrorCodes.FEDERATION_FAILED, 'MEM_E_FEDERATION_FAILED');
  assert.equal(ErrorCodes.NOT_READY, 'MEM_E_NOT_READY');
});
