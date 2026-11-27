/**
 * v1.7.3 (module 3): cross-platform sensitive tags + read-time hard block.
 *
 * Replaces the single coarse `privacy:secret` marker with THREE categories, because
 * "secret" cannot be acted on: a credential may be rotated, an API key may be
 * scrapped, PII may be reported — but the correct response differs per category.
 *
 *    sensitive:api_key    — a token/API key that can be rotated
 *    sensitive:credential — a password / private key / connection string
 *    sensitive:pii        — personal data (email, phone, card, ID number)
 *
 * The raw log keeps the PLAINTEXT on purpose: the black box has to be useful on a
 * machine with no other service running, so the protection is a READ-TIME filter,
 * not encryption (encryption without a key store is theatre).
 *
 * `privacy:secret` still exists as a deprecated alias: old records keep working, and
 * a caller passing `includeSecret` keeps seeing them, but nothing new is written
 * with it.
 */

import { PRIVACY_SECRET_TAG } from './privacy.js';

export const SENSITIVE_TAG_PREFIX = 'sensitive:';
/** Ordered: more specific categories win when several patterns match. */
export const SENSITIVE_CATEGORIES = Object.freeze(['credential', 'api_key', 'pii']);
export const SENSITIVE_WITHHOLD_TEXT = '[System: 包含敏感内容，已被拦截]';

/** Assignment of a secret to a name: `password = ...`, `api_key: ...`, `token=...`. */
const CREDENTIAL_ASSIGNMENT =
  /(?:^|[\s"'`（(])(?:password|passwd|pwd|secret|private[_ -]?key|client[_ -]?secret|access[_ -]?token|auth[_ -]?token|connection[_ -]?string)\s*[:=]\s*\S{6,}/i;
/** Private key blocks. */
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/;
/** Well-known key shapes: OpenAI/DeepSeek style `sk-…`, GitHub `ghp_…`, AWS `AKIA…`, generic `xoxb-`. */
const KEY_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
];
/** PII: email, CN mobile, landline, 15/16/18-digit card/ID numbers. */
const PII_PATTERNS = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\b(?:\+?86[- ]?)?1[3-9]\d{9}\b/,
  /\b0\d{2,3}-\d{7,8}\b/,
  /\b(?:\d[ -]?){15,18}\b/,
];

/**
 * Classify a piece of text. Returns the matched categories (specific first, may be
 * empty). Pure and deterministic: same bytes in, same answer out, no network, no
 * model call — this runs on the ingest path.
 */
export function detectSensitive(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.length === 0) return [];
  const found = [];
  if (CREDENTIAL_ASSIGNMENT.test(value) || PRIVATE_KEY_BLOCK.test(value)) found.push('credential');
  if (KEY_SHAPES.some((pattern) => pattern.test(value))) found.push('api_key');
  if (PII_PATTERNS.some((pattern) => pattern.test(value))) found.push('pii');
  return SENSITIVE_CATEGORIES.filter((category) => found.includes(category));
}

/** The tag this machine writes for a category. */
export function sensitiveTag(category) {
  return `${SENSITIVE_TAG_PREFIX}${category}`;
}

/** Categories carried by a tag list (strings or `{tag,strength}` records). */
export function sensitiveCategoriesOf(tags) {
  const out = new Set();
  for (const entry of Array.isArray(tags) ? tags : []) {
    const name = typeof entry === 'string' ? entry : entry?.tag;
    if (typeof name !== 'string' || !name.startsWith(SENSITIVE_TAG_PREFIX)) continue;
    const category = name.slice(SENSITIVE_TAG_PREFIX.length);
    if (category.length > 0) out.add(category);
  }
  return [...out];
}

export function isSensitiveTags(tags) {
  return sensitiveCategoriesOf(tags).length > 0;
}

/** A record is sensitive when its tags say so, or its metadata already recorded a category. */
export function isSensitiveRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (isSensitiveTags(record.tags)) return true;
  const meta = record.meta ?? record.meta_json ?? null;
  if (meta && typeof meta === 'object') {
    if (Array.isArray(meta.sensitive) && meta.sensitive.length > 0) return true;
    if (typeof meta.sensitive === 'string' && meta.sensitive.length > 0) return true;
  }
  return false;
}

/**
 * Split records into visible / withheld. `allowSensitive` is the ONE switch: with it,
 * every record passes (the caller asked, and the tool result says so); without it,
 * sensitive records are physically dropped and counted so the caller can report
 * "N withheld" instead of silently returning a shorter list.
 */
export function filterSensitive(records, { allowSensitive = false } = {}) {
  const list = Array.isArray(records) ? records : [];
  if (allowSensitive) return { list, withheld: 0, categories: [] };
  const kept = [];
  const categories = new Set();
  let withheld = 0;
  for (const record of list) {
    if (!isSensitiveRecord(record)) {
      kept.push(record);
      continue;
    }
    withheld += 1;
    for (const category of sensitiveCategoriesOf(record.tags)) categories.add(category);
  }
  return { list: kept, withheld, categories: [...categories].sort() };
}

/** Metadata written onto an episode whose content was classified sensitive. */
export function sensitiveMetaFor(categories) {
  const list = Array.isArray(categories) ? categories.filter(Boolean) : [];
  if (list.length === 0) return null;
  return { sensitive: list, sensitive_detected_by: 'hippocampus:detectSensitive' };
}

/** Deprecated alias: `privacy:secret` still filters, and the new tags are a superset. */
export function isLegacySecret(tags) {
  return (Array.isArray(tags) ? tags : []).some((entry) => (typeof entry === 'string' ? entry : entry?.tag) === PRIVACY_SECRET_TAG);
}
