/**
 * `privacy:secret` (v1.7.0, roadmap item M3).
 *
 * Boundary decision (2026-11-24): the MEMORY plugin owns the INTERFACE and the
 * FILTERING; it does NOT decide what is secret. Deciding "this is private" is
 * semantic understanding, and that belongs to the emotion plugin, which calls
 * `remember({ tags: ['privacy:secret'] })` after it has decided.
 *
 * What the memory side guarantees here:
 *  - the write is stored verbatim (no redaction, no dropping) with `meta.privacy`;
 *  - ordinary retrieval NEVER returns it: recall/associative/hints/pointers all skip
 *    it unless the caller explicitly asks with `includeSecret: true`;
 *  - it is not federated to other spaces and not turned into a hint tag.
 */

export const PRIVACY_SECRET_TAG = 'privacy:secret';
export const PRIVACY_META_KEY = 'privacy';
export const PRIVACY_SECRET_VALUE = 'secret';

/** True when this tag list declares the record secret. */
export function isSecretTags(tags) {
  for (const entry of Array.isArray(tags) ? tags : []) {
    const tag = typeof entry === 'string' ? entry : entry?.tag;
    if (tag === PRIVACY_SECRET_TAG) return true;
  }
  return false;
}

/**
 * True when a stored episode/summary/hit is secret. Checks the tag list AND the
 * recorded meta, because a record written before the tag was understood may only
 * carry `meta.privacy`.
 */
export function isSecretRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (isSecretTags(record.tags)) return true;
  const meta = record.meta;
  return Boolean(meta && typeof meta === 'object' && meta[PRIVACY_META_KEY] === PRIVACY_SECRET_VALUE);
}

/**
 * Filter a list of records/hits for ordinary retrieval.
 *
 * `includeSecret === true` returns everything; otherwise secret records are removed
 * and counted, so a caller can report "there is more, ask explicitly" without
 * leaking a single character of the content.
 */
export function filterSecret(records, { includeSecret = false } = {}) {
  const list = Array.isArray(records) ? records : [];
  if (includeSecret === true) return { list, withheld: 0 };
  const kept = [];
  let withheld = 0;
  for (const record of list) {
    if (isSecretRecord(record)) withheld += 1;
    else kept.push(record);
  }
  return { list: kept, withheld };
}

/** The meta patch to merge into a write that declares the secret tag. */
export function privacyMetaFor(tags) {
  return isSecretTags(tags) ? { [PRIVACY_META_KEY]: PRIVACY_SECRET_VALUE } : null;
}
