/**
 * High-entropy / ciphertext detection for the WRITE side (audit item A4).
 *
 * The original audit found that the engine only redacts secrets on the READ path and
 * rejects inline base64 in `remember()`, but nothing stopped a captured turn from
 * carrying a ciphertext or an opaque encrypted blob into the append-only log. That
 * log is the one thing this plugin promises never to lose, so a blob that can never
 * be searched, summarised or distilled is worse than a rejection.
 *
 * Design constraints, in order:
 *   1. **No false positives on prose or code.** Detection requires a SINGLE
 *      whitespace-free token of at least `MIN_RUN_CHARS` characters drawn from a
 *      narrow alphabet, so normal sentences, URLs, file paths and identifiers pass.
 *   2. **Explainable.** Every verdict reports which signal fired (`pem`, `base64`,
 *      `hex`) plus the measured entropy, so a caller can log or display the reason.
 *   3. **Cheap.** The scan is linear and bounded to the first `MAX_SCAN_CHARS`
 *      characters; capture happens on every surface message.
 */

export const ENCRYPTED_REJECT_CODE = 'MEM_E_ENCRYPTED_RAW_REJECTED';

/** A run shorter than this is ordinary text, not a payload. */
export const MIN_RUN_CHARS = 512;
/** Entropy floor for base64-ish payloads (bits per character, max 6 for base64). */
export const BASE64_ENTROPY_FLOOR = 4.5;
/** Entropy floor for hex payloads (max 4 bits per character). */
export const HEX_ENTROPY_FLOOR = 3.5;
/** Only the head of a turn is scanned: capture must stay O(1)-ish. */
export const MAX_SCAN_CHARS = 2_000_000;

const PEM_MARKERS = [
  '-----BEGIN PGP MESSAGE-----',
  '-----BEGIN PGP ARMORED FILE-----',
  '-----BEGIN ENCRYPTED PRIVATE KEY-----',
  '-----BEGIN ENCRYPTED MESSAGE-----',
  '-----BEGIN AGE ENCRYPTED FILE-----',
];

const BASE64_TOKEN = /[A-Za-z0-9+/_-]{512,}={0,2}/;
const HEX_TOKEN = /\b[0-9a-fA-F]{512,}\b/;

/** Shannon entropy in bits per character over the token's own alphabet. */
export function shannonEntropy(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return Math.round(entropy * 1000) / 1000;
}

/**
 * Decide whether `text` carries a ciphertext / high-entropy blob.
 *
 * Returns `null` when the content is safe to store, otherwise
 * `{ reject: true, reason, runLength, entropy, sample }`.
 */
export function detectCiphertext(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const minRun = Number.isFinite(options.minRunChars) ? options.minRunChars : MIN_RUN_CHARS;
  const scanned = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;

  // 1. Explicit armour is unambiguous — never a false positive.
  for (const marker of PEM_MARKERS) {
    const at = scanned.indexOf(marker);
    if (at !== -1) {
      return { reject: true, reason: 'pem', runLength: marker.length, entropy: null, at, sample: marker.slice(0, 40) };
    }
  }

  // 2. A long single-token base64 run that is ALSO high entropy. The entropy floor is
  //    what separates an encrypted blob from a repetitive identifier or a data URL of
  //    a highly compressible payload.
  const base64 = BASE64_TOKEN.exec(scanned);
  if (base64 && base64[0].length >= minRun) {
    const entropy = shannonEntropy(base64[0]);
    if (entropy >= BASE64_ENTROPY_FLOOR) {
      return {
        reject: true,
        reason: 'base64',
        runLength: base64[0].length,
        entropy,
        at: base64.index,
        sample: base64[0].slice(0, 32),
      };
    }
  }

  // 3. Long hex blobs (raw ciphertext, keys, digests concatenated).
  const hex = HEX_TOKEN.exec(scanned);
  if (hex && hex[0].length >= minRun) {
    const entropy = shannonEntropy(hex[0]);
    if (entropy >= HEX_ENTROPY_FLOOR) {
      return {
        reject: true,
        reason: 'hex',
        runLength: hex[0].length,
        entropy,
        at: hex.index,
        sample: hex[0].slice(0, 32),
      };
    }
  }
  return null;
}

/**
 * Throw `MEM_E_ENCRYPTED_RAW_REJECTED` when `text` carries a ciphertext blob.
 *
 * Kept separate from the detector so callers that only need a boolean (tests, the
 * status surface) can use `detectCiphertext` without importing the error type.
 */
export function assertNoCiphertext(text, makeError, options = {}) {
  const verdict = detectCiphertext(text, options);
  if (!verdict) return null;
  throw makeError(verdict);
}
