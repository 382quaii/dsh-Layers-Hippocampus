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
  NOT_READY: 'MEM_E_NOT_READY',

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
