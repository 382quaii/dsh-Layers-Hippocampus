/**
 * v1.6.3 — Live Compact: turn ONE oversized tool result into a POINTER.
 *
 * The failure this prevents is sudden, not gradual: a single `read_file` /
 * `bash` / web fetch can return hundreds of thousands of characters in one turn,
 * and that turn's request then blows the window before any "pressure" threshold
 * gets a chance to fire. Waiting for the next maintenance tick is useless — the
 * request is composed now.
 *
 * Policy (deliberately conservative):
 *   - only `tool/result` surface nodes are touched;
 *   - only when the node alone exceeds `liveCompact.thresholdChars`;
 *   - the head and the tail are kept verbatim, the middle becomes ONE pointer line
 *     carrying the durable identity (session seq / callId) so the model can ask
 *     for the full text again via `deep_raw` instead of carrying it forever;
 *   - the replacement is appended through the HOST's own surface mechanism
 *     (`session.append(..., { surfaceOp: { op: 'replace' } })`), never by editing
 *     history in place. If the host rejects it we log and continue: an un-pruned
 *     request is better than a broken turn.
 *
 * Zero dependencies: `freezeMessage` is not imported. The host freezes what it
 * accepts; a plain frozen-by-us object is enough for the surface protocol.
 */

/** Marker inserted where the removed middle was. Machine-greppable on purpose. */
export const POINTER_MARKER = '[[hippocampus:live-compact';

/** Defaults; overridable through `context.liveCompact.*`. */
export const LIVE_COMPACT_DEFAULTS = Object.freeze({
  enabled: true,
  thresholdChars: 200_000,
  headChars: 4_000,
  tailChars: 2_000,
  maxNodesPerRequest: 4,
});

/** Total code-point length of the text blocks of one tool result. */
export function contentChars(content) {
  let chars = 0;
  for (const block of Array.isArray(content) ? content : []) {
    if (block && block.type === 'text' && typeof block.text === 'string') chars += block.text.length;
  }
  return chars;
}

/**
 * Replace the middle of a text with a pointer, keeping head and tail.
 *
 * Slicing is by code point so a surrogate pair is never split. The pointer names
 * the durable coordinates a later `deep_raw` lookup needs.
 *
 * @param {string} text
 * @param {{ headChars?: number, tailChars?: number, ref?: { seq?: number, callId?: string, tool?: string, eventId?: string } }} [options]
 * @returns {{ text: string, removedChars: number }}
 */
export function pointerizeText(text, { headChars = 4000, tailChars = 2000, ref = {} } = {}) {
  const points = Array.from(String(text ?? ''));
  const head = Math.max(0, Math.trunc(headChars));
  const tail = Math.max(0, Math.trunc(tailChars));
  if (points.length <= head + tail + 200) return { text: String(text ?? ''), removedChars: 0 };
  const removed = points.length - head - tail;
  const pointer = `\n\n${pointerLine({ removedChars: removed, ref })}\n\n`;
  return {
    text: points.slice(0, head).join('') + pointer + points.slice(points.length - tail).join(''),
    removedChars: removed,
  };
}

/**
 * Plan the pointerization of one tool result's content blocks.
 *
 * The global head/tail character budgets are distributed across the text blocks in
 * order: a block keeps its intersection with `[0, headChars)` and with
 * `[total - tailChars, total)`, and drops whatever falls in between. Non-text
 * blocks (images, files) are always preserved — they are not text flood. One
 * pointer block is inserted at the first dropped position.
 *
 * @param {Array<object>} content  tool result content blocks
 * @param {{ thresholdChars?: number, headChars?: number, tailChars?: number, ref?: object }} [options]
 * @returns {{ changed: boolean, content: Array<object>, charsBefore: number, charsAfter: number }}
 */
