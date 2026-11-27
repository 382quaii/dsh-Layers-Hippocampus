/**
 * v1.7.3 (module 1): PHYSICAL context pruning with pointers.
 *
 * The host's `compaction-basic` summarises old history with a MODEL CALL: it costs
 * tokens, it is slow, and its output is a lossy paraphrase that cannot be audited.
 * This module folds instead of summarising:
 *
 *   old turn (8 000 chars of tool output)
 *     → `[System: 此段包含 N 轮关于 [tag] 的细节，已折叠。原文 ID: ev_xxx。若需要，请使用 recall 工具检索。]`
 *
 * The original bytes are untouched in the raw log and still reachable through
 * `deep_raw` / `recall`, so folding is REVERSIBLE in a way a summary is not. Nothing
 * here sends a request to a provider: the only thing it spends is CPU.
 *
 * Invariants (a violation corrupts the conversation, so they are enforced here):
 *   - a node is replaced ON THE SURFACE ONLY: the log keeps the original event and a
 *     `compaction/prune` record explains what was shadowed and why;
 *   - `tool/call` nodes are never rewritten, so every surviving `tool/result` still
 *     has its call (and a folded result keeps its call id in the pointer context);
 *   - the most recent `keepRecentTurns` user turns are untouchable — the model must
 *     always see what was just asked;
 *   - the pointer is never empty: an empty replacement would look like the turn was
 *     deleted, which is exactly the failure mode this is meant to avoid.
 */

export const FOLD_MARKER = '[System: 此段包含';
/** Below this, folding a node saves nothing worth the risk. */
export const FOLD_MIN_CHARS = 1200;
/** Hard ceiling on how much one request may fold, so pruning cannot snowball. */
export const FOLD_MAX_NODES = 8;

/**
 * The pointer text. Kept deliberately short (≈120 chars): the whole point is that it
 * is much smaller than what it replaces.
 *
 * @param {{turns?: number, tags?: string[], eventId?: string|null, turnId?: string|null, tool?: string|null}} input
 */
export function foldPointer({ turns = 1, tags = [], eventId = null, turnId = null, tool = null } = {}) {
  const label = (Array.isArray(tags) ? tags : []).filter((tag) => typeof tag === 'string' && tag.length > 0).slice(0, 2);
  const topic = label.length > 0 ? label.map((tag) => `[${tag}]`).join('') : '[未标注]';
  const turnWord = Number(turns) > 1 ? `${Number(turns)} 轮` : '1 轮';
  const ref = eventId ? `ev_${String(eventId).replace(/^ev_/, '')}` : turnId ? `raw:${turnId}` : 'unknown';
  const toolHint = tool ? `（${tool} 的工具输出）` : '';
  return `${FOLD_MARKER}${turnWord}关于 ${topic} 的细节${toolHint}，已折叠。原文 ID: ${ref}。若需要，请使用 recall 工具检索。]`;
}

function textOfBlocks(content) {
  const blocks = Array.isArray(content) ? content : [];
  let total = 0;
  for (const block of blocks) {
    if (block && typeof block.text === 'string') total += block.text.length;
  }
  return total;
}

function messageOf(session, seq) {
  try {
    const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : null;
    if (!event) return null;
    const message = typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : null;
    return { event, message };
  } catch {
    return null;
  }
}

/**
 * Which surface nodes are eligible to be folded.
 *
 * Separated from the mutation so the decision is testable without a host session and
 * so the caller can log what WOULD happen at a dry run.
 *
 * @param {object} session host Session (`surface.nodes`, `eventAt`, `deriveEventMessage`)
 * @param {{keepRecentTurns?: number, minChars?: number, maxNodes?: number, describe?: Function}} options
 * @returns {{candidates: object[], protectedFrom: number|null, scanned: number}}
 */
