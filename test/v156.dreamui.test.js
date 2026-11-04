/**
 * v1.5.6 — Dream tunables become UI/HTTP-editable, credentials stay private.
 *
 * Locked contracts:
 *   1. `/stats` + `/config` expose the SAFE dream subset only — never
 *      `dream.llm.{baseUrl,model,apiKey}`;
 *   2. those keys are accepted by `validatePatch` (HTTP-editable) while
 *      `dream.llm.*` is rejected as not editable;
 *   3. the settings page really renders the Dream section (source contract).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { apply, getRuntime } from '../index.js';
import { EDITABLE_CONFIG_KEYS, validatePatch } from '../src/webRoutes.js';
import { tempDir } from './helpers.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function fakeCtx() {
  const tools = new Map();
  const sections = new Map();
  const contexts = new Map();
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    systemPrompt: {
      section(definition) {
        sections.set(definition.name, definition);
        return () => sections.delete(definition.name);
      },
      context(definition) {
        contexts.set(definition.name, definition);
        return () => contexts.delete(definition.name);
      },
    },
    effect(factory) {
      const disposer = factory();
      effects.push(disposer);
      return disposer;
    },
    get() {
      return null;
    },
    inject(_deps, callback) {
      callback(ctx);
      return () => {};
    },
    contexts,
    async dispose() {
      for (const disposer of effects.reverse()) {
        if (typeof disposer === 'function') await disposer();
      }
    },
  };
  ctx.root = ctx;
  return ctx;
}

test('the safe dream subset is exposed, the credentials are not', async () => {
  const dir = tempDir('dream-ui');
  const ctx = fakeCtx();
  try {
    await apply(ctx, {
      dataDir: dir,
      maintenanceCron: '0 */6 * * *',
      autoMaintainOnBoot: false,
      dream: {
        useLlm: false,
        maxSummaryChars: 180,
        compensateAfterHours: 12,
        llm: { baseUrl: 'https://llm.example/v1', model: 'distill-1', apiKey: 'SECRET-KEY' },
      },
    });
    const runtime = getRuntime(ctx);
    await runtime.ready;

    const payload = await runtime.uiPayload();
    const dream = payload.config.dream;
    assert.equal(dream.useLlm, false);
    assert.equal(dream.maxSummaryChars, 180);
    assert.equal(dream.compensateAfterHours, 12);
    assert.equal(dream.llmTimeoutMs, 15_000);
    assert.equal(Object.hasOwn(dream, 'llm'), false, 'the credential block never reaches the browser');
    assert.ok(!JSON.stringify(payload).includes('SECRET-KEY'), 'no API key in the payload');
    assert.ok(!JSON.stringify(payload).includes('llm.example'), 'no endpoint in the payload');
  } finally {
    await ctx.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dream tunables are HTTP-editable, dream.llm.* is not', () => {
  for (const key of [
    'dream.useLlm',
    'dream.minGroupSize',
    'dream.maxGroupsPerRun',
    'dream.maxSummaryChars',
    'dream.maxSourceChars',
    'dream.maxEventsPerGroup',
    'dream.llmTimeoutMs',
    'dream.failureThreshold',
    'dream.cooldownMinutes',
    'dream.compensateAfterHours',
  ]) {
    assert.ok(EDITABLE_CONFIG_KEYS.includes(key), `${key} must be editable`);
  }
  for (const key of ['dream.llm', 'dream.llm.baseUrl', 'dream.llm.model', 'dream.llm.apiKey']) {
    assert.ok(!EDITABLE_CONFIG_KEYS.includes(key), `${key} must stay private`);
  }

  assert.deepEqual(validatePatch({ 'dream.maxSummaryChars': 300, 'dream.cooldownMinutes': 30 }), {
    dream: { maxSummaryChars: 300, cooldownMinutes: 30 },
  });
  assert.throws(
    () => validatePatch({ 'dream.llm.apiKey': 'x' }),
    (error) => error.code === 'MEM_E_CONFIG_UNKNOWN_KEY',
  );
});

test('the settings page renders the offline Dream section', () => {
  const source = fs.readFileSync(path.join(ROOT, 'ui', 'client.js'), 'utf8');
  assert.ok(source.includes('离线 Dream（LLM 蒸馏）'), 'the section title is rendered');
  for (const key of ['dream.useLlm', 'dream.compensateAfterHours', 'dream.failureThreshold']) {
    assert.ok(source.includes(key), `${key} is wired into the form`);
  }
  assert.ok(!source.includes('dream.llm.apiKey'), 'the form never offers a credential field');
});
