/**
 * v1.6.6 (M3) — the one place that touches `dsh-layers-orchestrator` from tests.
 *
 * Before this bridge, nine test files statically imported
 * `../../dsh-orchestrator/src/*.js`. That path is a SIBLING CHECKOUT, not a
 * package specifier, so the suite could only ever pass inside the two-package
 * workspace: a published `dsh-layers-hippocampus` tarball has no `dsh-orchestrator`
 * next to it and every multi-space test died at import time (`ERR_MODULE_NOT_FOUND`)
 * before a single assertion ran.
 *
 * The bridge resolves, in order:
 *   1. the PACKAGE specifier `dsh-layers-orchestrator/src/...` (what a consumer
 *      installing both packages would get — this is the shape CI must exercise);
 *   2. the sibling checkout `../../dsh-orchestrator/src/...` (the local workspace).
 *
 * When neither resolves the module still loads and reports `available: false`, so
 * the memory package can be tested alone; suites that genuinely need the router
 * call `skipWithoutOrchestrator()` instead of exploding during import.
 */

import test from 'node:test';

const SUBMODULES = {  spaceRouter: 'src/spaceRouter.js',
  transfer: 'src/transfer.js',
  dedupe: 'src/dedupe.js',
  federation: 'src/federation.js',
  router: 'src/router.js',
  consent: 'src/consent.js',
  compat: 'src/compat.js',
  errors: 'src/errors.js',
};

const PACKAGE_ROOT = 'dsh-layers-orchestrator';
const SIBLING_ROOT = '../../dsh-orchestrator';
const resolved = {};
const failures = [];

for (const [key, relative] of Object.entries(SUBMODULES)) {
  let loaded = null;
  // 1. package specifier (the publishable shape)
  try {
    loaded = { module: await import(`${PACKAGE_ROOT}/${relative}`), via: 'package' };
  } catch (packageError) {
    // 2. sibling checkout (the local two-package workspace)
    try {
      loaded = { module: await import(`${SIBLING_ROOT}/${relative}`), via: 'sibling' };
    } catch (siblingError) {
      failures.push({ key, packageError: packageError?.code ?? 'ERR', siblingError: siblingError?.code ?? 'ERR' });
    }
  }
  if (loaded) resolved[key] = { ...loaded.module, __via: loaded.via };
}

/** True when every submodule the memory tests use could be loaded. */
export const available = Object.keys(resolved).length === Object.keys(SUBMODULES).length;

/** `'package'` / `'sibling'` / `null` — where the router came from, for the report line. */
export const via = available ? resolved.spaceRouter?.__via ?? null : null;

/** What could not be resolved (empty when `available`). */
export const missing = Object.freeze([...failures]);

/** Why the suite is skipping, in one line, when `available` is false. */
export const unavailableReason = available
  ? null
  : 'dsh-layers-orchestrator is not installed next to this package; multi-space tests are skipped';

/**
 * `test`-compatible skip options. Inside the two-package workspace this is `{}`,
 * so nothing is skipped; in a lone memory checkout the affected cases report as
 * skipped with a reason instead of failing the run.
 */
export function skipWithoutOrchestrator() {
  return available ? {} : { skip: unavailableReason };
}

/** Named exports, so test files do not reach into the module namespace themselves. */
export const SpaceRouter = resolved.spaceRouter?.SpaceRouter ?? null;
export const transferBetweenSpaces = resolved.transfer?.transferBetweenSpaces ?? null;
export const ContentRegistry = resolved.dedupe?.ContentRegistry ?? null;
export const FederationMap = resolved.federation?.FederationMap ?? null;
// Remaining symbols the multi-space suites import by name. They are `null` when the
// package is absent — the suites that use them are skipped wholesale in that case.
export const DEFAULT_SPACE_ID = resolved.spaceRouter?.DEFAULT_SPACE_ID ?? null;
export const SPACE_ID_PATTERN = resolved.spaceRouter?.SPACE_ID_PATTERN ?? null;
export const normaliseSpaceId = resolved.spaceRouter?.normaliseSpaceId ?? null;
export const validateNewSpaceId = resolved.spaceRouter?.validateNewSpaceId ?? null;
export const PRIVACY_CATEGORIES = resolved.transfer?.PRIVACY_CATEGORIES ?? null;
export const TRANSFER_MODES = resolved.transfer?.TRANSFER_MODES ?? null;
export const buildTransferRecord = resolved.transfer?.buildTransferRecord ?? null;
export const scanPrivacy = resolved.transfer?.scanPrivacy ?? null;
export const sanitiseTransferMeta = resolved.transfer?.sanitiseTransferMeta ?? null;

/**
 * `node:test`-shaped runner for the multi-space suites.
 *
 * Inside the two-package workspace it IS `test`, so every case runs unchanged. In a
 * lone memory checkout it registers the same cases as SKIPPED with one readable
 * reason instead of failing at import time — a consumer installing only
 * `dsh-layers-hippocampus` must be able to run `npm test`.
 *
 * Signatures used by these suites: `test(name, fn)`; `{ skip }` is threaded through
 * so an individual case can still opt out.
 */
export function orchestratorTest(name, options, fn) {
  if (available) return options === undefined ? test(name, fn) : test(name, options, fn);
  const resolvedOptions = typeof options === 'object' && options !== null ? { ...options, skip: unavailableReason } : { skip: unavailableReason };
  return fn === undefined ? test(name, resolvedOptions) : test(name, resolvedOptions, fn);
}


/**
 * The adapter the engine injects (`createSpaceAdapter` + `transfer`). Tests that
 * need a router but may run without one call this; it throws a readable error
 * instead of a bare `TypeError: X is not a constructor`.
 */
export function requireRouter() {
  if (!SpaceRouter || !transferBetweenSpaces) {
    throw new Error(`${unavailableReason} (needed: ${failures.map((entry) => entry.key).join(', ')})`);
  }
  return { SpaceRouter, transferBetweenSpaces };
}
