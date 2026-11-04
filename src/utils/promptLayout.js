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

export function composePrompt({ rules = '', activeTask = '', map = '', hints = '', blocks = '' } = {}) {
  const parts = [String(rules).trim()];
  // The active task sits at the very top of the memory section: a new session must
  // know what it was doing before it reads anything else.
  if (String(activeTask).trim()) parts.push(`${ACTIVE_TASK_MARKER}\n${String(activeTask).trim()}`);
  if (String(map).trim()) parts.push(`[Memory Map]\n${String(map).trim()}`);
  parts.push(`${BLOCK_MARKER}\n${String(blocks).trim()}`);
  // Hints are per-turn (they depend on the current input) and therefore live
  // AFTER the block marker: the cacheable prefix stays byte-identical.
  if (String(hints).trim()) parts.push(String(hints).trim());
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

/** Map view: tag names + counts only, never event bodies. */
export function renderMemoryMap(entries = []) {
  return entries.map((entry) => `${entry.tag}(${entry.count ?? entry.events ?? 0})`).join(' · ');
}
