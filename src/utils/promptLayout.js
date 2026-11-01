/**
 * Prompt layout with a cache-stable prefix.
 *
 * DeepSeek's prefix cache is broken by ANY change before the first volatile
 * section. So the rendered prompt is composed in exactly this order:
 *
 *   [stable rules]            <- never changes for a given config
 *   [memory map]              <- tags + counts only (small, slow-moving)
 *   [memory blocks]           <- the only fast-changing tail
 *
 * `stablePrefix()` returns everything before the block marker; tests assert that
 * prefix equality survives different block contents.
 */
export const BLOCK_MARKER = '[Memory Blocks]';

export function composePrompt({ rules = '', map = '', blocks = '' } = {}) {
  const parts = [String(rules).trim()];
  if (String(map).trim()) parts.push(`[Memory Map]\n${String(map).trim()}`);
  parts.push(`${BLOCK_MARKER}\n${String(blocks).trim()}`);
  return parts.filter(Boolean).join('\n\n');
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
