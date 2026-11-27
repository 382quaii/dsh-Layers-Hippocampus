/**
 * v1.7.3 — the three "make it real" modules.
 *
 *   1. PHYSICAL context pruning: an over-limit request is not summarised by a model,
 *      it is folded — the old verbose turn is REPLACED on the surface by a pointer that
 *      names the raw turn it came from. `tool/call` nodes are never touched, so every
 *      surviving `tool/result` keeps its pair.
 *   2. RAW tombstones move OUT of the day shards into `state/raw-tombstones.json`,
 *      keyed by BOTH `turn_id` and `content_hash`. A purge must not make the shard
 *      bigger, and `deep_raw` must not hand back a deleted turn through another door.
 *   3. `privacy:secret` becomes fine-grained `sensitive:*`, enforced on the READ path:
 *      a plain recall physically drops those records (and says how many), and only
 *      `allowSensitive` lets them through. The plaintext stays on disk by design.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { detectSensitive, filterSensitive, SENSITIVE_WITHHOLD_TEXT } from '../src/sensitive.js';
import { FOLD_MARKER, foldPointer, planSmartPrune, smartPruneSession } from '../src/context/smartPrune.js';
import { RAW_TOMBSTONE_FILE } from '../src/tombstones.js';
import { SMALL_POLICY, makeMemory, tempDir } from './helpers.js';

/* ------------------------------------------------------------ module 1: folding */

function bigMessage(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

test('foldPointer names the raw turn and never returns an empty pointer', () => {
  const pointer = foldPointer({ turns: 2, tags: ['project:dsh'], turnId: 'turn_7_assistant' });
  assert.ok(pointer.startsWith(FOLD_MARKER));
  assert.ok(pointer.includes('2 轮'));
  assert.ok(pointer.includes('[project:dsh]'));
  assert.ok(pointer.includes('原文 ID: raw:turn_7_assistant'));
  assert.ok(pointer.includes('recall 工具检索'));
  // No id at all is still a pointer, not an empty replacement.
  assert.ok(foldPointer({}).includes('unknown'));
});

test('smart prune replaces the long turn through surface-replace and leaves tool/call pairs intact', () => {
  const long = 'x'.repeat(9_000);
  const appended = [];
  const events = new Map([
    [1, { type: 'user/message', seq: 1, data: { message: { role: 'user', content: [{ type: 'text', text: 'build it' }] } } }],
    [2, { type: 'tool/call', seq: 2, data: { name: 'read', message: { role: 'assistant', content: [] } } }],
    [3, { type: 'tool/result', seq: 3, data: { name: 'read', message: bigMessage(long) } }],
    [4, { type: 'user/message', seq: 4, data: { message: { role: 'user', content: [{ type: 'text', text: 'next' }] } } }],
  ]);
  const session = {
    surface: { nodes: [1, 2, 3, 4] },
    eventAt(seq) {
      return events.get(seq) ?? null;
    },
    deriveEventMessage(event) {
      return event?.data?.message ?? null;
    },
    append(type, data, options) {
      appended.push({ type, data, options });
      return { seq: 100 + appended.length };
    },
  };

  const report = smartPruneSession(session, { keepRecentTurns: 1, minChars: 1_000, maxNodes: 4 });
  assert.equal(report.folded, 1);
  assert.equal(report.failed, null);
  // The tool/call node was never rewritten, so the pair stays legal.
  assert.ok(!appended.some((entry) => entry.type === 'tool/call'));
  assert.deepEqual(appended.map((entry) => entry.type), ['compaction/prune', 'tool/result']);
  assert.deepEqual(appended[1].options.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 });
  assert.deepEqual(appended[1].options.sourceEventSeqs, [3]);
  const replaced = appended[1].data.message.content[0].text;
  assert.ok(replaced.startsWith(FOLD_MARKER));
  assert.equal(replaced.length, report.pointers[0].pointer.length);
  assert.ok(report.charsAfter < 300);
  assert.ok(report.charsBefore >= 9_000);
});

test('plan protects the most recent user turns and skips already-folded nodes', () => {
  const nodes = [];
  const events = new Map();
  for (let seq = 1; seq <= 6; seq += 1) {
    nodes.push(seq);
    const isUser = seq % 2 === 1;
    events.set(seq, {
      type: isUser ? 'user/message' : 'tool/result',
      seq,
      data: {
        message: {
          role: isUser ? 'user' : 'tool',
          content: [{ type: 'text', text: 'y'.repeat(5_000) }],
        },
      },
    });
  }
  const session = {
    surface: { nodes },
    eventAt: (seq) => events.get(seq) ?? null,
    deriveEventMessage: (event) => event?.data?.message ?? null,
  };
  const plan = planSmartPrune(session, { keepRecentTurns: 2, minChars: 1_000, maxNodes: 8 });
  // The window is counted in USER turns: seq 5 (question) and seq 3 (previous question)
  // are protected, so the cut lands on seq 3 and only 1..2 can be folded.
  assert.equal(plan.protectedFrom, 2);
  assert.deepEqual(plan.candidates.map((entry) => entry.seq).sort(), [1, 2]);
});

/* ------------------------------------------------- module 2: tombstone overlay */

