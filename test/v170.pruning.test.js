/**
 * v1.7.0 — bound-based early exit in recall scoring (performance audit item A).
 *
 * Every hit's score is `salience × decay × tagAffinity(≤3) × lexicalBoost(≤1) ×
 * association(≤1) × timeBoost(≤1.3) × handoff(≤1)`, so `salience × 3.9` is a hard
 * upper bound. Candidates are visited salience-DESC and scoring stops once that
 * bound cannot beat the current k-th score. Pinned hits bypass the cut.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildIndex } from '../src/index/buildIndex.js';
import { resolvePolicy } from '../src/policy.js';
import { recall as runRecall } from '../src/retrieval.js';
import { T0, tempDir } from './helpers.js';

function episodeRecord({ index, salience, tag, eventTime, pinned = false }) {
  return {
    v: 2,
    type: 'episode',
    event_id: `evp-${String(index).padStart(5, '0')}`,
    entity_id: `ent-${index}`,
    content_hash: `hash-${index}`,
    occurrence_index: 0,
    event_time: eventTime,
    time_source: 'caller',
    time_uncertain: false,
    log_time: eventTime,
    content: `synthetic event ${index} tag ${tag}`,
    salience,
    tags: [{ tag, strength: 0.7 }],
    ...(pinned ? { meta: { pinned: true } } : {}),
  };
}

function fixture({ count, salienceAt, pinnedAt = null }) {
  const policy = resolvePolicy({});
  const records = Array.from({ length: count }, (_, index) =>
    episodeRecord({
      index,
      salience: salienceAt(index),
      tag: `perf:tag-${index}`,
      eventTime: T0 + index * 1000,
      pinned: pinnedAt !== null && pinnedAt === index,
    }),
  );
  const index = buildIndex({ records, policy, now: T0 + count * 2000 });
  const tags = Array.from({ length: count }, (_, index) => `perf:tag-${index}`);
  return { policy, index, tags };
}

function recall({ policy, index, tags, topK }) {
  return runRecall({
    index,
    query: { tags, topK },
    policy,
    now: T0 + 10 * 86_400_000,
    semantic: [],
    tempSemantic: [],
    associations: [],
  });
}

test('early exit prunes most low-salience candidates while keeping topK', () => {
  // Geometric salience: the k-th score saturates quickly, so the bound cuts early.
  const data = fixture({ count: 1000, salienceAt: (index) => 0.99 ** index });
  const result = recall({ ...data, topK: 20 });
  assert.equal(result.hits.length, 20);
  assert.ok(result.pruned > 500, `expected heavy pruning, got ${result.pruned}`);
  assert.ok(result.notes.includes(`pruned:${result.pruned}`));
  assert.equal(result.hits[0].eventId, 'evp-00000', 'highest salience ranks first');
  assert.ok(result.scanned.scored < 1000, 'not every candidate was scored');
});

test('pruning is exact: the pruned top-20 equals the unpruned top-20', () => {
  // 90 candidates and topK=90 means the brute run cannot prune anything.
  const data = fixture({ count: 90, salienceAt: (index) => 0.999 ** index });
  const brute = recall({ ...data, topK: 90 });
  const pruned = recall({ ...data, topK: 20 });
  const bruteTop20 = brute.hits.slice(0, 20).map((hit) => hit.eventId);
  const prunedTop20 = pruned.hits.map((hit) => hit.eventId);
  assert.deepEqual(prunedTop20, bruteTop20, 'bound never drops a real top-20 hit');
});

test('pinned hits bypass the cut even with low salience', () => {
  const pinnedIndex = 850;
  const data = fixture({
    count: 1000,
    salienceAt: (index) => 0.99 ** index,
    pinnedAt: pinnedIndex,
  });
  const result = recall({ ...data, topK: 20 });
  assert.ok(result.hits.some((hit) => hit.eventId === `evp-${String(pinnedIndex).padStart(5, '0')}`));
  assert.equal(result.hits[0].pinned, true, 'pinned-first ordering is preserved');
});

test('tempDir exists (fixture parity with other suites)', () => {
  // Builds a real temp dir once so the suite exercises the same helper path.
  const dir = tempDir('pruning');
  assert.ok(fs.existsSync(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});
