/**
 * Referential content dedup for the INDEX layer (v1.6.1, "编码层小改").
 *
 * The log stays raw and row-addressable: every record keeps its own `content`, so
 * `deep_raw`, hash restore and the row-level cursor are untouched. What this module
 * removes is the REPEATED COPY inside the read model: when the same long text (tool
 * schema, system prompt block, role template) appears in `minOccurrences`+ events and
 * is at least `minChars` long, the index stores it ONCE in `templates.json` and each
 * event carries `contentRef` instead of the full text.
 *
 * Contract:
 *   - the index is a derived read model, so a rematerialised content is still exact;
 *   - `resolveTemplates()` runs on every index load, so readers never see a ref;
 *   - a missing template file degrades to "no dedup" (refs stay unresolved → the
 *     event content is empty only for events that were stored as refs, which cannot
 *     happen without the template file).
 */

import { sha256 } from '../util.js';

export const TEMPLATE_MIN_CHARS = 512;
export const TEMPLATE_MIN_OCCURRENCES = 2;

export function templateRefFor(content) {
  return `tpl_${sha256(content).slice(0, 16)}`;
}

/**
 * Replace repeated long contents with refs.
 * @param {object[]} events projected index events (each may carry `content`)
 * @param {{minChars?: number, minOccurrences?: number}} [options]
 * @returns {{events: object[], templates: object, stats: {templates: number, refs: number, savedChars: number}}}
 */
export function dedupeTemplates(events, options = {}) {
  const minChars = Math.max(1, Number(options.minChars ?? TEMPLATE_MIN_CHARS));
  const minOccurrences = Math.max(2, Number(options.minOccurrences ?? TEMPLATE_MIN_OCCURRENCES));
  const counts = new Map();
  for (const event of events) {
    const content = event?.content;
    if (typeof content !== 'string' || content.length < minChars) continue;
    counts.set(content, (counts.get(content) ?? 0) + 1);
  }
  const repeated = new Map();
  for (const [content, count] of counts) {
    if (count >= minOccurrences) repeated.set(content, templateRefFor(content));
  }
  if (repeated.size === 0) {
    return { events, templates: {}, stats: { templates: 0, refs: 0, savedChars: 0 } };
  }
  const templates = {};
  for (const [content, ref] of repeated) templates[ref] = content;
  let refs = 0;
  let savedChars = 0;
  const projected = events.map((event) => {
    const content = event?.content;
    if (typeof content !== 'string') return event;
    const ref = repeated.get(content);
    if (!ref) return event;
    refs += 1;
    // Every copy beyond the single stored template is a saved copy.
    savedChars += content.length;
    return { ...event, content: '', contentRef: ref };
  });
  savedChars -= [...repeated.keys()].reduce((sum, content) => sum + content.length, 0);
  return { events: projected, templates, stats: { templates: repeated.size, refs, savedChars: Math.max(0, savedChars) } };
}

/**
 * Restore every `contentRef` back to its full text. Shallow: returns new objects for
 * ref-carrying events only, so an index without templates costs nothing.
 */
export function resolveTemplates(events, templates) {
  if (!templates || Object.keys(templates).length === 0) return events;
  let changed = false;
  const resolved = events.map((event) => {
    const ref = event?.contentRef;
    if (!ref) return event;
    const content = templates[ref];
    if (typeof content !== 'string') return event;
    changed = true;
    return { ...event, content };
  });
  return changed ? resolved : events;
}
