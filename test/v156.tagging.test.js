/**
 * v1.5.6 — pre-ingest tagging (engine-side anchors for untagged writes).
 *
 * Locked contracts:
 *   1. deterministic extraction from content shape (error type / errno / code
 *      fence language / HTTP status / file path / task statement);
 *   2. model-provided tags always win — the heuristic never runs then;
 *   3. tags are deduplicated, count bounded by `tagging.maxTags`;
 *   4. raw stays pure: the black-box record still has exactly four fields;
 *   5. a miss is `MEM_E_AUTO_TAG_MISS` (warning + panel counter), never a failed
 *      write;
 *   6. `tagging.autoTag=false` restores the old (tags-only) behaviour.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { extractTags } from '../src/tagging.js';
import { T0, logRecords, makeMemory } from './helpers.js';

const DAY = new Date(T0).toISOString().slice(0, 10);

test('extractTags derives deterministic anchors from content shape', () => {
  assert.deepEqual(extractTags('TypeError: querySelector is not a function'), ['error:typeerror']);
  assert.deepEqual(extractTags('connect ECONNREFUSED 127.0.0.1:5432'), ['error:econnrefused']);
  assert.deepEqual(extractTags('```python\nprint(1)\n```'), ['lang:python']);
  assert.deepEqual(extractTags('HTTP 500 from upstream'), ['http:500']);
  assert.deepEqual(extractTags('failed at C:\\Users\\me\\reactor\\src\\index.js'), ['file:index.js']);
  assert.deepEqual(extractTags('任务：修复发布门禁'), ['task:修复发布门禁']);
  assert.deepEqual(extractTags('普通聊天内容，没有锚点'), []);
  const multi = extractTags('TypeError: boom ```js\nconst x = 1;\n```', { maxTags: 5 });
  assert.ok(multi.length >= 2, 'multiple anchors are kept up to maxTags');
  assert.equal(extractTags('TypeError: boom', { maxTags: 1 }).length, 1);
});

test('an untagged write gets a deterministic anchor and the index can recall it', async () => {
  const fixture = await makeMemory({ config: { tagging: { autoTag: true, maxTags: 2 } } });
  try {
    const result = await fixture.memory.remember({
      content: 'TypeError: querySelector is not a function',
      eventTime: T0,
    });
    assert.deepEqual(result.tags, ['error:typeerror']);
    assert.equal(result.status, 'appended');

    const record = logRecords(fixture.dir).find((entry) => entry.event_id === result.eventId);
    assert.deepEqual(record.meta, { auto_tagged: true, auto_tags: ['error:typeerror'] });

    const recalled = await fixture.memory.recall({ tags: ['error:typeerror'] });
    assert.ok(recalled.hits.some((hit) => hit.eventId === result.eventId), 'the anchor is in the inverted index');
  } finally {
    fixture.cleanup();
  }
});

test('raw stays pure: the black box keeps exactly four fields, no tags', async () => {
  const fixture = await makeMemory();
  try {
    const text = 'TypeError: querySelector is not a function';
    await fixture.memory.captureRaw({ content: text, role: 'user', kind: 'chat', force: true });
    await fixture.memory.raw.flush();
    const line = fs.readFileSync(path.join(fixture.dir, 'raw', `${DAY}.jsonl`), 'utf8').trim().split('\n')[0];
    const record = JSON.parse(line);
    assert.deepEqual(Object.keys(record).sort(), ['content', 'role', 'timestamp', 'turn_id']);
    assert.equal(Object.hasOwn(record, 'tags'), false);
  } finally {
    fixture.cleanup();
  }
});

test('model-provided tags win and are deduplicated (heuristic never runs)', async () => {
  const fixture = await makeMemory({ config: { tagging: { autoTag: true } } });
  try {
    const result = await fixture.memory.remember({
      content: 'TypeError: ignored because tags were provided',
      tags: ['custom', 'custom', 'keep'],
      eventTime: T0,
    });
    assert.deepEqual(result.tags, ['custom', 'keep']);
    const record = logRecords(fixture.dir).find((entry) => entry.event_id === result.eventId);
    assert.equal(record.meta, undefined, 'no auto_tagged provenance when the model asserted tags');
  } finally {
    fixture.cleanup();
  }
});

test('a miss is a warning (MEM_E_AUTO_TAG_MISS) and a panel counter, never a failure', async () => {
  const fixture = await makeMemory({ config: { tagging: { autoTag: true } } });
  try {
    const warnings = [];
    fixture.memory.setWarnHook((code, message) => warnings.push({ code, message }));
    const result = await fixture.memory.remember({ content: '今天天气不错，随便聊聊', eventTime: T0 });

    assert.deepEqual(result.tags, [], 'nothing inferred => the write still succeeds untagged');
    assert.equal(result.status, 'appended');
    const status = await fixture.memory.status();
    assert.deepEqual(status.panel.autoTag, { applied: 0, misses: 1, lastMissAt: T0 });
    assert.ok(warnings.some((entry) => entry.code === 'MEM_E_AUTO_TAG_MISS'));
  } finally {
    fixture.cleanup();
  }
});

test('tagging.autoTag=false restores the tags-only behaviour', async () => {
  const fixture = await makeMemory({ config: { tagging: { autoTag: false } } });
  try {
    const result = await fixture.memory.remember({ content: 'TypeError: disabled path', eventTime: T0 });
    assert.deepEqual(result.tags, []);
    const status = await fixture.memory.status();
    assert.equal(status.panel.autoTag.applied, 0);
    assert.equal(status.panel.autoTag.misses, 0);
  } finally {
    fixture.cleanup();
  }
});

test('tagging config is fail-fast validated', () => {
  const defaults = resolveConfig({});
  assert.equal(defaults.tagging.autoTag, true);
  assert.equal(defaults.tagging.maxTags, 2);
  assert.equal(resolveConfig({ tagging: { autoTag: false, maxTags: 3 } }).tagging.maxTags, 3);
  assert.throws(
    () => resolveConfig({ tagging: { maxTags: 0 } }),
    (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
  );
  assert.throws(
    () => resolveConfig({ tagging: { maxTags: 6 } }),
    (error) => error.code === 'MEM_E_CONFIG_OUT_OF_RANGE',
  );
  assert.throws(
    () => resolveConfig({ tagging: { autoTag: 'yes' } }),
    (error) => error.code === 'MEM_E_CONFIG_INVALID_TYPE',
  );
});
