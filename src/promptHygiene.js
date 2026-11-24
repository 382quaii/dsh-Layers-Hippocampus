/**
 * Prompt hygiene for INJECTED summaries (v1.7.1).
 *
 * The problem this solves is concrete: a handoff/L3 summary written hours ago says
 * "events 348 / reviews total 346 due 337 / version 1.6.9", and the model spends
 * tokens reading a stale fact and then more tokens contradicting it. Counters are
 * TRUE AT WRITE TIME and false almost immediately, so they must never enter a
 * prompt as if they were knowledge.
 *
 * Two rules, both conservative:
 *
 *  1. **Drop bookkeeping counters** — version strings, `events: N`, `reviews total
 *     N/due M`, `gen-000123`, ISO timestamps, `N 条事件` etc. Numbers that carry a
 *     LESSON (e.g. "854,668 + 256,000 > 1,048,576") are NOT touched: only the
 *     known bookkeeping keys are stripped, never bare digits.
 *  2. **Stamp the snapshot** so a reader knows the text is old even after cleaning.
 *
 * Pure and deterministic: no clock reads inside the transforms (the caller passes
 * `at`), no IO, no regex backtracking traps (all patterns are anchored on literal
 * key names and bounded quantifiers).
 */

/** Bookkeeping keys whose numeric value is stale by definition. */
const COUNTER_KEYS = [
  'version',
  'events',
  'eventcount',
  'activetags',
  'semsummaries',
  'semanticsummaries',
  'summaries',
  'reviewstotal',
  'reviews',
  'due',
  'pinned',
  'shards',
  'rawshards',
  'indexedshards',
  'archives',
  'archivecount',
  'diskbytes',
  'rawbytes',
  'tokens',
  'injected',
  'pending',
  'gen',
  'indexgen',
  'loggen',
  'runs',
  'groups',
];

/** `events: 1446` / `reviews total 346` → drop the clause. */
const COUNTER_RE = new RegExp(
  `(?:^|[\\s（(、,，;；|·])[^;；。\\n|]{0,24}?(?:${COUNTER_KEYS.join('|')})[^;；。\\n|]{0,12}?[:：=≈]?\\s*\\d[\\d,._/]*`,
  'i',
);

/** Semver-ish stamps: `1.6.9`, `v1.7.0`. Bounded so `854,668` is never matched. */
const VERSION_RE = /(?:\bv|\bversion\s*[:：=]?\s*)?\b\d+\.\d+\.\d+\b/i;

/** `gen-000113`, `ev_ab12…`, ISO timestamps. */
const MACHINE_ID_RE = /\bgen-\d{3,}\b|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?\b/;

/** `348 条事件` / `9 个分片` / `85 个文件` — count + counting noun. */
const COUNT_NOUN_RE = /\b\d[\d,]*\s*(?:条|个|篇|次|files?|events?|shards?|tokens?|items?)\b/i;

/** Sentence/clause separators used when deciding what a "segment" is. */
const SEGMENT_SEP = /([；;。\n]|(?:\s·\s))/;

/**
 * True when this clause is bookkeeping rather than knowledge.
 *
 * Deliberately narrow: a clause is dropped only when it looks like a counter or a
 * machine id. A clause mixing a lesson AND a counter keeps the lesson half only if
 * the counter is a separate `;`-delimited segment — we never rewrite inside a clause.
 */
export function isVolatileClause(clause) {
  const text = String(clause ?? '').trim();
  if (text.length === 0) return false;
  if (MACHINE_ID_RE.test(text)) return true;
  if (COUNTER_RE.test(text)) return true;
  if (COUNT_NOUN_RE.test(text) && !/[是为需要必须禁止不要]/.test(text)) return true;
  // A bare version stamp is only volatile when it is the whole clause ("v1.6.9").
  if (VERSION_RE.test(text) && text.replace(VERSION_RE, '').trim().length <= 6) return true;
  return false;
}

/**
 * Strip volatile clauses from a block of injected text.
 *
 * @param {string} text raw summary / persona / active-task text
 * @returns {{text: string, removed: string[]}} cleaned text plus what was dropped
 */
export function stripVolatile(text) {
  const raw = String(text ?? '');
  if (raw.trim().length === 0) return { text: '', removed: [] };
  const removed = [];
  const kept = [];
  for (const piece of raw.split(SEGMENT_SEP)) {
    if (piece === undefined) continue;
    if (/^[；;。\n]$/.test(piece) || /^\s·\s$/.test(piece)) {
      kept.push(piece);
      continue;
    }
    if (isVolatileClause(piece)) {
      const trimmed = piece.trim();
      if (trimmed) removed.push(trimmed);
      continue;
    }
    kept.push(piece);
  }
  // Collapse the separators that lost their neighbour and normalise whitespace.
  let out = kept.join('');
  out = out.replace(/^\s*[；;。·]\s*/u, '').replace(/[；;·]\s*(?=[；;。]|$)/gu, '');
  out = out.replace(/\s{2,}/g, ' ').trim();
  if (out.length > 0 && !/[。.!?！？]$/.test(out)) out += '。';
  return { text: out, removed };
}

/** `2026-11-24T14:31Z` — the moment the summary was produced, or "unknown". */
export function snapshotStamp(at) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return 'snapshot time unknown';
  return `snapshot ${new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
}

/**
 * Clean a summary and stamp it. This is the ONE entry point every injection site
 * should use, so "clean + dated" cannot be forgotten in one place and applied in
 * another.
 *
 * @param {string} text
 * @param {{at?: number, maxChars?: number, label?: string}} options
 */
export function hygienicSummary(text, { at = null, maxChars = 800, label = null } = {}) {
  const { text: cleaned, removed } = stripVolatile(text);
  if (cleaned.length === 0) return { text: '', removed, dropped: true };
  const head = `(${snapshotStamp(at)}${label ? ` · ${label}` : ''} · counters stripped as stale)`;
  const body = cleaned.replace(/\s+/g, ' ').trim();
  const budget = Math.max(0, Number(maxChars) || 0);
  const text_ = `${head} ${body}`.slice(0, budget > 0 ? budget : undefined);
  return { text: text_, removed, dropped: false };
}
