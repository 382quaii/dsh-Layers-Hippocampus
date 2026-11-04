/**
 * v1.5.5 — Dream LLM distillation with an absolute local fallback.
 *
 * Locked contracts:
 *   1. no LLM configured  -> executeDream still completes, local merge, provenance;
 *   2. native fetch fails / times out / returns non-JSON -> degrade, warn;
 *   3. provider/key are injected (config), never hard-coded, never leaked;
 *   4. a second concurrent executeDream is refused (single-flight, no queue);
 *   5. circuit breaker opens after N consecutive failures and half-opens after the
 *      cooldown, probing exactly once;
 *   6. package.json stays dependency-free (charter v2.0 #1).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DAY_MS, T0, logRecords, makeMemory } from './helpers.js';
import { resolveConfig } from '../src/config.js';
import { DREAM_FALLBACK_CODE, DREAM_TAG } from '../src/dream.js';

function collectingLogger() {
  const lines = [];
  return {
    lines,
    info() {},
    error() {},
    debug() {},
    warn(message) {
      lines.push(String(message));
    },
  };
}

function jsonResponse(content, { status = 200, ok = true } = {}) {
  return { ok, status, json: async () => ({ choices: [{ message: { content } }] }) };
}

/** Two same-tag turns: enough for the default minGroupSize of 2 in these tests. */
async function seed(memory, tag, count = 2, base = T0) {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const result = await memory.remember({
      content: `${tag} 第 ${index + 1} 次：upstream timed out after 30s in release gate`,
      tags: [tag],
      salience: 0.9,
      eventTime: base + index * 1000,
    });
    ids.push(result.eventId);
  }
  return ids;
}

const LLM_CONFIG = {
  minGroupSize: 2,
  llm: { baseUrl: 'https://llm.example/v1', model: 'distill-1', apiKey: 'test-key' },
};

test('no LLM config: Dream completes through the local merge and keeps source_event_ids', async () => {
  const fixture = await makeMemory({ config: { dream: { minGroupSize: 2 } } });
  try {
    const sourceIds = await seed(fixture.memory, 'error:timeout');
    const logger = collectingLogger();
    const report = await fixture.memory.executeDream({ now: T0 + DAY_MS, logger });

    assert.equal(report.status, 'ok');
    assert.equal(report.merged, 1);
    assert.equal(report.results[0].distilledBy, 'local');
    assert.equal(report.results[0].fallbackReason, 'llm-not-configured');
    assert.ok(report.fallbacks.some((entry) => entry.code === DREAM_FALLBACK_CODE));
    assert.ok(logger.lines.some((line) => line.includes(DREAM_FALLBACK_CODE)), 'fallback must warn loudly');

    const record = logRecords(fixture.dir).find((entry) => entry.meta?.dream === true);
    assert.ok(record, 'a distilled record must be written');
    assert.equal(record.meta.distilled_by, 'local');
    assert.deepEqual([...record.meta.source_event_ids].sort(), [...sourceIds].sort());
    assert.ok(record.content.length <= 200, 'local summary obeys maxSummaryChars');
    assert.ok(record.content.includes('error:timeout'));
    const tags = record.tags.map((tag) => tag.tag ?? tag);
    assert.ok(tags.includes(DREAM_TAG), 'the distilled record carries the dream tag');
    assert.ok(tags.includes('error:timeout'), 'and the source tag');
    assert.ok(fixture.memory.dreamStatus().lastFallback.code === DREAM_FALLBACK_CODE);
  } finally {
    fixture.cleanup();
  }
});

test('LLM success: strict JSON is accepted, provenance inherited, no fallback warning', async () => {
  const fixture = await makeMemory({ config: { dream: LLM_CONFIG } });
  try {
    const sourceIds = await seed(fixture.memory, 'error:timeout');
    const calls = [];
    const logger = collectingLogger();
    const fetchImpl = async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse('```json\n{"summary":"上游超时应在发布门禁前加退避重试","confidence":0.82}\n```');
    };
    const report = await fixture.memory.executeDream({ now: T0 + DAY_MS, logger, fetchImpl });

    assert.equal(report.merged, 1);
    assert.equal(report.llmSuccess, 1);
    assert.equal(report.results[0].distilledBy, 'llm');
    assert.equal(report.results[0].fallbackReason, null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://llm.example/v1/chat/completions');
    assert.equal(calls[0].options.headers.authorization, 'Bearer test-key');
    assert.equal(calls[0].body.model, 'distill-1');
    assert.equal(calls[0].body.response_format.type, 'json_object');
    assert.ok(logger.lines.length === 0, 'a successful LLM call must not warn');

    const record = logRecords(fixture.dir).find((entry) => entry.meta?.dream === true);
    assert.equal(record.content, '上游超时应在发布门禁前加退避重试');
    assert.equal(record.meta.distilled_by, 'llm');
    assert.equal(record.meta.confidence, 0.82);
    assert.deepEqual([...record.meta.source_event_ids].sort(), [...sourceIds].sort());
  } finally {
    fixture.cleanup();
  }
});

test('non-JSON LLM answer: degrades locally and warns MEM_E_DREAM_LLM_FALLBACK', async () => {
  const fixture = await makeMemory({ config: { dream: LLM_CONFIG } });
  try {
    await seed(fixture.memory, 'error:oom');
    const logger = collectingLogger();
    const report = await fixture.memory.executeDream({
      now: T0 + DAY_MS,
      logger,
      fetchImpl: async () => jsonResponse('这不是 JSON，只是一段自由发挥'),
    });
    assert.equal(report.results[0].distilledBy, 'local');
    assert.equal(report.results[0].fallbackReason, 'llm-error');
    assert.ok(logger.lines.some((line) => line.includes(DREAM_FALLBACK_CODE)));
    const record = logRecords(fixture.dir).find((entry) => entry.meta?.dream === true);
    assert.equal(record.meta.distilled_by, 'local');
  } finally {
    fixture.cleanup();
  }
});

