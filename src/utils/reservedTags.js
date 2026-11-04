/**
 * System-reserved tags (v1.5.6).
 *
 * The engine marks its own bookkeeping with tags like `status:folded`,
 * `status:handoff` and `folded-summary`. They are high-frequency by design, so if
 * they leak into the tag tree or the knowledge graph they become huge nodes that
 * outshine the user's real memories. They must NEVER be projected into a
 * user-facing view.
 *
 * The inverted index still keeps them (recall/handoff internals depend on them);
 * this module is only about DISPLAY projections: tag tree, graph, hints.
 */

export const SYSTEM_RESERVED_PREFIXES = Object.freeze(['status:']);

export const SYSTEM_RESERVED_TAGS = Object.freeze(['folded-summary', 'active_task']);

/** True for a string tag or an index tag projection `{tag}`. */
export function isSystemReservedTag(value) {
  const tag = typeof value === 'string' ? value : value?.tag;
  if (typeof tag !== 'string' || tag.length === 0) return false;
  if (SYSTEM_RESERVED_TAGS.includes(tag)) return true;
  return SYSTEM_RESERVED_PREFIXES.some((prefix) => tag.startsWith(prefix));
}
