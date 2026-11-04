/**
 * v1.5.0 module 3 — atomic cross-space transfer.
 *
 * Two INDEPENDENT Memory instances (separate data dirs) stand in for two spaces.
 * The engine tests drive `transferBetweenSpaces` directly; a separate test drives
 * the public `Memory.transferEvents` facade and activates as soon as the Lead has
 * wired it (it reports a skip, never a silent pass, while the method is absent).
 *
 * What is locked here:
 *   - copy: target gets NEW event ids (never the source id), transfer tags and
 *     recallable content; the source is fully retained (nothing parked).
 *   - move: every target write happens BEFORE the source ids are parked, the
 *     source is still served during the grace period, and NOTHING is physically
 *     purged (log record count unchanged).
 *   - privacy screen: an id-card / credential assignment aborts the whole
 *     transfer, writes nothing, parks nothing, and the error details never carry
 *     the matched secret.
 *   - raw-turn strip: raw_turn / raw_* meta keys (nested included) never reach
 *     the target, while ordinary meta survives.
 *   - unit level: mode/id validation before side effects, sanitise deep-clone,
 *     tag/entity/time projection, and the "token budget" false-positive guard.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { Memory } from '../src/memory.js';
import {
  PRIVACY_CATEGORIES,
  TRANSFER_MODES,
  buildTransferRecord,
  scanPrivacy,
  sanitiseTransferMeta,
  transferBetweenSpaces,
} from '../../dsh-orchestrator/src/transfer.js';
import { SMALL_POLICY, T0, logRecords, makeMemory } from './helpers.js';

const HOUR = 3_600_000;
const ID_CARD = '110101199001011234';
const SECRET = 'supersecret123';

/** The transferred event ids hold source index events (both spaces small). */
function indexEvents(memory) {
  return memory.indexManager.snapshot()?.events ?? [];
}

async function seedSource(memory, contents = ['project-x alpha note', 'project-x beta note']) {
  const ids = [];
  for (const [index, content] of contents.entries()) {
    const result = await memory.remember({ content, tags: ['project:x'], salience: 0.8, eventTime: T0 + index });
    assert.equal(result.status, 'appended', 'fixture write must land');
    ids.push(result.eventId);
  }
  return ids;
}

/** Two independent spaces (separate temp dirs) with their own FakeClock. */
async function openSpaces() {
  const source = await makeMemory({ policy: SMALL_POLICY });
  const target = await makeMemory({ policy: SMALL_POLICY });
  return {
    source,
    target,
    async cleanup() {
      await closeSpaceHandles(source.memory);
      await closeSpaceHandles(target.memory);
      source.cleanup();
      target.cleanup();
    },
  };
}

/** Best-effort: a space router opened by the facade keeps child log handles. */
async function closeSpaceHandles(memory) {
  for (const key of Object.keys(memory ?? {})) {
    const value = memory[key];
    if (value && typeof value === 'object' && typeof value.closeAll === 'function') {
      try {
        await value.closeAll();
      } catch {
        /* cleanup must never mask the test result */
      }
    }
  }
}

function findSpaceRouter(memory) {
  for (const key of Object.keys(memory ?? {})) {
    const value = memory[key];
    if (value && typeof value === 'object' && typeof value.memoryFor === 'function') return value;
  }
  return null;
}

