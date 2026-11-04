/**
 * Relevance-first memory hints (v1.5.6).
 *
 * Injecting the globally most active tags is noise: a conversation about React
 * does not benefit from "error:java-oom" merely because it is the busiest tag in
 * the store. Instead, the prompt tail carries at most HINT_LIMIT tags that
 * lexically overlap the CURRENT user input (or code block), plus one sentence
 * telling the model how to use them. Internal bookkeeping tags never appear.
 *
 * Pure and deterministic: no LLM, no network, no timers.
 */

import { tokenize } from '../retrieval.js';

/** Never inject more than this many tags. */
export const HINT_LIMIT = 5;
const INTERNAL_TAG = /^(?:status:|month:|context:)/;
const INTERNAL_TAGS = new Set(['active_task']);
const CJK = /[\u3400-\u9fff]/;

function isInternal(tag) {
  return INTERNAL_TAGS.has(tag) || INTERNAL_TAG.test(tag);
}

/**
 * Pick the tags that lexically overlap the current input.
 *
 * v1.5.6 fallback: when nothing overlaps (e.g. the user just says “继续” / “在吗”),
 * reuse the PREVIOUS turn's matched tags (at most two) so the model still gets a
 * thread to pull. Purely local; internal tags are still filtered out.
 *
 * @param {{text?: string, activeTags?: Array<string|{tag:string}>, limit?: number,
 *          fallbackTags?: string[]}} options
 * @returns {string[]} at most `limit` relevant tag names, best match first
 */
export function selectRelevantTags({ text = '', activeTags = [], limit = HINT_LIMIT, fallbackTags = [] } = {}) {
  const source = String(text ?? '').toLowerCase();
  const tokens = new Set(tokenize(source));
  const scored = [];
  for (const entry of activeTags) {
    const tag = typeof entry === 'string' ? entry : entry?.tag;
    if (typeof tag !== 'string' || !tag || isInternal(tag)) continue;
    const lower = tag.toLowerCase();
    let score = 0;
    if (source.includes(lower)) {
      score = 3; // the whole tag appears verbatim in the input
    } else {
      const parts = lower.split(/[:/._-]+/).filter((part) => part.length >= 2);
      for (const part of parts) {
        if (tokens.has(part)) score += 1;
        else if (CJK.test(part) && source.includes(part)) score += 1;
      }
    }
    if (score > 0) scored.push({ tag, score });
  }
  scored.sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
  if (scored.length > 0) return scored.slice(0, Math.max(1, limit)).map((entry) => entry.tag);
  // No lexical match: carry the previous turn's tags forward (bounded, filtered).
  const carried = [...new Set(Array.isArray(fallbackTags) ? fallbackTags : [])]
    .filter((tag) => typeof tag === 'string' && tag && !isInternal(tag))
    .slice(0, Math.max(1, Math.min(2, limit)));
  return carried;
}

/**
 * Render the `[Memory Hints]` block. Empty string when nothing matched — the
 * section is simply absent rather than padded with irrelevant tags.
 */
export function renderMemoryHints(tags = [], { toolName = 'memory_recall' } = {}) {
  if (!Array.isArray(tags) || tags.length === 0) return '';
  return [
    '[Memory Hints]',
    `系统检测到相关经验标签：${tags.join('、')}。若需借鉴请调用 ${toolName}。`,
  ].join('\n');
}
