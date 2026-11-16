/**
 * v1.6.6 (M5) — the two packages share a boundary, not an error namespace.
 *
 * `dsh-orchestrator` carries TWO contracts on purpose:
 *   - `MEM_E_*` for the engine MOVED OUT of this core (router/transfer/space), so a
 *     tool/HTTP result keeps the exact code a client already branches on;
 *   - `ORCH_E_*` for its own surfaces (consent broker, federation map, claim registry).
 *
 * Anything crossing into THIS package's results must speak `MEM_E_*`. The
 * translation is asserted here, not assumed: a code the map does not cover is never
 * silently flattened to MEM_E_IO (the original stays on `details.orchestratorCode`).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ErrorCodes,
  MemoryError,
  asMemoryError,
  fromOrchestratorError,
  isOrchestratorCode,
  ORCHESTRATOR_CODE_MAP,
} from '../src/errors.js';

/** Stand-in for `dsh-orchestrator`'s OrchestratorError (same shape, other namespace). */
function orchError(code, message = 'orchestrator refused', details = undefined) {
  const error = new Error(message);
  error.name = 'OrchestratorError';
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

test('the translation covers every code the orchestrator can throw at this boundary', () => {
  // Total mapping: all seven ORCH_E_* codes have a MEM_E_* home. If the orchestrator
  // grows a new code, this assertion is what forces a decision instead of a silent
  // MEM_E_IO downgrade at runtime.
  const expected = {
    ORCH_E_CONSENT_REQUIRED: 'MEM_E_REQUIRE_USER_CONSENT',
    ORCH_E_CONSENT_INVALID: 'MEM_E_REQUIRE_USER_CONSENT',
    ORCH_E_CONSENT_CONSUMED: 'MEM_E_REQUIRE_USER_CONSENT',
    ORCH_E_SPACE_INVALID: 'MEM_E_SPACE_INVALID',
    ORCH_E_INVALID_INPUT: 'MEM_E_INVALID_INPUT',
    ORCH_E_NOT_READY: 'MEM_E_NOT_READY',
    ORCH_E_FEDERATION_CONFLICT: 'MEM_E_FEDERATION_FAILED',
  };
  assert.deepEqual({ ...ORCHESTRATOR_CODE_MAP }, expected);
  for (const [orchestratorCode, memoryCode] of Object.entries(expected)) {
    const translated = fromOrchestratorError(orchError(orchestratorCode));
    assert.equal(translated.code, memoryCode, `${orchestratorCode} -> ${memoryCode}`);
    assert.ok(translated instanceof MemoryError);
    assert.equal(translated.details.orchestratorCode, orchestratorCode, 'the original code is kept for forensics');
  }
});

test('every mapped target is a real MEM_E_* code of this package', () => {
  const known = new Set(Object.values(ErrorCodes));
  for (const [orchestratorCode, memoryCode] of Object.entries(ORCHESTRATOR_CODE_MAP)) {
    assert.ok(memoryCode.startsWith('MEM_E_'), `${orchestratorCode} must map into MEM_E_*`);
    assert.ok(known.has(memoryCode), `${orchestratorCode} -> ${memoryCode} is not a declared ErrorCodes value`);
  }
});

test('a consent failure that crosses the boundary is still a consent failure', () => {
  // The security-relevant case: the agent must never see this as a generic IO error,
  // because the fix is "ask the user", not "retry".
  const translated = asMemoryError(orchError('ORCH_E_CONSENT_REQUIRED', 'explicit consent required'));
  assert.equal(translated.code, ErrorCodes.REQUIRE_USER_CONSENT);
  assert.equal(translated.message, 'explicit consent required');
  // And the human-facing red line in the UI/model prompt keys off exactly this code.
  assert.equal(translated.code, 'MEM_E_REQUIRE_USER_CONSENT');
});

test('details survive the translation (payload is not lost)', () => {
  const translated = fromOrchestratorError(
    orchError('ORCH_E_SPACE_INVALID', 'bad id', { spaceId: 'Bad', targetSpaceId: 'work' }),
  );
  assert.equal(translated.code, ErrorCodes.SPACE_INVALID);
  assert.equal(translated.details.spaceId, 'Bad');
  assert.equal(translated.details.targetSpaceId, 'work');
  assert.equal(translated.details.orchestratorCode, 'ORCH_E_SPACE_INVALID');
});

test('an unmapped ORCH_E_* keeps the caller fallback instead of becoming MEM_E_IO', () => {
  const translated = fromOrchestratorError(orchError('ORCH_E_FUTURE_THING'), ErrorCodes.FEDERATION_FAILED);
  assert.equal(translated.code, ErrorCodes.FEDERATION_FAILED);
  assert.equal(translated.details.orchestratorCode, 'ORCH_E_FUTURE_THING');
});

test('MEM_E_* and plain errors pass through untouched', () => {
  // Passthrough matters: a rewrap would lose `instanceof` and could reset a code the
  // HTTP layer already mapped to a status.
  const own = new MemoryError(ErrorCodes.NOT_FOUND, 'missing');
  assert.equal(asMemoryError(own), own);

  const carried = new Error('handler failed');
  carried.code = 'MEM_E_CONFIG_OUT_OF_RANGE';
  const kept = asMemoryError(carried);
  assert.equal(kept.code, 'MEM_E_CONFIG_OUT_OF_RANGE');

  const plain = new Error('boom');
  assert.equal(asMemoryError(plain).code, ErrorCodes.IO);
  assert.equal(asMemoryError(plain, ErrorCodes.WRITER_BUSY).code, ErrorCodes.WRITER_BUSY);
});

test('isOrchestratorCode recognises the namespace and nothing else', () => {
  assert.equal(isOrchestratorCode('ORCH_E_NOT_READY'), true);
  assert.equal(isOrchestratorCode('MEM_E_NOT_READY'), false);
  assert.equal(isOrchestratorCode('ORCH_E_'), true, 'prefix match, not a whitelist');
  assert.equal(isOrchestratorCode('orch_e_not_ready'), false, 'codes are case-sensitive');
  assert.equal(isOrchestratorCode(undefined), false);
  assert.equal(isOrchestratorCode(42), false);
});