test('copy: target gets fresh ids and transfer tags, source stays retained', async () => {
  const spaces = await openSpaces();
  const { source, target } = spaces;
  try {
    const ids = await seedSource(source.memory);
    const now = source.clock.now();
    const result = await transferBetweenSpaces({
      source: source.memory,
      target: target.memory,
      eventIds: ids,
      targetSpaceId: 'space-b',
      sourceSpaceId: 'default',
      transferMode: 'copy',
      clock: source.clock,
      now,
    });

    assert.equal(result.mode, 'copy');
    assert.equal(result.source.spaceId, 'default');
    assert.equal(result.source.state, 'retained');
    assert.deepEqual(result.source.eventIds, ids);
    assert.deepEqual(result.blocked, []);

    assert.equal(result.target.spaceId, 'space-b');
    assert.equal(result.target.count, ids.length);
    assert.equal(result.target.eventIds.length, ids.length);
    assert.equal(new Set(result.target.eventIds).size, ids.length, 'each copied event gets its own id');
    for (const targetId of result.target.eventIds) {
      assert.ok(!ids.includes(targetId), 'a target id must never equal a source id');
    }
    assert.ok(result.target.tags.includes('transferred:from:default'));
    assert.ok(result.target.tags.includes('transferred:to:space-b'));
    assert.equal(result.target.strippedRawTurn, 0);

    const targetList = indexEvents(target.memory);
    assert.equal(targetList.length, ids.length);
    for (const targetId of result.target.eventIds) {
      const event = targetList.find((candidate) => candidate.eventId === targetId);
      assert.ok(event, 'target index holds the transferred event');
      const tags = event.tags.map((tag) => tag.tag);
      assert.ok(tags.includes('project:x'), 'original tags travel with the memory');
      assert.ok(tags.includes('transferred:from:default'));
      assert.ok(tags.includes('transferred:to:space-b'));
    }

    // The source is untouched and still served.
    assert.equal(indexEvents(source.memory).length, ids.length);
    const recalled = await source.memory.recall({ text: 'project-x', tags: ['project:x'] });
    for (const id of ids) {
      assert.ok(recalled.hits.some((hit) => hit.eventId === id), 'source event is still recallable');
    }
    assert.equal(source.memory.pendingDeletes.status(now).total, 0, 'copy parks nothing');

    // A second copy must mint NEW occurrences, not collapse into the first batch.
    const again = await transferBetweenSpaces({
      source: source.memory,
      target: target.memory,
      eventIds: ids,
      targetSpaceId: 'space-b',
      sourceSpaceId: 'default',
      transferMode: 'copy',
      clock: source.clock,
      now,
    });
    for (const targetId of again.target.eventIds) {
      assert.ok(!result.target.eventIds.includes(targetId), 'dedupe:false makes a copy a genuine second occurrence');
    }
    assert.equal(indexEvents(target.memory).length, ids.length * 2);
  } finally {
    await spaces.cleanup();
  }
});

test('move: target written first, source parked for grace-period deletion', async () => {
  const spaces = await openSpaces();
  const { source, target } = spaces;
  try {
    const ids = await seedSource(source.memory);
    const now = source.clock.now();
    const logBefore = logRecords(source.dir).length;

    const result = await transferBetweenSpaces({
      source: source.memory,
      target: target.memory,
      eventIds: ids,
      targetSpaceId: 'space-b',
      sourceSpaceId: 'default',
      transferMode: 'move',
      clock: source.clock,
      now,
    });

    assert.equal(result.mode, 'move');
    assert.equal(result.source.state, 'pending_delete');
    assert.equal(result.source.spaceId, 'default');
    assert.equal(result.source.graceHours, 24);
    assert.equal(result.source.dueAt, now + 24 * HOUR);
    assert.ok(result.source.dueAt > now, 'the due date is in the future');
    assert.equal(result.source.pending.mode, 'purge');
    assert.equal(result.source.pending.reason, 'space-transfer:space-b');
    assert.deepEqual(result.source.pending.eventIds, [...ids].sort());
    assert.equal(result.source.pending.dueAt, result.source.dueAt);
    assert.equal(result.source.pending.graceHours, 24);

    // The queue is visible through the source handle.
    const status = source.memory.pendingDeletes.status(now);
    assert.equal(status.total, 1);
    assert.equal(status.due, 0, 'a move is not due yet: the grace period is the safety net');
    assert.equal(status.items[0].events, ids.length);

    // Target really has the copies; the source is still served during grace.
    assert.equal(result.target.count, ids.length);
    assert.equal(indexEvents(target.memory).length, ids.length);
    const recalled = await source.memory.recall({ text: 'project-x', tags: ['project:x'] });
    for (const id of ids) {
      assert.ok(recalled.hits.some((hit) => hit.eventId === id), 'source is served until the grace period ends');
    }

    // NOTHING was physically purged: the engine only parks, maintenance purges.
    assert.equal(logRecords(source.dir).length, logBefore, 'a move never rewrites the source log');
    assert.equal(indexEvents(source.memory).length, ids.length);
  } finally {
    await spaces.cleanup();
  }
});

test('move: graceHours is clamped to at least one hour', async () => {
  const spaces = await openSpaces();
  const { source, target } = spaces;
  try {
    const ids = await seedSource(source.memory, ['project-x clamp check']);
    const now = source.clock.now();
    const result = await transferBetweenSpaces({
      source: source.memory,
      target: target.memory,
      eventIds: ids,
      targetSpaceId: 'space-b',
      transferMode: 'move',
      graceHours: 0,
    });
    assert.equal(result.source.graceHours, 1);
    assert.equal(result.source.dueAt, now + HOUR);
  } finally {
    await spaces.cleanup();
  }
});

