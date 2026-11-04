/**
 * Pre-ingest tagging (v1.5.6) — deterministic, engine-side tag extraction.
 *
 * The model is an unreliable tagger: in a long conversation it may call `remember`
 * once and never tag again, which leaves most episodes without an anchor. This
 * module runs at the write gate (AFTER the raw black box recorded the verbatim
 * turn, BEFORE the episode is hashed into the log) and derives 1–2 tags from
 * *content shape alone*: named error types, Node errno codes, fenced-code
 * languages, HTTP error codes, file paths and explicit task statements.
 *
 * Discipline:
 *   - model-provided tags always win (the heuristic only runs when tags are empty);
 *   - deterministic regexes, no randomness, no LLM, no dependencies;
 *   - raw stays pure (the caller of this function only touches the episode payload);
 *   - a miss is a warning (`MEM_E_AUTO_TAG_MISS`), never a blocked write.
 */

import { normaliseTagToken } from './policy.js';

/** Hard ceiling on inferred tags, whatever the config asks for. */
export const MAX_AUTO_TAGS = 5;
/** Default number of inferred tags. */
export const DEFAULT_AUTO_TAGS = 2;

const ERROR_TYPES =
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|AggregateError|TimeoutError|OutOfMemoryError)\b/;
const NODE_CODES =
  /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOENT|EACCES|EPERM|EADDRINUSE|ENOSPC|EAGAIN|EPIPE|ENOMEM)\b/;
const CODE_FENCE = /```([A-Za-z][\w+#.-]{0,15})/;
const HTTP_STATUS = /(?:HTTP|status(?:\s*code)?)\s*[:=]?\s*([45]\d{2})\b/i;
const TASK_STATEMENT = /(?:任务|目标|TODO|Task)\s*[:：]\s*([^\n。；;]{2,40})/;
const WINDOWS_PATH = /[A-Za-z]:[\\/][^\s"'`<>|*?\r\n]+/g;
const POSIX_PATH = /(?:^|[\s"'`(])((?:\/[\w.@+-]+){2,})/g;

function tokenOf(value, max = 32) {
  return normaliseTagToken(String(value ?? '')).slice(0, max);
}

function baseName(filePath) {
  const parts = String(filePath).split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * Extract deterministic tags from one content string.
 *
 * @param {string} content
 * @param {{maxTags?: number}} [options]
 * @returns {string[]} normalised tag tokens, deduplicated, at most `maxTags`
 */
export function extractTags(content, { maxTags = DEFAULT_AUTO_TAGS } = {}) {
  const text = typeof content === 'string' ? content : '';
  if (!text.trim()) return [];
  const requested = Number.isFinite(Number(maxTags)) ? Math.trunc(Number(maxTags)) : DEFAULT_AUTO_TAGS;
  const limit = Math.max(1, Math.min(MAX_AUTO_TAGS, requested));
  const tags = [];
  const seen = new Set();
  const add = (raw) => {
    const token = tokenOf(raw);
    if (!token || seen.has(token)) return;
    seen.add(token);
    tags.push(token);
  };

  const errorType = ERROR_TYPES.exec(text);
  if (errorType) add(`error:${errorType[1]}`);

  const nodeCode = NODE_CODES.exec(text);
  if (nodeCode) add(`error:${nodeCode[1]}`);

  const fence = CODE_FENCE.exec(text);
  if (fence) add(`lang:${fence[1]}`);

  const httpStatus = HTTP_STATUS.exec(text);
  if (httpStatus) add(`http:${httpStatus[1]}`);

  const windows = text.match(WINDOWS_PATH) ?? [];
  const posix = [...text.matchAll(POSIX_PATH)].map((match) => match[1]);
  const filePath = windows[0] ?? posix[0];
  if (filePath) {
    const base = baseName(filePath);
    if (base) add(`file:${base}`);
  }

  const task = TASK_STATEMENT.exec(text);
  if (task) {
    const phrase = tokenOf(task[1], 40);
    if (phrase) add(`task:${phrase}`);
  }

  return tags.slice(0, limit);
}