export function planSmartPrune(session, options = {}) {
  const keepRecentTurns = Math.max(0, Number(options.keepRecentTurns ?? 3));
  const minChars = Math.max(0, Number(options.minChars ?? FOLD_MIN_CHARS));
  const maxNodes = Math.max(1, Number(options.maxNodes ?? FOLD_MAX_NODES));
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : [];

  // The keep-window is measured in USER turns, not nodes: one turn may be a dozen
  // tool results, and protecting only N nodes would fold the question itself.
  let protectedFrom = null;
  if (keepRecentTurns > 0) {
    let seen = 0;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = messageOf(session, nodes[index]);
      if (!node) continue;
      if (node.event?.type === 'user/message') {
        seen += 1;
        if (seen >= keepRecentTurns) {
          protectedFrom = index;
          break;
        }
      }
    }
  }

  const candidates = [];
  let scanned = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    if (protectedFrom !== null && index >= protectedFrom) break;
    const seq = nodes[index];
    const found = messageOf(session, seq);
    if (!found) continue;
    const { event, message } = found;
    scanned += 1;
    // A tool/call has no text and its pair must stay intact.
    if (event?.type === 'tool/call') continue;
    if (!message || !Array.isArray(message.content)) continue;
    const chars = textOfBlocks(message.content);
    if (chars < minChars) continue;
    const already = message.content.some(
      (block) => block && typeof block.text === 'string' && block.text.startsWith(FOLD_MARKER),
    );
    if (already) continue;
    const described = typeof options.describe === 'function' ? options.describe({ seq, event, message, chars }) : null;
    candidates.push({
      seq,
      type: event?.type ?? 'user/message',
      chars,
      eventId: described?.eventId ?? null,
      turnId: described?.turnId ?? null,
      tags: Array.isArray(described?.tags) ? described.tags : [],
      tool: typeof described?.tool === 'string' ? described.tool : event?.data?.name ?? null,
      message,
    });
    if (candidates.length >= maxNodes) break;
  }
  // Largest first: folding big nodes is where the tokens are, and folding many small
  // ones costs more surface churn for the same saving.
  candidates.sort((left, right) => right.chars - left.chars);
  return { candidates, protectedFrom, scanned };
}

/**
 * Apply the plan. One node at a time, each through the host's surface-replace
 * protocol; a failure on one node never aborts the rest (pruning is best-effort,
 * whereas a half-written surface would be corruption).
 *
 * @returns {{folded:number, charsBefore:number, charsAfter:number, pointers:object[], failed:string|null, scanned:number}}
 */
export function smartPruneSession(session, options = {}) {
  const report = { folded: 0, charsBefore: 0, charsAfter: 0, pointers: [], failed: null, scanned: 0 };
  if (!session || typeof session.append !== 'function') return report;
  let plan;
  try {
    plan = planSmartPrune(session, options);
  } catch (error) {
    report.failed = error?.message ?? String(error);
    return report;
  }
  report.scanned = plan.scanned;
  const tagCount = Math.max(1, Number(options.turnsPerPointer ?? 1));
  for (const candidate of plan.candidates) {
    const pointer = foldPointer({
      turns: tagCount,
      tags: candidate.tags,
      eventId: candidate.eventId,
      turnId: candidate.turnId,
      tool: candidate.tool,
    });
    const content = [{ type: 'text', text: pointer }];
    try {
      session.append('compaction/prune', {
        shadowedRange: { start: candidate.seq, end: candidate.seq },
        shadowedSeqs: [candidate.seq],
        shadowedTokenCount: Math.ceil(candidate.chars / 4),
        reason: 'hippocampus:smart-context-prune',
        pointer,
      });
      session.append(
        candidate.type,
        { ...(candidate.message?.data ?? null), ...(options.eventData?.(candidate) ?? {}), message: { ...candidate.message, content } },
        { surfaceOp: { op: 'replace', startSeq: candidate.seq, endSeq: candidate.seq }, sourceEventSeqs: [candidate.seq] },
      );
      report.folded += 1;
      report.charsBefore += candidate.chars;
      report.charsAfter += pointer.length;
      report.pointers.push({ seq: candidate.seq, eventId: candidate.eventId, chars: candidate.chars, pointer });
    } catch (error) {
      report.failed = error?.message ?? String(error);
    }
  }
  return report;
}