test('move: a partial target failure throws and parks nothing on the source', async () => {
  const source = await makeMemory({ policy: SMALL_POLICY });
  try {
    const ids = await seedSource(source.memory);
    let calls = 0;
    const failingTarget = {
      async remember() {
        calls += 1;
        if (calls === 2) throw new Error('target disk full');
        return { status: 'appended', eventId: 'ev_target_first' };
      },
    };
    let failure = null;
    try {
      await transferBetweenSpaces({
        source: source.memory,
        target: failingTarget,
        eventIds: ids,
        targetSpaceId: 'space-b',
        transferMode: 'move',
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'a partial write must fail the whole transfer');
    assert.equal(failure.code, 'MEM_E_IO');
    assert.deepEqual(failure.details.written, ['ev_target_first']);
    assert.equal(failure.details.failedId, ids[1]);
    assert.equal(failure.details.targetSpaceId, 'space-b');
    assert.equal(source.memory.pendingDeletes.status().total, 0, 'all-or-nothing for deletion');
    assert.equal(indexEvents(source.memory).length, ids.length, 'the source is untouched');
  } finally {
    source.cleanup();
  }
});

test('privacy: a CN id card blocks the transfer, writing and parking nothing', async () => {
  const spaces = await openSpaces();
  const { source, target } = spaces;
  try {
    const remembered = await source.memory.remember({
      content: `我的身份证号是 ${ID_CARD}，不要外传`,
      tags: ['personal:id'],
      eventTime: T0,
    });
    const sourceId = remembered.eventId;
    const logBefore = logRecords(source.dir).length;

    let failure = null;
    try {
      await transferBetweenSpaces({
        source: source.memory,
        target: target.memory,
        eventIds: [sourceId],
        targetSpaceId: 'space-b',
        transferMode: 'copy',
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, 'the transfer must be refused');
    assert.equal(failure.code, 'MEM_E_PRIVACY_BLOCKED');
    assert.deepEqual(failure.details.ids, [sourceId]);
    assert.ok(failure.details.categories.includes('cn-id-card'));
    const serialised = JSON.stringify({ message: failure.message, details: failure.details });
    assert.ok(!serialised.includes(ID_CARD), 'the matched secret never leaves the scanner');

    assert.equal(indexEvents(target.memory).length, 0, 'nothing was written to the target');
    assert.equal(logRecords(target.dir).length, 0);
    assert.equal(indexEvents(source.memory).length, 1, 'the source is unchanged');
    assert.equal(logRecords(source.dir).length, logBefore);
    assert.equal(source.memory.pendingDeletes.status().total, 0, 'no delete was parked');
  } finally {
    await spaces.cleanup();
  }
});

test('privacy: an assignment-shaped credential blocks without leaking the secret', async () => {
  const spaces = await openSpaces();
  const { source, target } = spaces;
  try {
    const remembered = await source.memory.remember({
      content: `production service credentials password=${SECRET} rotate weekly`,
      tags: ['ops:secret'],
      eventTime: T0,
    });
    const sourceId = remembered.eventId;

    let failure = null;
    try {
      await transferBetweenSpaces({
        source: source.memory,
        target: target.memory,
        eventIds: [sourceId],
        targetSpaceId: 'space-b',
        transferMode: 'move',
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, 'the transfer must be refused');
    assert.equal(failure.code, 'MEM_E_PRIVACY_BLOCKED');
    assert.ok(failure.details.categories.includes('credential-assignment'));
    const serialised = JSON.stringify({ message: failure.message, details: failure.details });
    assert.ok(!serialised.includes(SECRET), 'the matched secret never leaves the scanner');
    assert.equal(indexEvents(target.memory).length, 0);
    assert.equal(source.memory.pendingDeletes.status().total, 0, 'a blocked move parks nothing');
  } finally {
    await spaces.cleanup();
  }
});

test('raw_turn meta is stripped before the copy reaches the target', async () => {
  const spaces = await openSpaces();
  const { source, target } = spaces;
  try {
    const meta = {
      raw_turn: 'verbatim raw secret',
      keep: 'ok',
      nested: { raw_turn_id: 'turn-7', fine: 1 },
    };
    const remembered = await source.memory.remember({
      content: 'project-x meta transfer note',
      tags: ['project:x'],
      salience: 0.7,
      eventTime: T0,
      meta,
    });
    const sourceId = remembered.eventId;

    const result = await transferBetweenSpaces({
      source: source.memory,
      target: target.memory,
      eventIds: [sourceId],
      targetSpaceId: 'space-b',
      transferMode: 'copy',
    });
    assert.ok(result.target.strippedRawTurn >= 2, 'both raw_turn and nested raw_turn_id are counted');

    const targetId = result.target.eventIds[0];
    const targetRecord = logRecords(target.dir).find((record) => record.event_id === targetId);
    assert.ok(targetRecord, 'the target log holds the transferred episode');
    assert.deepEqual(targetRecord.meta, { keep: 'ok', nested: { fine: 1 } });
    assert.ok(!('raw_turn' in targetRecord.meta));
    assert.ok(!('raw_turn_id' in targetRecord.meta.nested));

    // The source record is untouched: stripping applies to the transfer only.
    const sourceRecord = logRecords(source.dir).find((record) => record.event_id === sourceId);
    assert.deepEqual(sourceRecord.meta, meta);
  } finally {
    await spaces.cleanup();
  }
});

test('scanPrivacy: only privacy-shaped content is blocked', () => {
  assert.deepEqual(scanPrivacy('the token budget for the planner is 4000 tokens'), {
    blocked: false,
    categories: [],
  });
  assert.deepEqual(scanPrivacy('the secret to good code is clarity'), { blocked: false, categories: [] });
  assert.deepEqual(scanPrivacy('api key rotation plan for next week'), { blocked: false, categories: [] });
  assert.deepEqual(scanPrivacy('a normal developer memory about a build failure'), {
    blocked: false,
    categories: [],
  });
  assert.deepEqual(scanPrivacy(''), { blocked: false, categories: [] });
  assert.deepEqual(scanPrivacy(null), { blocked: false, categories: [] });
  assert.deepEqual(scanPrivacy(undefined), { blocked: false, categories: [] });

  assert.ok(scanPrivacy(`身份证 ${ID_CARD}`).categories.includes('cn-id-card'));
  assert.ok(scanPrivacy('call 13800138000 now').categories.includes('cn-mobile'));
  assert.ok(scanPrivacy('card 6222 0202 0011 2233').categories.includes('bank-card'));
  assert.ok(scanPrivacy('mail user@example.com').categories.includes('email'));
  assert.ok(scanPrivacy(`password=${SECRET}`).categories.includes('credential-assignment'));
  assert.ok(scanPrivacy('-----BEGIN RSA PRIVATE KEY-----').categories.includes('private-key'));
  assert.ok(scanPrivacy('A'.repeat(130)).categories.includes('inline-base64-secret'));

  // The verdict never carries the matched bytes.
  const verdict = scanPrivacy(`身份证 ${ID_CARD}`);
  assert.ok(!JSON.stringify(verdict).includes(ID_CARD));
  assert.equal(verdict.blocked, true);
});

test('sanitiseTransferMeta: deep-clones, strips raw_* at every level, never mutates', () => {
  const input = {
    raw_turn: 'x',
    keep: 'ok',
    nested: { raw_turn_id: 'y', rawTurn: 'z', fine: 1 },
    list: [{ raw_turn: 'q', ok: true }],
  };
  const before = JSON.parse(JSON.stringify(input));
  const { meta, stripped } = sanitiseTransferMeta(input);

  assert.deepEqual(input, before, 'the input meta is never mutated');
  assert.deepEqual(meta, { keep: 'ok', nested: { fine: 1 }, list: [{ ok: true }] });
  assert.ok(stripped.includes('raw_turn'));
  assert.ok(stripped.includes('nested.raw_turn_id'));
  assert.ok(stripped.includes('nested.rawTurn'));
  assert.ok(stripped.includes('list[0].raw_turn'));
  assert.equal(stripped.length, 4);

  assert.deepEqual(sanitiseTransferMeta(null), { meta: null, stripped: [] });
  assert.deepEqual(sanitiseTransferMeta(undefined), { meta: null, stripped: [] });
  assert.deepEqual(sanitiseTransferMeta({ raw_session: 1, kept: 2 }), {
    meta: { kept: 2 },
    stripped: ['raw_session'],
  });
});

test('buildTransferRecord: tags, salience, time, entity and sanitised meta', () => {
  assert.deepEqual(TRANSFER_MODES, ['copy', 'move']);
  assert.ok(Object.isFrozen(TRANSFER_MODES));

  const event = {
    eventId: 'ev_source',
    content: 'project-x note',
    tags: [{ tag: 'project:x', strength: 0.9 }, 'topic:test'],
    salience: 0.8,
    eventTime: T0,
    entityId: 'en_subject',
    meta: { raw_turn: 'do not travel', keep: 1 },
  };
  const payload = buildTransferRecord({ event, targetSpaceId: 'space-b', sourceSpaceId: 'default' });
  assert.equal(payload.content, 'project-x note');
  assert.deepEqual(payload.tags, [
    'project:x',
    'topic:test',
    'transferred:from:default',
    'transferred:to:space-b',
  ]);
  assert.equal(payload.salience, 0.8);
  assert.equal(payload.eventTime, T0);
  assert.equal(payload.entity, 'en_subject');
  assert.deepEqual(payload.meta, { keep: 1 });
  assert.equal(event.meta.raw_turn, 'do not travel', 'the source event is untouched');

  const fallback = buildTransferRecord({
    event: { content: 'only anchor time', tags: [], anchorTime: T0 + 5 },
    targetSpaceId: 'space-b',
    sourceSpaceId: 'space-a',
  });
  assert.equal(fallback.eventTime, T0 + 5);
  assert.equal(fallback.entity, null);
  assert.equal(fallback.meta, null);

  assert.throws(() => buildTransferRecord({ event: { content: 7 } }), (error) => error.code === 'MEM_E_INVALID_INPUT');
  assert.throws(() => buildTransferRecord({}), (error) => error.code === 'MEM_E_INVALID_INPUT');

  assert.ok(Object.isFrozen(PRIVACY_CATEGORIES));
  for (const entry of PRIVACY_CATEGORIES) {
    assert.ok(Object.isFrozen(entry), 'each privacy category is frozen');
    assert.match(entry.category, /^[a-z0-9-]+$/, 'categories are stable English identifiers');
    assert.ok(entry.pattern instanceof RegExp);
  }
});

test('transferBetweenSpaces: mode and ids are validated before any side effect', async () => {
  const spaces = await openSpaces();
  const { source, target } = spaces;
  try {
    const ids = await seedSource(source.memory);

    await assert.rejects(
      transferBetweenSpaces({ source: source.memory, target: target.memory, eventIds: ids, transferMode: 'teleport' }),
      (error) =>
        error.code === 'MEM_E_INVALID_INPUT' &&
        error.details.allowed.includes('copy') &&
        error.details.allowed.includes('move'),
    );
    await assert.rejects(
      transferBetweenSpaces({ source: source.memory, target: target.memory, eventIds: [] }),
      (error) => error.code === 'MEM_E_INVALID_INPUT',
    );
    await assert.rejects(
      transferBetweenSpaces({
        source: source.memory,
        target: target.memory,
        eventIds: ['ev_unknown'],
        targetSpaceId: 'space-b',
      }),
      (error) => error.code === 'MEM_E_NOT_FOUND' && error.details.missing.includes('ev_unknown'),
    );

    assert.equal(indexEvents(target.memory).length, 0, 'failed validation writes nothing');
    assert.equal(source.memory.pendingDeletes.status().total, 0, 'failed validation parks nothing');
  } finally {
    await spaces.cleanup();
  }
});

test('memory.transferEvents: copy through the public facade', async (t) => {
  const source = await makeMemory({ policy: SMALL_POLICY });
  let opened = null;
  try {
    const ids = await seedSource(source.memory);
    if (typeof source.memory.transferEvents !== 'function') {
      t.skip('Memory.transferEvents is not wired yet; the executor-level copy test covers the engine');
      return;
    }
    const result = await source.memory.transferEvents({
      eventIds: ids,
      targetSpaceId: 'space-b',
      transferMode: 'copy',
      // v1.5.1 consent gate: the facade test stands in for a user-approved call.
      userApproved: true,
    });
    assert.equal(result.mode, 'copy');
    assert.equal(result.source.state, 'retained');
    assert.equal(result.target.spaceId, 'space-b');
    assert.equal(result.target.count, ids.length);
    assert.ok(result.target.tags.includes('transferred:to:space-b'));
    assert.equal(source.memory.pendingDeletes.status().total, 0);

    // Read the target space: through the router handle when exposed, else open the
    // documented child directory (`spaces/<id>`) directly.
    const router = findSpaceRouter(source.memory);
    let targetMemory = null;
    if (router) {
      targetMemory = await router.memoryFor('space-b');
    } else {
      opened = await Memory.open({
        dataDir: path.join(source.memory.dataDir, 'spaces', 'space-b'),
        clock: source.clock,
        policy: SMALL_POLICY,
      });
      targetMemory = opened;
    }
    const targetList = indexEvents(targetMemory);
    assert.equal(targetList.length, ids.length);
    for (const targetId of result.target.eventIds) {
      assert.ok(!ids.includes(targetId), 'the facade must also mint fresh target ids');
      assert.ok(targetList.some((event) => event.eventId === targetId));
    }
  } finally {
    if (opened) {
      try {
        opened.close();
      } catch {
        /* already closed */
      }
    }
    await closeSpaceHandles(source.memory);
    source.cleanup();
  }
});
