/**
 * v1.6.1 — client bundle contract for the compression-engine settings card.
 *
 * The settings page once rendered a blank screen because MemorySettings referenced
 * a bare `payload` that only exists in OTHER components' scopes. A SyntaxError-free
 * bundle is not enough: this test pins the runtime-scope rules that caused it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../ui/client.js', import.meta.url), 'utf8');
const lines = source.split(/\r?\n/);

function componentBody(name) {
  const start = lines.findIndex((line) => line.includes(`function ${name}(`));
  assert.ok(start >= 0, `${name} exists`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    // Sibling top-level components in this bundle are indented by exactly six spaces.
    if (/^ {6}function [A-Za-z]/.test(lines[index])) {
      end = index;
      break;
    }
  }
  assert.ok(end > start, `${name} body is bounded by the next sibling component`);
  return lines.slice(start, end).join('\n');
}

test('MemorySettings does not reference an out-of-scope bare `payload` binding', () => {
  const body = componentBody('MemorySettings')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(body, /(?<!state\.)\bpayload\b(?!\s*:)/, 'no bare `payload` inside MemorySettings');
  assert.match(body, /const statsPayload = state\.payload;/, 'settings reads the stats payload by its local name');
});

test('the engine card uses the Select component and statsPayload capabilities', () => {
  assert.match(source, /capabilities\.compression/);
  const engineStart = source.indexOf('冷压缩引擎（raw.compressionEngine）');
  assert.ok(engineStart > 0, 'engine card exists');
  const card = source.slice(Math.max(0, engineStart - 500), engineStart + 2000);
  assert.match(card, /h\(Select, \{/, 'engine picker is a Select component');
  assert.ok(!/type: 'select'/.test(card), 'no fake select on the generic Field component');
  assert.match(card, /statsPayload && statsPayload\.capabilities && statsPayload\.capabilities\.compression/);
});

test('the enable/disable buttons toggle rawCompressionEngine only', () => {
  assert.match(source, /启用 Zstd（内置引擎）/);
  assert.match(source, /停用 Zstd（切回 Gzip）/);
  assert.match(source, /edit\(\s*'rawCompressionEngine'/);
  assert.match(source, /edit\('rawCompressionEngine', value\)/, 'Select onChange is wired');
});
