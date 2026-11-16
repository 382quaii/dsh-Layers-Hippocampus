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
// v1.6.3: fixtures go through the SAME migration step the host uses, so a config
// that would be migrated (or degraded) in production is migrated here too. The
// logger is silenced so per-test warnings never flood the runner's stderr.
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../src/config.js';
import { Memory } from '../src/memory.js';
// v1.5.6 physical split: the multi-space engine lives in the sibling package; the
// suite injects it through the same adapter seam the Host service uses.
// v1.6.6 (M3): resolved through `test/orchestrator.js` so the memory package can be
// tested on its own — see that file for why a bare `../../dsh-orchestrator` import
// made the suite un-publishable. `MultiSpaceRouter` is null when it is absent, and
// every fixture below then degrades to single-space instead of constructing `new null()`.
import { SpaceRouter as MultiSpaceRouter, transferBetweenSpaces, unavailableReason } from './orchestrator.js';

/** Multi-space fixtures need the orchestrator package; absent it they run single-space. */
export const MULTI_SPACE_AVAILABLE = MultiSpaceRouter !== null && transferBetweenSpaces !== null;

export { DAY_MS, FakeClock };

/** 2023-11-14T22:13:20Z — fixed, timezone-free anchor for every scenario. */
export const T0 = Date.UTC(2023, 10, 14, 22, 13, 20);

export function tempDir(prefix = 'dsh-memory-test') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export function createOrchestratorStub({ dedupe = null, federation = null } = {}) {
  if (!MULTI_SPACE_AVAILABLE) return null;
  return {
    createSpaceAdapter: ({ owner, dataDir, openChild }) => new MultiSpaceRouter({ owner, dataDir, openChild }),
    transfer: transferBetweenSpaces,
    ...(dedupe ? { dedupe } : {}),
    ...(federation ? { federation } : {}),
  };
}

/** Readable failure for a test that truly needs the router while it is absent. */
function requireMultiSpace() {
  if (!MULTI_SPACE_AVAILABLE) throw new Error(`${unavailableReason} (multi-space fixture unavailable)`);
}

/**
 * Options that inject the Orchestrator's multi-space engine into a raw
 * `Memory.open(...)` call (tests that bypass the plugin runtime).
 */
export function multiSpaceOptions({ config = {}, dedupe = null, federation = null } = {}) {
  requireMultiSpace();
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

export async function makeMemory({ dir = tempDir(), start = T0, policy = SMALL_POLICY, config = {}, multiSpace = MULTI_SPACE_AVAILABLE, dedupe = null, federation = null } = {}) {
  const clock = new FakeClock(start);
  // v1.5.6: L2 multi-merge is exercised by its own suite. Fixtures disable it by
  // default so a test that floods ONE tag keeps exact index counts; a test that
  // wants the merge passes `config.l2Merge` explicitly.
  // v1.6.3: run the migration step so fixtures see the same config shape the host
  // resolves (configVersion / startup / derived archiveAfterDays). Strict validation
  // and degradation are covered by v163.migration.test.js against resolveConfig.
  const migration = migrateConfig(config, { logger: { warn() {} } });
  const resolvedConfig = {
    ...migration.input,
    l2Merge: { enabled: false, ...(config.l2Merge ?? {}) },
    configVersion: migration.input.configVersion ?? CONFIG_SCHEMA_VERSION,
    startup: {
      strict: migration.input.strictStartup !== false,
      degraded: false,
      migrated: migration.migrated,
      fromVersion: migration.fromVersion,
    },
    warnings: migration.warnings,
  };
  // v1.5.6 physical split: multi-space lives in dsh-orchestrator; the engine tests
  // inject its router/transfer through the same adapter seam the Host uses.
  // v1.6.6 (M3): when the orchestrator is not installed the fixture opens a plain
  // single-space memory instead of building a router out of nothing.
  const buildSpaces = MULTI_SPACE_AVAILABLE
    ? (owner) =>
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
        })
    : null;
  if (multiSpace === true && !MULTI_SPACE_AVAILABLE) {
    throw new Error(`${unavailableReason} (makeMemory({ multiSpace: true }) needs it)`);
  }
  const memory = await Memory.open({
    dataDir: dir,
    clock,
    policy,
    config: resolvedConfig,
    ...(dedupe ? { dedupe } : {}),
    ...(federation ? { federation } : {}),
    ...(multiSpace && MULTI_SPACE_AVAILABLE ? { spacesFactory: buildSpaces, transfer: transferBetweenSpaces } : {}),
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
  /**
   * v1.6.5: minimal `commands` service. The real host executes a command WITHOUT a
   * model round-trip, which is exactly what lets a test assert "0 tokens": here the
   * fake only ever calls the registered handler with a parsed `rawInput`.
   */
  const registeredCommands = new Map();
  const commands = {
    register(definition) {
      registeredCommands.set(definition.name, definition);
      return () => registeredCommands.delete(definition.name);
    },
    find(_agent, name) {
      return registeredCommands.get(String(name ?? '').replace(/^\//, '')) ?? null;
    },
    list() {
      return [...registeredCommands.values()];
    },
    async execute(agent, line) {
      const text = String(line ?? '').trim();
      if (!text.startsWith('/')) return undefined;
      const [head, ...rest] = text.slice(1).split(/\s+/);
      const definition = registeredCommands.get(head);
      if (!definition) return undefined;
      return definition.handler({
        commandId: 'cmd_' + head,
        agent: agent ?? null,
        rawInput: rest.join(' '),
        attachments: [],
        signal: new AbortController().signal,
      });
    },
  };
  services.set('commands', commands);
  // v1.5.6: the space adapter is an optional Host service (dsh-orchestrator).
  // Engine/plugin tests get it by default; single-space tests set it false.
  // v1.6.6 (M3): no orchestrator installed → no service (the plugin already treats
  // it as "multi-space unavailable" at runtime, so this is the honest fixture).
  if (orchestrator) {
    const stub = createOrchestratorStub();
    if (stub) services.set('orchestrator', stub);
  }
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
    /** Cordis `ctx.provide`: expose one service to sibling plugins; returns a disposer. */
    provide(name, value) {
      services.set(name, value);
      return () => {
        if (services.get(name) === value) services.delete(name);
      };
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
        provide: (name, value) => ctx.provide(name, value),
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
    commands,
    dispose() {
      while (cleanups.length > 0) cleanups.pop()();
    },
  };
}
