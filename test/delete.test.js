/**
 * Deletion tests: the four phases, the consolidation gate, reversibility.
 *
 * The invariant under test throughout: episodes may disappear, patterns must not.
 * Every scenario drives time through the injected clock.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { makeMemory } from './helpers.js';

test('deleting a high-salience episode distils a semantic summary first', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const episode = await memory.remember({
      content: 'the team always runs pnpm -r build before publishing',
      tags: ['habit:build', 'tooling:pnpm'],
      salience: 0.9,
    });
    await memory.maintain({ reason: 'fixture' });
    assert.equal(memory.semanticSummaries().length, 0);

    const { job } = await memory.forget({ eventIds: [episode.eventId], reason: 'superseded' });
    assert.equal(job.status, 'done');
    assert.deepEqual(
      job.steps.map((step) => step.phase),
      ['index', 'archive', 'consolidation', 'purge'],
      'the destructive phase runs last',
    );
    assert.equal(job.summaryIds.length, 1);

    const summaries = memory.semanticSummaries();
    assert.equal(summaries.length, 1);
    assert.deepEqual(summaries[0].sourceEvents, [episode.eventId]);
    assert.ok(summaries[0].confidence > 0.5);
    assert.ok(summaries[0].tags.includes('habit:build'));

    // The episode is gone from retrieval, but the pattern is still retrievable.
    const result = await memory.recall({ text: 'pnpm build publishing', topK: 5 });
    assert.ok(!result.hits.some((hit) => hit.eventId === episode.eventId), 'the episode is gone');
    assert.equal(result.semantic.length, 1, 'the pattern survives its source episode');

    const log = await memory.logStore.snapshot();
    assert.ok(!log.records.some((record) => record.event_id === episode.eventId), 'bytes are gone');
    assert.ok(
      log.records.some((record) => record.type === 'forget' && record.target === episode.eventId),
      'the tombstone stays in the append-only history',
    );
  } finally {
    cleanup();
  }
});

test('archive mode is reversible, purge is not', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const episode = await memory.remember({ content: 'temporary deployment note', tags: ['topic:deploy'], salience: 0.4 });
    await memory.maintain({ reason: 'fixture' });

    const { job } = await memory.forget({ eventIds: [episode.eventId], mode: 'archive', reason: 'maybe-wrong' });
    assert.equal(job.status, 'archived');
    assert.deepEqual(job.steps.map((step) => step.phase), ['index', 'archive']);
    let result = await memory.recall({ text: 'deployment note', tags: ['topic:deploy'], topK: 5 });
    assert.ok(!result.hits.some((hit) => hit.eventId === episode.eventId));

    const restored = await memory.restore({ eventIds: [episode.eventId] });
    assert.deepEqual(restored.restored, [episode.eventId]);
    result = await memory.recall({ text: 'deployment note', tags: ['topic:deploy'], topK: 5 });
    assert.ok(result.hits.some((hit) => hit.eventId === episode.eventId), 'rollback works while bytes exist');

    const purged = await memory.forget({ eventIds: [episode.eventId], mode: 'purge', reason: 'confirmed' });
    assert.equal(purged.job.status, 'done');
    await assert.rejects(
      () => memory.restore({ eventIds: [episode.eventId] }),
      (error) => error.code === 'MEM_E_ALREADY_PURGED',
      'restore after purge fails honestly instead of resurrecting',
    );
    assert.equal(purged.job.archiveFile, undefined, 'the cold copy is dropped on purge');
  } finally {
    cleanup();
  }
});

test('strict consolidation pauses the job and resumes after the policy is relaxed', async () => {
  const { memory, cleanup } = await makeMemory({
    policy: { delete: { consolidationMode: 'strict' } },
  });
  try {
    const episode = await memory.remember({ content: 'critical delivery pattern explanation', tags: ['pattern:delivery'], salience: 0.85 });
    await memory.maintain({ reason: 'fixture' });

    const { job } = await memory.forget({ eventIds: [episode.eventId], reason: 'review-first' });
    assert.equal(job.status, 'pending-consolidation');
    assert.equal(job.steps.some((step) => step.phase === 'purge'), false, 'nothing is purged while waiting');
    const log = await memory.logStore.snapshot();
    assert.ok(log.records.some((record) => record.event_id === episode.eventId), 'bytes still present');
    // The memory is already invisible to retrieval: the tombstone came first.
    const hidden = await memory.recall({ text: 'delivery pattern', topK: 5 });
    assert.ok(!hidden.hits.some((hit) => hit.eventId === episode.eventId));

    memory.setPolicy({ delete: { consolidationMode: 'auto' } });
    const report = await memory.maintain({ reason: 'resume' });
    assert.ok(report.deletes.some((entry) => entry.id === job.id && entry.status === 'done'));
    assert.equal(memory.semanticSummaries().length, 1, 'the pattern was distilled before the purge');
    const after = await memory.logStore.snapshot();
    assert.ok(!after.records.some((record) => record.event_id === episode.eventId));
  } finally {
    cleanup();
  }
});

test('replaying a finished deletion job changes nothing', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const episode = await memory.remember({ content: 'one-off episode with salience', tags: ['t'], salience: 0.9 });
    await memory.maintain({ reason: 'fixture' });
    const { job } = await memory.forget({ eventIds: [episode.eventId], reason: 'once' });
    assert.equal(job.status, 'done');

    const replayed = await memory.deletePipeline.advance(memory.deletePipeline.readJob(job.id));
    assert.deepEqual(replayed.steps, job.steps, 'a terminal job is not re-executed');

    await memory.maintain({ reason: 'again' });
    await memory.maintain({ reason: 'and-again' });
    assert.equal(memory.semanticSummaries().length, 1, 'summary ids are content-addressed, so no duplicates');
    assert.equal(memory.deletePipeline.jobs().length, 1);
  } finally {
    cleanup();
  }
});

test('a wrong id is rejected before any mutation', async () => {
  const { memory, cleanup } = await makeMemory();
  try {
    const episode = await memory.remember({ content: 'keep me', tags: ['t'], salience: 0.5 });
    await memory.maintain({ reason: 'fixture' });

    await assert.rejects(
      () => memory.forget({ eventIds: [episode.eventId, 'ev_does_not_exist_0'] }),
      (error) => error.code === 'MEM_E_NOT_FOUND' && error.details.missing.length === 1,
    );
    // Nothing was tombstoned by the rejected request.
    const result = await memory.recall({ text: 'keep me', tags: ['t'], topK: 5 });
    assert.ok(result.hits.some((hit) => hit.eventId === episode.eventId));
    assert.equal(memory.deletePipeline.jobs().length, 0);
  } finally {
    cleanup();
  }
});