test('forget writes the overlay, leaves the shard size unchanged, and deep_raw cannot see the turn', async () => {
  const { memory, dir, cleanup } = await makeMemory({
    policy: { ...SMALL_POLICY, delete: { graceHours: 0 } },
  });
  try {
    const secret = 'the deleted memory body: kestrel-42';
    await memory.captureRaw({ content: secret, role: 'user', kind: 'chat', force: true, turnId: 'turn_9_user' });
    const stored = await memory.remember({ content: secret, tags: ['project:test'], salience: 0.9 });
    const eventId = stored.event?.event_id ?? stored.eventId ?? stored.id;
    assert.ok(eventId);

    const WINDOW = { startTime: 0, endTime: 4_102_444_800_000 };
    const shardDir = memory.raw.dir;
    const overlayFile = memory.raw.tombstones.file;
    const sizeOf = () => {
      if (!fs.existsSync(shardDir)) return 0;
      return fs
        .readdirSync(shardDir)
        .filter((name) => name.endsWith('.jsonl'))
        .reduce((total, name) => total + fs.statSync(path.join(shardDir, name)).size, 0);
    };

    // The raw store batches writes; land the turn before measuring.
    await memory.raw.flush?.();
    assert.ok(sizeOf() > 0, 'the raw turn was never written');
    const before = sizeOf();
    assert.ok((await memory.deepRaw({ ...WINDOW, text: 'kestrel-42' })).hits.length >= 1);

    await memory.forget({ eventIds: [eventId], mode: 'purge' });

    // 1. nothing was APPENDED to the log to record the deletion
    assert.ok(sizeOf() <= before, `raw grew during a purge: ${before} -> ${sizeOf()}`);
    for (const name of fs.readdirSync(shardDir).filter((entry) => entry.endsWith('.jsonl'))) {
      assert.ok(!fs.readFileSync(path.join(shardDir, name), 'utf8').includes('"raw_tombstone"'));
    }

    // 2. the overlay is the new home of the keys — both granularities
    const overlay = JSON.parse(fs.readFileSync(overlayFile, 'utf8'));
    assert.ok(Object.keys(overlay.contentHashes ?? {}).length >= 1);
    assert.ok(Object.keys(overlay.turnIds ?? {}).includes('turn_9_user'), JSON.stringify(overlay.turnIds));

    // 3. the read path honours it
    assert.equal((await memory.deepRaw({ ...WINDOW, text: 'kestrel-42' })).hits.length, 0);
  } finally {
    cleanup();
  }
});

/* --------------------------------------------------- module 3: sensitive reads */

test('detectSensitive classifies an API key and a plain text differently', () => {
  assert.deepEqual(detectSensitive('sk-abcdef0123456789abcdef'), ['api_key']);
  assert.ok(detectSensitive('password = hunter2hunter2').includes('credential'));
  assert.ok(detectSensitive('mail me at someone@example.com').includes('pii'));
  assert.deepEqual(detectSensitive('nothing to see here'), []);
});

test('a record with an API key is tagged sensitive:api_key and is blocked on every read path', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const stored = await memory.remember({
      content: 'deploy token is sk-live-0123456789abcdef',
      tags: ['project:test'],
      salience: 0.9,
    });
    const eventId = stored.event?.event_id ?? stored.eventId ?? stored.id;
    const snapshot = await memory.logStore.snapshot();
    const record = snapshot.records.find((entry) => entry.event_id === eventId);
    const tagNames = record.tags.map((entry) => (typeof entry === 'string' ? entry : entry.tag));
assert.ok(tagNames.includes('sensitive:api_key'), JSON.stringify(record.tags));
assert.deepEqual(record.meta?.sensitive, ['api_key']);

    const blocked = await memory.recall({ text: 'deploy token', topK: 5 });
    assert.equal(blocked.hits.length, 0);
    assert.ok((blocked.notes ?? []).some((note) => note.startsWith('sensitive-withheld:')));

    const allowed = await memory.recall({ text: 'deploy token', topK: 5, allowSensitive: true });
    assert.ok(allowed.hits.some((hit) => hit.eventId === eventId));

    // episode memory and the raw black box are separate stores: put the same secret
    // into raw explicitly so both read paths are exercised.
    // the raw black box has a salience gate for manual captures — force it, the
    // point here is the read path, not the write policy.
    await memory.raw.capture({
      turnId: 'turn_sensitive_1',
      role: 'user',
      content: 'deploy token is sk-live-0123456789abcdef',
      force: true,
    });

    const rawBlocked = await memory.deepRaw({ startTime: 0, endTime: 4_102_444_800_000, text: 'sk-live-0123456789abcdef' });
    assert.equal(rawBlocked.hits.length, 0);
    const rawAllowed = await memory.deepRaw({
      startTime: 0,
      endTime: 4_102_444_800_000,
      text: 'sk-live-0123456789abcdef',
      allowSensitive: true,
    });
    assert.ok(rawAllowed.hits.length >= 1);
  } finally {
    cleanup();
  }
});

test('filterSensitive reports a count without leaking the body', () => {
  const { list, withheld } = filterSensitive(
    [
      { eventId: 'ev_1', content: 'plain', tags: [] },
      { eventId: 'ev_2', content: 'sk-abcdef0123456789abcdef', tags: ['sensitive:api_key'] },
    ],
    {},
  );
  assert.equal(withheld, 1);
  assert.deepEqual(list.map((entry) => entry.eventId), ['ev_1']);
  assert.ok(SENSITIVE_WITHHOLD_TEXT.includes('敏感'));
});