export function planPointerization(content, { thresholdChars = 200_000, headChars = 4000, tailChars = 2000, ref = {} } = {}) {
  const blocks = Array.isArray(content) ? content : [];
  const before = contentChars(blocks);
  if (before <= thresholdChars) return { changed: false, content: blocks, charsBefore: before, charsAfter: before };

  const head = Math.max(0, Math.trunc(headChars));
  const tail = Math.max(0, Math.trunc(tailChars));
  const tailStart = Math.max(0, before - tail);
  const pointerText = pointerLine({
    removedChars: Math.max(0, tailStart - head),
    ref,
  });

  const out = [];
  let consumed = 0;
  let pointerInserted = false;
  for (const block of blocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') {
      out.push(block);
      continue;
    }
    const points = Array.from(block.text);
    const start = consumed;
    const end = start + points.length;
    consumed = end;

    const headEnd = Math.min(end, head);
    if (headEnd > start) out.push({ ...block, text: points.slice(0, headEnd - start).join('') });

    if (!pointerInserted && end > head) {
      out.push({ type: 'text', text: pointerText });
      pointerInserted = true;
    }

    const tailBegin = Math.max(start, tailStart);
    if (end > tailBegin) out.push({ ...block, text: points.slice(tailBegin - start).join('') });
  }
  if (!pointerInserted) out.push({ type: 'text', text: pointerText });

  const after = contentChars(out);
  if (after >= before) return { changed: false, content: blocks, charsBefore: before, charsAfter: before };
  return { changed: true, content: out, charsBefore: before, charsAfter: after };
}

/** The one machine-greppable pointer line a pruned result carries. */
function pointerLine({ removedChars, ref = {} }) {
  const where = [
    ref.seq === undefined ? null : `seq=${ref.seq}`,
    ref.callId ? `call=${ref.callId}` : null,
    ref.tool ? `tool=${ref.tool}` : null,
  ].filter(Boolean);
  return (
    `${POINTER_MARKER}: removed ${removedChars} chars of the middle; ` +
    `the full text is still in the raw log (${where.join(', ') || 'raw log'}) — ` +
    'call the hippocampus deep_raw tool with those coordinates if you need it again]]'
  );
}

/**
 * Apply Live Compact to a live session surface.
 *
 * Returns a report instead of throwing: this runs on the request path, where a
 * failure must degrade (send the un-pruned request) rather than break the turn.
 *
 * @param {object} session  host Session (surface + append + deriveEventMessage)
 * @param {{ thresholdChars?: number, headChars?: number, tailChars?: number, maxNodesPerRequest?: number, logger?: object }} [options]
 */
export function liveCompactSession(session, options = {}) {
  const {
    thresholdChars = LIVE_COMPACT_DEFAULTS.thresholdChars,
    headChars = LIVE_COMPACT_DEFAULTS.headChars,
    tailChars = LIVE_COMPACT_DEFAULTS.tailChars,
    maxNodesPerRequest = LIVE_COMPACT_DEFAULTS.maxNodesPerRequest,
    logger = null,
  } = options;
  const report = { scanned: 0, pruned: 0, charsRemoved: 0, nodes: [], failed: null };
  if (!session || typeof session.append !== 'function' || !session.surface || typeof session.eventAt !== 'function') {
    return report;
  }
  try {
    const seqs = [...(session.surface.nodes ?? [])];
    for (const seq of seqs) {
      if (report.pruned >= maxNodesPerRequest) break;
      const event = session.eventAt(seq);
      if (!event || event.type !== 'tool/result') continue;
      report.scanned += 1;
      const original = typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : null;
      if (!original || !Array.isArray(original.content)) continue;
      const plan = planPointerization(original.content, {
        thresholdChars,
        headChars,
        tailChars,
        ref: { seq, callId: original?.source?.callId, tool: original?.source?.tool },
      });
      if (!plan.changed) continue;
      try {
        session.append('compaction/prune', {
          shadowedRange: { start: seq, end: seq },
          shadowedSeqs: [seq],
          shadowedTokenCount: Math.ceil(plan.charsBefore / 4),
        });
        const replacement = session.append(
          'tool/result',
          { ...event.data, message: { ...original, content: plan.content } },
          { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
        );
        report.pruned += 1;
        report.charsRemoved += plan.charsBefore - plan.charsAfter;
        report.nodes.push({ originalSeq: seq, replacementSeq: replacement?.seq ?? null, charsBefore: plan.charsBefore, charsAfter: plan.charsAfter });
      } catch (error) {
        report.failed = error?.message ?? String(error);
        logger?.warn?.(`hippocampus: live-compact could not replace seq ${seq}: ${report.failed}`);
      }
    }
  } catch (error) {
    report.failed = error?.message ?? String(error);
    logger?.warn?.(`hippocampus: live-compact failed: ${report.failed}`);
  }
  return report;
}
