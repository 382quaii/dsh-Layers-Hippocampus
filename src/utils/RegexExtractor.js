/**
 * RegexExtractor — pure-regex entity extraction for reversible folding.
 *
 * No nested quantifiers, no backreferences: every pattern runs in linear time over
 * at most MAX_SCAN_CHARS. Results are de-duplicated with a Set and capped per
 * entity kind, so a pathological input cannot explode memory or CPU.
 *
 * Each extracted entity keeps a ±CLUE_RADIUS character window of the original
 * sentence, and that window is only surfaced when it contains an emotional or
 * failure signal ("报错/失败/惊艳/不好/…"), which is exactly the "原话线索" the
 * fold must not lose.
 */
export const MAX_SCAN_CHARS = 10_000;
export const MAX_PER_KIND = 5;
export const CLUE_RADIUS = 40;
export const CLUE_MAX_CHARS = 120;
export const EMOTION_RE = /(报错|失败|惊艳|不好|崩溃|超时|卡住|错误|异常|bug|crash|error|fail)/i;

const PATTERNS = Object.freeze([
  { kind: 'URL', re: /https?:\/\/[^\s"'<>)\]]+/g },
  { kind: 'WinPath', re: /[A-Za-z]:\\[^\s"'<>|]+/g },
  { kind: 'PosixPath', re: /(?:\/[\w.@-]+){2,}/g },
  { kind: 'CLI', re: /(?:^|[\s(])(--?[A-Za-z][\w-]*(?:=[^\s"'<>]+)?)/g },
  { kind: 'Ident', re: /\b[A-Za-z_$][\w$]{2,}(?:\.[A-Za-z_$][\w$]*)*\b/g },
]);

/** URLs and identifiers overlap; keep the longer, more specific match once. */
const IGNORED_IDENT = new Set(['http', 'https', 'www', 'the', 'and', 'for', 'with', 'this', 'that', 'from']);

function clueAround(text, start, end) {
  const from = Math.max(0, start - CLUE_RADIUS);
  const to = Math.min(text.length, end + CLUE_RADIUS);
  const window = text.slice(from, to).replace(/\s+/g, ' ').trim();
  if (!EMOTION_RE.test(window)) return null;
  return window.slice(0, CLUE_MAX_CHARS);
}

/**
 * Extract entities with optional emotional clue windows.
 * @returns {{entities: Array<{kind:string,value:string,clue:string|null}>, scannedLength:number, truncated:boolean}}
 */
export function extractEntities(input, { maxPerKind = MAX_PER_KIND } = {}) {
  const source = String(input ?? '');
  const text = source.length > MAX_SCAN_CHARS ? source.slice(0, MAX_SCAN_CHARS) : source;
  const seen = new Set();
  const perKind = new Map();
  const entities = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const value = (kind === 'CLI' ? match[1] : match[0]).trim();
      if (!value) continue;
      if (kind === 'Ident' && (IGNORED_IDENT.has(value.toLowerCase()) || value.length < 3)) continue;
      if (kind === 'Ident' && /^(?:[A-Za-z]:|https?)/.test(value)) continue;
      const count = perKind.get(kind) ?? 0;
      if (count >= maxPerKind) break;
      const dedupeKey = `${kind}:${value}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      perKind.set(kind, count + 1);
      entities.push({ kind, value, clue: clueAround(text, match.index, match.index + value.length) });
    }
  }
  return { entities, scannedLength: text.length, truncated: source.length > MAX_SCAN_CHARS };
}

/** Render the fold block: `[Auto-Folded] 实体: xxx | 原话线索: "..."`. */
export function renderAutoFolded(entities = []) {
  if (entities.length === 0) return '';
  const lines = entities.map((entity) => {
    const clue = entity.clue ? ` | 原话线索: "${entity.clue}"` : '';
    return `[Auto-Folded] ${entity.kind}: ${entity.value}${clue}`;
  });
  return lines.join('\n');
}

/** One-shot: text -> fold block (empty string when nothing worth keeping). */
export function foldText(input) {
  return renderAutoFolded(extractEntities(input).entities);
}
