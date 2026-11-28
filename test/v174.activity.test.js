/**
 * v1.7.4 — the recent-activity ring.
 *
 * The Web panel flashes tags that were just recalled or captured. That ring is
 * presentation state, so it must be bounded, monotonic (a poll can pass a cursor),
 * and — the security-relevant part — it must never echo a `sensitive:*` or
 * `privacy:*` tag back through the UI. A corrupt persistence file is empty, not a
 * crash, and persistence is opt-in.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ActivityStore } from '../src/activity.js';
import { tempDir } from './helpers.js';

test('record assigns increasing seq and recent honors the since cursor', () => {
  const store = new ActivityStore({ limit: 8 });
  const first = store.record({ kind: 'recall', tags: ['project:dsh'] });
  const second = store.record({ kind: 'capture', tags: ['preference'] });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);

  const all = store.recent();
  assert.deepEqual(all.items.map((item) => item.seq), [1, 2]);
  assert.equal(all.cursor, 2);

  const newer = store.recent({ since: 1 });
  assert.deepEqual(newer.items.map((item) => item.seq), [2]);
  assert.equal(newer.cursor, 2);

  const nothing = store.recent({ since: 2 });
  assert.deepEqual(nothing.items, []);
  assert.equal(nothing.cursor, 2);
  assert.equal(store.size(), 2);
});

test('sensitive and privacy tags are stripped before they can reach the panel', () => {
  const store = new ActivityStore();
  store.record({
    kind: 'recall',
    tags: ['keep', 'sensitive:api_key', 'privacy:secret', 'Sensitive:Phone', 'keep'],
  });
  const item = store.recent().items[0];
  assert.deepEqual(item.tags, ['keep']);
});

test('tags and event ids are capped, strings are sliced, unknown kinds are ignored', () => {
  const store = new ActivityStore();
  const manyTags = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
  const manyIds = Array.from({ length: 12 }, (_, i) => `ev_${i}`);
  const result = store.record({
    kind: 'capture',
    tags: [...manyTags, 'x'.repeat(200)],
    eventIds: manyIds,
  });
  assert.ok(result);
  assert.equal(result.item.tags.length, 12);
  assert.equal(result.item.eventIds.length, 8);
  assert.equal(result.item.tags[0], 'tag-0');
  assert.ok(result.item.tags.every((tag) => tag.length <= 64));

  assert.equal(store.record({ kind: 'explode', tags: ['x'] }), null);
  assert.equal(store.size(), 1);
});

test('the ring never grows past its limit and evicts the oldest item', () => {
  const store = new ActivityStore({ limit: 5 });
  for (let i = 1; i <= 10; i += 1) store.record({ kind: 'recall', tags: [`t${i}`] });
  const recent = store.recent();
  assert.equal(recent.items.length, 5);
  assert.equal(store.size(), 5);
  assert.deepEqual(recent.items.map((item) => item.seq), [6, 7, 8, 9, 10]);
  assert.equal(recent.items[0].tags[0], 't6');
  assert.equal(recent.items[4].tags[0], 't10');
});

test('persistence is opt-in and a flush round-trips through a new store', () => {
  const dir = tempDir('dsh-activity');
  const file = path.join(dir, 'state', 'activity.json');
  try {
    const inMemory = new ActivityStore();
    inMemory.record({ kind: 'recall', tags: ['never-written'] });
    inMemory.flush();
    assert.equal(fs.existsSync(file), false);

    const store = new ActivityStore({ file, persistIntervalMs: 60_000 });
    store.record({ kind: 'recall', tags: ['persist'], eventIds: ['ev_1'] });
    store.flush();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.schema, 1);
    assert.equal(saved.items.length, 1);
    assert.equal(saved.items[0].kind, 'recall');

    const reloaded = new ActivityStore({ file });
    const recent = reloaded.recent();
    assert.equal(recent.items.length, 1);
    assert.deepEqual(recent.items[0].tags, ['persist']);
    assert.deepEqual(recent.items[0].eventIds, ['ev_1']);
    assert.equal(recent.cursor, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt persistence file reads as empty and never throws', () => {
  const dir = tempDir('dsh-activity-bad');
  const file = path.join(dir, 'activity.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '{');
    const store = new ActivityStore({ file });
    assert.deepEqual(store.recent().items, []);
    assert.equal(store.size(), 0);
    // The ring still works after the bad load, and recording does not throw.
    assert.ok(store.record({ kind: 'recall', tags: ['after-corruption'] }));
    assert.equal(store.recent().items.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
