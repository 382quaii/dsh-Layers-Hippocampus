/**
 * Identity tests: canonicalisation, deterministic ids, idempotency, DLQ.
 * These tests never read a real clock: every timestamp is passed explicitly.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalJson,
  canonicalPayload,
  contentHashOf,
  eventIdFor,
  isEventId,
} from '../src/identity.js';
import { Memory } from '../src/memory.js';
import { FakeClock } from '../src/clock.js';
import { tempDir, T0 } from './helpers.js';

async function open(dir, clock) {
  return Memory.open({ dataDir: dir, clock });
}

test('canonicalisation: key order, whitespace, 1.0 vs 1 and full-width characters collapse', () => {
  const a = canonicalJson({ b: 1.0, a: '  hello   world  ', nested: { y: [1, 2], x: 'Ａ' } });
  const b = canonicalJson({ nested: { x: 'A', y: [1.0, 2.0] }, a: 'hello world', b: 1 });
  assert.equal(a, b, 'same logical payload must hash identically');

  const hashA = contentHashOf(canonicalPayload({ content: '  spaced  text ', salience: 1.0, tags: ['Beta', 'alpha'] }));
  const hashB = contentHashOf(canonicalPayload({ content: 'spaced text', salience: 1, tags: ['alpha', 'beta'] }));
  assert.equal(hashA, hashB, 'tag order and 1.0/1 are not identity');

  const different = contentHashOf(canonicalPayload({ content: 'spaced text!', salience: 1, tags: ['alpha', 'beta'] }));
  assert.notEqual(hashA, different, 'a real content change must change the hash');
});

test('event id is a pure function of (content_hash, event_time, occurrence_index)', () => {
  const contentHash = 'a'.repeat(64);
  const one = eventIdFor({ contentHash, eventTime: T0, occurrenceIndex: 0 });
  const two = eventIdFor({ contentHash, eventTime: T0, occurrenceIndex: 0 });
  const nextOccurrence = eventIdFor({ contentHash, eventTime: T0, occurrenceIndex: 1 });
  const laterTime = eventIdFor({ contentHash, eventTime: T0 + 1000, occurrenceIndex: 0 });

  assert.equal(one, two, 'identical inputs yield an identical id');
  assert.ok(isEventId(one));
  assert.notEqual(one, nextOccurrence, 'a second occurrence is a different event');
  assert.notEqual(one, laterTime, 'a different time is a different event');
});

test('deterministic replay: the same inputs produce the same id sequence', async () => {
  const inputs = [
    { content: 'alpha decision', tags: ['topic:a'], salience: 0.5, eventTime: T0 },
    { content: 'beta decision', tags: ['topic:b'], salience: 0.6, eventTime: T0 + 86_400_000 },
    { content: 'alpha decision', tags: ['topic:a'], salience: 0.5, eventTime: T0 + 2 * 86_400_000 },
  ];

  const runOnce = async () => {
    const dir = tempDir('replay');
    const memory = await open(dir, new FakeClock(T0));
    const ids = [];
    for (const input of inputs) ids.push((await memory.remember(input)).eventId);
    memory.close();
    return ids;
  };

  assert.deepEqual(await runOnce(), await runOnce(), 'replay is byte-for-byte deterministic');
});

test('idempotency: the same payload at the same time is stored once', async () => {
  const dir = tempDir('idem');
  const memory = await open(dir, new FakeClock(T0));
  try {
    const first = await memory.remember({ content: 'ship on friday', tags: ['plan'], salience: 0.5, eventTime: T0 });
    const second = await memory.remember({ content: 'ship on friday', tags: ['plan'], salience: 0.5, eventTime: T0 });

    assert.equal(first.status, 'appended');
    assert.equal(second.status, 'duplicate');
    assert.equal(second.eventId, first.eventId, 'a duplicate returns the existing id');

    const status = await memory.logStore.status();
    assert.equal(status.recordCount, 1, 'the duplicate never reached the log');
  } finally {
    memory.close();
  }
});

test('same second, different content: two events with two ids', async () => {
  const dir = tempDir('same-second');
  const memory = await open(dir, new FakeClock(T0));
  try {
    const a = await memory.remember({ content: 'ticket 1 stalled', tags: ['state'], salience: 0.4, eventTime: T0 });
    const b = await memory.remember({ content: 'ticket 2 stalled', tags: ['state'], salience: 0.4, eventTime: T0 });
    assert.notEqual(a.eventId, b.eventId);
    assert.equal((await memory.logStore.status()).recordCount, 2);
  } finally {
    memory.close();
  }
});

test('invalid payloads go to the DLQ instead of overwriting a stored event', async () => {
  const dir = tempDir('dlq');
  const memory = await open(dir, new FakeClock(T0));
  try {
    await memory.remember({ content: 'kept', tags: ['ok'], salience: 0.5, eventTime: T0 });
    const rejected = await memory.remember({ content: '   ', tags: ['bad'], salience: 0.5, eventTime: T0 });

    assert.equal(rejected.status, 'dead-letter');
    assert.equal(memory.dlq.size(), 1);
    assert.equal((await memory.logStore.status()).recordCount, 1, 'the DLQ write is not a log write');
    assert.ok(memory.dlq.list().every((entry) => entry.reason));
  } finally {
    memory.close();
  }
});
