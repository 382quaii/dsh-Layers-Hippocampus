/**
 * Prompt layout with a cache-stable prefix.
 *
 * DeepSeek's prefix cache is broken by ANY change before the first volatile
 * section. So the rendered prompt is composed in exactly this order:
 *
 *   [stable rules]            <- never changes for a given config
 *   [memory map]              <- optional; legacy count view, slow-moving
 *   [memory blocks]           <- fast-changing window blocks
 *   [memory hints]            <- v1.5.6 relevance-first tail (after the marker,
 *                                so a per-turn hint never disturbs the prefix)
 *
 * `stablePrefix()` returns everything before the block marker; tests assert that
 * prefix equality survives different block and hint contents.
 */
export const BLOCK_MARKER = '[Memory Blocks]';
export const ACTIVE_TASK_MARKER = '[Active Task]';
export const POINTER_MARKER = '[Memory Index]';
// v1.7.1: the CURRENT-STATE line (task mode). It is the most volatile thing in the
// prompt (window pressure changes every turn), so it goes LAST — after every other
// volatile section — and never before the block marker.
export const STATE_MARKER = '[Task State]';

export function composePrompt({
  rules = '',
  activeTask = '',
  map = '',
  hints = '',
  blocks = '',
  pointers = '',
  stateLine = '',
} = {}) {
  const parts = [String(rules).trim()];
  // The active task sits at the very top of the memory section: a new session must
  // know what it was doing before it reads anything else.
  if (String(activeTask).trim()) parts.push(`${ACTIVE_TASK_MARKER}\n${String(activeTask).trim()}`);
  if (String(map).trim()) parts.push(`[Memory Map]\n${String(map).trim()}`);
  parts.push(`${BLOCK_MARKER}\n${String(blocks).trim()}`);
  // Hints are per-turn (they depend on the current input) and therefore live
  // AFTER the block marker: the cacheable prefix stays byte-identical.
  if (String(hints).trim()) parts.push(String(hints).trim());
  // v1.6.9 (module 3): index pointers sit UNDER the hints — both are per-turn and
  // both must stay after the block marker so the cacheable prefix never moves.
  if (String(pointers).trim()) parts.push(`${POINTER_MARKER}\n${String(pointers).trim()}`);
  // v1.7.1: the task-state line changes on almost every turn, so it must be the very
  // last section — everything above it stays byte-identical for the prefix cache.
  if (String(stateLine).trim()) parts.push(`${STATE_MARKER}\n${String(stateLine).trim()}`);
  return parts.filter(Boolean).join('\n\n');
}

/** Render the `[Active Task]` body from the handoff summary or the newest task tag. */
export function renderActiveTask(task) {
  const text = String(task?.text ?? '').trim();
  if (!text) return '';
  return text.slice(0, 1200);
}

export function stablePrefix(prompt) {
  const text = String(prompt ?? '');
  const index = text.indexOf(BLOCK_MARKER);
  return index < 0 ? text : text.slice(0, index);
}

/**
 * v1.6.9 (module 3): render index pointers — eventId + tags + title, NEVER bodies.
 *
 * Hard-bounded by `maxChars`: an injection that costs more than a few dozen tokens
 * defeats its own purpose, so the budget is enforced here rather than trusted from
 * the caller.
 */
export function renderPointers(entries = [], { maxChars = 300 } = {}) {
  const budget = Math.max(0, Number(maxChars) || 0);
  const lines = [];
  let used = 0;
  for (const entry of entries) {
    const id = String(entry?.eventId ?? '').trim();
    if (!id) continue;
    const tags = Array.isArray(entry.tags) ? entry.tags.filter(Boolean).slice(0, 2) : [];
    const title = String(entry?.title ?? '').replace(/\s+/g, ' ').trim();
    const line = `- [memory ${id}] ${[...tags, title].filter(Boolean).join(' · ')}`.trimEnd();
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * v1.7.1: render the `[Task State]` body.
 *
 * Contract: ONE line, `·`-separated, hard-capped by `maxChars`. This exists because a
 * build/debug task needs "where am I right now" (repo HEAD, window pressure), while
 * memory summarises where it has BEEN. Anything that does not fit the budget is cut,
 * not wrapped — a status dump in the prompt tail is worse than a short line.
 */
export function renderStateLine(fields = {}, { maxChars = 300 } = {}) {
  const budget = Math.max(0, Number(maxChars) || 0);
  const parts = [];
  for (const value of Object.values(fields ?? {})) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (text) parts.push(text);
  }
  const line = parts.join(' · ');
  if (budget > 0 && line.length > budget) return line.slice(0, Math.max(0, budget - 1)) + '…';
  return line;
}

/** Map view: tag names + counts only, never event bodies. */
export function renderMemoryMap(entries = []) {
  return entries.map((entry) => `${entry.tag}(${entry.count ?? entry.events ?? 0})`).join(' · ');
}
