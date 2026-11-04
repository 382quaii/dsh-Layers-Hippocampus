/**
 * Shared test fixtures.
 *
 * Every test injects a FakeClock: no assertion in this suite may depend on the
 * wall clock, and no test waits for real time to pass.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DAY_MS, FakeClock } from '../src/clock.js';
import { Memory } from '../src/memory.js';
// v1.5.6 physical split: the multi-space engine lives in the sibling package; the
// suite injects it through the same adapter seam the Host service uses.
import { SpaceRouter as MultiSpaceRouter } from '../../dsh-orchestrator/src/spaceRouter.js';
import { transferBetweenSpaces } from '../../dsh-orchestrator/src/transfer.js';

export { DAY_MS, FakeClock };

/** 2023-11-14T22:13:20Z — fixed, timezone-free anchor for every scenario. */
export const T0 = Date.UTC(2023, 10, 14, 22, 13, 20);

export function tempDir(prefix = 'dsh-memory-test') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export function createOrchestratorStub({ dedupe = null, federation = null } = {}) {
  return {
    createSpaceAdapter: ({ owner, dataDir, openChild }) => new MultiSpaceRouter({ owner, dataDir, openChild }),
    transfer: transferBetweenSpaces,
    ...(dedupe ? { dedupe } : {}),
    ...(federation ? { federation } : {}),
  };
}

/**
 * Options that inject the Orchestrator's multi-space engine into a raw
 * `Memory.open(...)` call (tests that bypass the plugin runtime).
 */
export function multiSpaceOptions({ config = {}, dedupe = null, federation = null } = {}) {
  const buildSpaces = (owner) =>
    new MultiSpaceRouter({
      owner,
      dataDir: owner.dataDir,
      openChild: async (childDir) =>
        Memory.open({
          dataDir: childDir,
          clock: owner.clock,
          policy: owner._policyInput ?? SMALL_POLICY,
          config,
          spaceId: String(childDir).split(/[\\/]/).pop(),
          spacesFactory: buildSpaces,
          transfer: transferBetweenSpaces,
          ...(dedupe ? { dedupe } : {}),
          ...(federation ? { federation } : {}),
        }),
    });
  return { spacesFactory: buildSpaces, transfer: transferBetweenSpaces };
}

/** Policy that admits tags after a single event, so small fixtures have a resident set. */
export const SMALL_POLICY = Object.freeze({ activeSet: { minEvents: 1, minMass: 0.01 } });

export async function makeMemory({ dir = tempDir(), start = T0, policy = SMALL_POLICY, config = {}, multiSpace = true, dedupe = null, federation = null } = {}) {
  const clock = new FakeClock(start);
  // v1.5.6: L2 multi-merge is exercised by its own suite. Fixtures disable it by
  // default so a test that floods ONE tag keeps exact index counts; a test that
  // wants the merge passes `config.l2Merge` explicitly.
  const resolvedConfig = { ...config, l2Merge: { enabled: false, ...(config.l2Merge ?? {}) } };
  // v1.5.6 physical split: multi-space lives in dsh-orchestrator; the engine tests
  // inject its router/transfer through the same adapter seam the Host uses.
  const buildSpaces = (owner) =>
    new MultiSpaceRouter({
      owner,
      dataDir: owner.dataDir,
      openChild: async (childDir) =>
        Memory.open({
          dataDir: childDir,
          clock: owner.clock,
          policy: owner._policyInput ?? policy,
          config: resolvedConfig,
          spaceId: String(childDir).split(/[\\/]/).pop(),
          spacesFactory: buildSpaces,
          transfer: transferBetweenSpaces,
          ...(dedupe ? { dedupe } : {}),
          ...(federation ? { federation } : {}),
        }),
    });
  const memory = await Memory.open({
    dataDir: dir,
    clock,
    policy,
    config: resolvedConfig,
    ...(dedupe ? { dedupe } : {}),
    ...(federation ? { federation } : {}),
    ...(multiSpace ? { spacesFactory: buildSpaces, transfer: transferBetweenSpaces } : {}),
  });
  return {
    memory,
    clock,
    dir,
    cleanup() {
      memory.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function logSegments(dir) {
  const root = path.join(dir, 'log');
  const gen = fs.readFileSync(path.join(root, 'CURRENT'), 'utf8').trim();
  const segDir = path.join(root, gen);
  return fs
    .readdirSync(segDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => path.join(segDir, name));
}

export function logText(dir) {
  return logSegments(dir)
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('');
}

export function logRecords(dir) {
  return logText(dir)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Physical line number of a record: what a line-pointer design would have stored. */
export function lineOfEvent(dir, eventId) {
  const lines = logText(dir).split('\n');
  const index = lines.findIndex((line) => line.includes(eventId));
  if (index < 0) return -1;
  return index + 1;
}

export function indexFile(dir, name) {
  const root = path.join(dir, 'index');
  const gen = fs.readFileSync(path.join(root, 'CURRENT'), 'utf8').trim();
  return JSON.parse(fs.readFileSync(path.join(root, gen, name), 'utf8'));
}

/**
 * Minimal fake of the Host services this plugin touches: tools registry, prompt
 * registry, effect lifecycle, logger. No real cordis, no real harness.
 */
export function fakeCtx({ orchestrator = true } = {}) {
  const tools = new Map();
  const sections = [];
  const contexts = [];
  const cleanups = [];
  const services = new Map();
  // v1.5.6: the space adapter is an optional Host service (dsh-orchestrator).
  // Engine/plugin tests get it by default; single-space tests set it false.
  if (orchestrator) services.set('orchestrator', createOrchestratorStub());
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    systemPrompt: {
      section(spec) {
        sections.push(spec);
        return () => sections.splice(sections.indexOf(spec), 1);
      },
      context(spec) {
        contexts.push(spec);
        return () => contexts.splice(contexts.indexOf(spec), 1);
      },
    },
    effect(callback) {
      const cleanup = callback();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return () => {};
    },
    get(name) {
      return services.get(name) ?? null;
    },
    /**
     * Cordis `ctx.inject` starts a child fiber that activates when the services
     * exist. The fake provides them eagerly and runs the callback synchronously,
     * with a child context that delegates `get` to the parent (so a test may
     * install `webServer` before calling apply).
     */
    inject(_deps, callback) {
      const child = {
        logger: ctx.logger,
        tools: ctx.tools,
        systemPrompt: ctx.systemPrompt,
        effect: ctx.effect,
        get: (name) => ctx.get(name),
        inject: ctx.inject,
      };
      callback(child);
      return () => {};
    },
  };
  return {
    ctx,
    tools,
    sections,
    contexts,
    services,
    dispose() {
      while (cleanups.length > 0) cleanups.pop()();
    },
  };
}
