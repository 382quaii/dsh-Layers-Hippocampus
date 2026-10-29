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

export { DAY_MS, FakeClock };

/** 2023-11-14T22:13:20Z — fixed, timezone-free anchor for every scenario. */
export const T0 = Date.UTC(2023, 10, 14, 22, 13, 20);

export function tempDir(prefix = 'dsh-memory-test') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

/** Policy that admits tags after a single event, so small fixtures have a resident set. */
export const SMALL_POLICY = Object.freeze({ activeSet: { minEvents: 1, minMass: 0.01 } });

export async function makeMemory({ dir = tempDir(), start = T0, policy = SMALL_POLICY, config = {} } = {}) {
  const clock = new FakeClock(start);
  const memory = await Memory.open({ dataDir: dir, clock, policy, config });
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
export function fakeCtx() {
  const tools = new Map();
  const sections = [];
  const contexts = [];
  const cleanups = [];
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
  };
  return {
    ctx,
    tools,
    sections,
    contexts,
    dispose() {
      while (cleanups.length > 0) cleanups.pop()();
    },
  };
}
