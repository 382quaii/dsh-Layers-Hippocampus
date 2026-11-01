/**
 * ToolOutputSlimmer — reversible truncation for very long tool output.
 *
 * The raw black box keeps the full text; the model sees a slimmed version that
 * preserves structure (head + tail) and, crucially, the recovery address:
 *   [Slimmed] 原文快照: hash_<sha256prefix> | 提示：如需完整内容请调用 deep_raw
 *
 * Nothing is invented here: `slimToolOutput` is a pure function and the caller
 * owns the raw write. Budget is expressed in characters because the estimate is
 * deterministic (no tokeniser dependency).
 */
export const DEFAULT_SLIM_BUDGET_CHARS = 2000;
export const SLIM_HEAD_RATIO = 0.6;

function resolveSnapshotId({ turnId, sha256 }) {
  if (typeof sha256 === 'string' && sha256.length > 0) return `hash_${sha256.slice(0, 12)}`;
  if (typeof turnId === 'string' && turnId.length > 0) return `hash_${turnId.slice(0, 12)}`;
  return 'hash_unknown';
}

/**
 * @param {object} options
 * @param {string} options.text            full tool output (already captured raw)
 * @param {string} [options.turnId]
 * @param {string} [options.sha256]
 * @param {number} [options.budgetChars]
 * @returns {{slimmed: boolean, text: string, snapshotId: string|null, originalChars: number, keptChars: number}}
 */
export function slimToolOutput({ text = '', turnId = null, sha256 = null, budgetChars = DEFAULT_SLIM_BUDGET_CHARS } = {}) {
  const source = String(text ?? '');
  const originalChars = source.length;
  if (originalChars <= budgetChars) {
    return { slimmed: false, text: source, snapshotId: null, originalChars, keptChars: originalChars };
  }
  const snapshotId = resolveSnapshotId({ turnId, sha256 });
  const marker =
    `[Slimmed] 原文快照: ${snapshotId} | 提示：如需完整内容请调用 deep_raw（hash=${snapshotId.replace(/^hash_/, '')}）`;
  // Keep room for the marker itself, then split the remainder head/tail.
  const room = Math.max(200, budgetChars - marker.length);
  const head = Math.floor(room * SLIM_HEAD_RATIO);
  const tail = room - head;
  const slimmed = `${source.slice(0, head)}\n…[已裁剪 ${originalChars - head - tail} 字符]…\n${source.slice(-tail)}\n${marker}`;
  return { slimmed: true, text: slimmed, snapshotId, originalChars, keptChars: slimmed.length };
}

/** True when the text is above the budget (the caller should keep a raw copy). */
export function needsSlimming(text, budgetChars = DEFAULT_SLIM_BUDGET_CHARS) {
  return String(text ?? '').length > budgetChars;
}
