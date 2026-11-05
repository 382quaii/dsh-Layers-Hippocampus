/**
 * Error types for the memory plugin.
 *
 * Every failure that can cross the plugin boundary carries a stable machine code
 * (`MEM_E_*`). Tool results render the code so a caller can branch on it, and the
 * Host log line always includes it. Codes are append-only: never renumber, never
 * reuse.
 */

export const ErrorCodes = Object.freeze({
  INVALID_INPUT: 'MEM_E_INVALID_INPUT',
  INVALID_CONFIG: 'MEM_E_INVALID_CONFIG',
  INVALID_POLICY: 'MEM_E_INVALID_POLICY',
  LOG_CORRUPT: 'MEM_E_LOG_CORRUPT',
  INDEX_MISSING: 'MEM_E_INDEX_MISSING',
  INDEX_CORRUPT: 'MEM_E_INDEX_CORRUPT',
  NOT_FOUND: 'MEM_E_NOT_FOUND',
  ALREADY_PURGED: 'MEM_E_ALREADY_PURGED',
  CONSOLIDATION_REQUIRED: 'MEM_E_CONSOLIDATION_REQUIRED',
  WRITER_BUSY: 'MEM_E_WRITER_BUSY',
  IO: 'MEM_E_IO',
  CLOCK_INVALID: 'MEM_E_CLOCK_INVALID',
  EVENT_TIME_REQUIRED: 'MEM_E_EVENT_TIME_REQUIRED',
  DUPLICATE_SUPPRESSED: 'MEM_E_DUPLICATE_SUPPRESSED',
  TOMBSTONED: 'MEM_E_TOMBSTONED',
  INVALID_MEDIA: 'MEM_E_INVALID_MEDIA',
  NOT_READY: 'MEM_E_NOT_READY',
  /** Another maintenance pass is already running; the service refuses to queue it. */
  MAINTENANCE_RUNNING: 'MEM_E_MAINTENANCE_RUNNING',
  /** The cross-plugin `hippocampus` service was disposed with its plugin fiber. */
  SERVICE_DISPOSED: 'MEM_E_SERVICE_DISPOSED',
  /** Federation bookkeeping failed; the write itself is unaffected. */
  FEDERATION_FAILED: 'MEM_E_FEDERATION_FAILED',

  // ---- configuration (fail-fast at boot; never silently downgraded) ---------
  CONFIG_DEPRECATED: 'MEM_E_CONFIG_DEPRECATED',
  CONFIG_INVALID_CRON: 'MEM_E_CONFIG_INVALID_CRON',
  CONFIG_OUT_OF_RANGE: 'MEM_E_CONFIG_OUT_OF_RANGE',
  CONFIG_UNKNOWN_ENUM: 'MEM_E_CONFIG_UNKNOWN_ENUM',
  CONFIG_INVALID_TYPE: 'MEM_E_CONFIG_INVALID_TYPE',
  CONFIG_UNKNOWN_KEY: 'MEM_E_CONFIG_UNKNOWN_KEY',
  CONFIG_CONFLICT: 'MEM_E_CONFIG_CONFLICT',
  CONFIG_MIGRATION_INTERRUPTED: 'MEM_E_CONFIG_MIGRATION_INTERRUPTED',
  CONFIG_MIGRATION_LOCKED: 'MEM_E_CONFIG_MIGRATION_LOCKED',
  CONFIG_MIGRATION_MISMATCH: 'MEM_E_CONFIG_MIGRATION_MISMATCH',

  // ---- raw turns / migration (v1.4.0) --------------------------------------
  RAW_DISABLED: 'MEM_E_RAW_DISABLED',
  MIGRATION_LOCKED: 'MEM_E_MIGRATION_LOCKED',
  MIGRATION_PATH: 'MEM_E_MIGRATION_PATH',
  MIGRATION_TARGET_BUSY: 'MEM_E_MIGRATION_TARGET_BUSY',
  MIGRATION_MISMATCH: 'MEM_E_MIGRATION_MISMATCH',
  MIGRATION_TIMEOUT: 'MEM_E_MIGRATION_TIMEOUT',
  MIGRATION_IO: 'MEM_E_MIGRATION_IO',

  // ---- v1.5.0: tag explosion, multi-space transfer -------------------------
  /** A deep_raw query touches a super tag (>500 associations): a time window is mandatory. */
  TIME_RANGE_REQUIRED: 'MEM_E_TIME_RANGE_REQUIRED',
  /** Cross-space transfer refused: the payload matched a privacy-sensitive pattern. */
  PRIVACY_BLOCKED: 'MEM_E_PRIVACY_BLOCKED',
  /**
   * Cross-space transfer refused: the model may never move memories on its own.
   * The call was made without `user_approved:true` while
   * `context.requireExplicitConsentForTransfer` is enabled (the default).
   */
  REQUIRE_USER_CONSENT: 'MEM_E_REQUIRE_USER_CONSENT',

  // ---- v1.5.3 space management hardening --------------------------------
  /**
   * A NEW space id is malformed, reserved, or collides with an existing space /
   * a non-directory path. Always a 400 for the create route; never written to
   * JSONL, never silently clamped to another id.
   */
  SPACE_INVALID: 'MEM_E_SPACE_INVALID',

  // ---- v1.5.3 tool schema pruning (tools.disabled) ----------------------
  /**
   * `tools.disabled` names something that is not a tool of this plugin, names a
   * CORE tool (remember/recall/admin may never be disabled), or repeats a name.
   * Fail-fast at config resolution: a typo must abort activation, never silently
   * leave a tool enabled under a misspelled key.
   */
  INVALID_TOOL_NAME: 'MEM_E_INVALID_TOOL_NAME',

  // ---- v1.5.4 handoff state machine -------------------------------------
  /**
   * Automatic handoff distillation failed or timed out. The engine records a
   * degraded (but ACTIVE) marker and lets the next session start — it never
   * rejects, never leaves the state machine in-flight, never locks the user out.
   */
  HANDOFF_FAILED: 'MEM_E_HANDOFF_FAILED',

  // ---- v1.5.5 Dream LLM distillation ------------------------------------
  /**
   * Dream's LLM call could not produce a usable structured answer: no endpoint /
   * model configured, network failure, timeout, or a non-JSON reply. NEVER fatal:
   * the engine records this warning, degrades to the deterministic local merge
   * (time range + deduplicated core text) and keeps `meta.source_event_ids` on the
   * result. The Dream run itself always completes.
   */
  DREAM_LLM_FALLBACK: 'MEM_E_DREAM_LLM_FALLBACK',

  // ---- v1.5.6 pre-ingest tagging ----------------------------------------
  /**
   * The deterministic tagger found no usable anchor for an untagged write. This is
   * a WARNING, never a failure: the episode is written with `tags: []` exactly as
   * before, and the miss is counted in `status().panel.autoTag` so an operator can
   * see how many anchorless episodes exist.
   */
  AUTO_TAG_MISS: 'MEM_E_AUTO_TAG_MISS',

  // ---- v1.5.6 pinned memory ---------------------------------------------
  /**
   * `pinned: true` requires at least one caller-provided tag. An untriggerable
   * lesson would be a dead memory: the engine refuses it before writing anything.
   */
  PINNED_TAG_REQUIRED: 'MEM_E_PINNED_TAG_REQUIRED',

  // ---- v1.5.6 feature flags / microkernel boundary ----------------------
  /**
   * The operation belongs to an optional feature this profile turned off
   * (`features.multiSpace` / `features.crossSpaceTransfer`). Fail-fast with a
   * specific code instead of pretending the space does not exist.
   */
  FEATURE_DISABLED: 'MEM_E_FEATURE_DISABLED',

  // ---- v1.5.6 L3 semantic invariant --------------------------------------
  /**
   * An L3 summary was written without a single usable tag, which would make it
   * invisible to tag-driven retrieval (dead knowledge). The explicit upsert API
   * refuses it; the offline paths (delete consolidation / trend promotion) derive a
   * deterministic fallback tag instead of failing the maintenance pass.
   */
  SEMANTIC_TAG_REQUIRED: 'MEM_E_SEMANTIC_TAG_REQUIRED',
});

export class MemoryError extends Error {
  /**
   * @param {string} code one of ErrorCodes
   * @param {string} message human readable, no secrets
   * @param {Record<string, unknown>} [details] serialisable context
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** Wrap an unknown thrown value as a MemoryError with the given fallback code. */
export function asMemoryError(err, code = ErrorCodes.IO) {
  if (err instanceof MemoryError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // A plain Error may already carry a MEM_E_* code (node http handlers, stream
  // helpers). Keep it: downgrading a CONFIG_* failure to MEM_E_IO would make the
  // HTTP layer answer {"code":"MEM_E_IO"} for a perfectly specific validation error.
  const carried = typeof err?.code === 'string' && err.code.startsWith('MEM_E_') ? err.code : code;
  const wrapped = new MemoryError(carried, message, err?.details);
  wrapped.cause = err;
  return wrapped;
}

export function invalidInput(message, details) {
  return new MemoryError(ErrorCodes.INVALID_INPUT, message, details);
}