test('fetch timeout: the race aborts the attempt and falls back locally', async () => {
  const fixture = await makeMemory({
    config: { dream: { ...LLM_CONFIG, llmTimeoutMs: 500 } },
  });
  try {
    await seed(fixture.memory, 'error:network');
    const logger = collectingLogger();
    const startedAt = Date.now();
    const report = await fixture.memory.executeDream({
      now: T0 + DAY_MS,
      logger,
      // Never resolves: only the engine's own timeout can end this call.
      fetchImpl: () => new Promise(() => {}),
    });
    assert.ok(Date.now() - startedAt < 5000, 'the call must not hang');
    assert.equal(report.results[0].distilledBy, 'local');
    assert.equal(report.results[0].fallbackReason, 'timeout');
    assert.ok(logger.lines.some((line) => line.includes(DREAM_FALLBACK_CODE)));
  } finally {
    fixture.cleanup();
  }
});

test('single-flight: a concurrent Dream is refused instead of queued', async () => {
  const fixture = await makeMemory({ config: { dream: { minGroupSize: 2 } } });
  try {
    await seed(fixture.memory, 'error:busy');
    const first = fixture.memory.executeDream({ now: T0 + DAY_MS });
    const second = await fixture.memory.executeDream({ now: T0 + DAY_MS });
    const firstReport = await first;
    assert.equal(second.status, 'skipped');
    assert.equal(second.reason, 'dream-in-flight');
    assert.equal(firstReport.merged, 1);
  } finally {
    fixture.cleanup();
  }
});

test('circuit breaker: opens after the threshold and half-opens after the cooldown', async () => {
  const fixture = await makeMemory({
    config: {
      dream: {
        ...LLM_CONFIG,
        maxGroupsPerRun: 1,
        failureThreshold: 2,
        cooldownMinutes: 1,
      },
    },
  });
  try {
    // Four distinct groups so each run has fresh work (one group per run).
    for (const tag of ['error:g1', 'error:g2', 'error:g3', 'error:g4']) await seed(fixture.memory, tag);
    let fetchCalls = 0;
    const failing = async () => {
      fetchCalls += 1;
      throw new Error('network down');
    };
    const logger = collectingLogger();
    const now = T0 + DAY_MS;

    const first = await fixture.memory.executeDream({ now, logger, fetchImpl: failing });
    assert.equal(first.circuit.consecutiveFailures, 1);
    assert.equal(first.circuit.state, 'closed');

    const second = await fixture.memory.executeDream({ now, logger, fetchImpl: failing });
    assert.equal(second.circuit.consecutiveFailures, 2);
    assert.equal(second.circuit.state, 'open');

    // Open: the next run must NOT touch the network.
    const thirdCalls = fetchCalls;
    const third = await fixture.memory.executeDream({ now, logger, fetchImpl: failing });
    assert.equal(fetchCalls, thirdCalls, 'an open circuit must not call fetch');
    assert.equal(third.results[0].fallbackReason, 'circuit-open');
    assert.equal(third.results[0].distilledBy, 'local');

    // Cooldown elapsed -> half-open: exactly one probe, success closes the breaker.
    const later = now + 60_001;
    const probe = await fixture.memory.executeDream({
      now: later,
      logger,
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse('{"summary":"冷却后试探成功","confidence":0.7}');
      },
    });
    assert.equal(probe.results[0].distilledBy, 'llm');
    assert.equal(probe.circuit.state, 'closed');
    assert.equal(probe.circuit.consecutiveFailures, 0);
  } finally {
    fixture.cleanup();
  }
});

test('dream config: defaults are complete and every bad value is fail-fast', () => {
  const resolved = resolveConfig({});
  assert.equal(resolved.dream.useLlm, true);
  assert.equal(resolved.dream.minGroupSize, 3);
  assert.equal(resolved.dream.llmTimeoutMs, 15_000);
  assert.deepEqual(resolved.dream.llm, { baseUrl: null, model: null, apiKey: null });
  assert.throws(
    () => resolveConfig({ dream: { minGroupSize: 1 } }),
    (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
  );
  assert.throws(() => resolveConfig({ dream: { useLlm: 'yes' } }), (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE');
  assert.throws(
    () => resolveConfig({ dream: { llm: { baseUrl: 42 } } }),
    (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE',
  );
  assert.throws(() => resolveConfig({ dream: { llm: 'https://x' } }), (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE');
});

test('zero-dependency red line: package.json carries no third-party dependency', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field] ?? {};
    assert.deepEqual(Object.keys(deps), [], `${field} must stay empty (charter v2.0 #1)`);
    assert.ok(!Object.keys(deps).some((name) => /openai|anthropic|llm|sdk/i.test(name)), `${field} must not add an LLM SDK`);
  }
  const source = fs.readFileSync(path.join(root, 'src', 'dream.js'), 'utf8');
  assert.ok(source.includes('globalThis.fetch'), 'Dream defaults to Node built-in global fetch');
  assert.ok(source.includes('chatEndpoint('), 'Dream builds an OpenAI-compatible endpoint itself');
  assert.ok(!/from ['"](openai|@anthropic|axios|node-fetch)/.test(source), 'no third-party network client');
});
