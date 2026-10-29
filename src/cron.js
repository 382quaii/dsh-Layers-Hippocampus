/**
 * 5-field cron support (minute granularity, server-local time).
 *
 * Supported syntax per field: `*`, `n`, `a-b`, `* /n`, `a-b/n`, and comma lists of
 * those. Day-of-month and day-of-week follow Vixie cron: when BOTH are restricted a
 * date matches if EITHER matches; when one is `*` only the other constrains.
 *
 * Why this exists instead of a dependency: the scheduler must be testable with an
 * injected clock and exact `nextRun` arithmetic, and a 120-line parser with tests is
 * cheaper to audit than an opaque dependency. Invalid syntax is a hard error
 * (`MEM_E_CONFIG_INVALID_CRON`) — never silently treated as "*".
 */

import { MemoryError, ErrorCodes } from './errors.js';

export const CRON_FIELDS = Object.freeze([
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 7 },
]);

const MINUTE_MS = 60_000;
/** 366 days of minutes: the widest gap a valid expression can still bridge. */
const MAX_SCAN_MINUTES = 366 * 24 * 60;

function cronError(message, details) {
  return new MemoryError(ErrorCodes.CONFIG_INVALID_CRON, message, details);
}

/** Expand one field into the set of accepted integers. Throws on any bad token. */
function expandField(token, field, expression) {
  const { name, min, max } = field;
  const out = new Set();
  const add = (value) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw cronError(`cron ${name} value ${value} is outside ${min}-${max}`, { expression, field: name, value });
    }
    out.add(value);
  };

  for (const part of String(token).split(',')) {
    if (!part) throw cronError(`cron ${name} field contains an empty list item`, { expression, field: name });
    const [rangePart, stepPart, ...rest] = part.split('/');
    if (rest.length > 0) {
      throw cronError(`cron ${name} field has more than one "/"`, { expression, field: name, part });
    }
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) throw cronError(`cron ${name} step is not a number`, { expression, field: name, step: stepPart });
      step = Number(stepPart);
      if (step < 1) throw cronError(`cron ${name} step must be >= 1`, { expression, field: name, step: stepPart });
    }

    if (rangePart === '*') {
      for (let value = min; value <= max; value += step) add(value);
      continue;
    }
    const rangeMatch = /^(\d+)-(\d+)$/.exec(rangePart);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start > end) throw cronError(`cron ${name} range start exceeds end`, { expression, field: name, part });
      for (let value = start; value <= end; value += step) add(value);
      continue;
    }
    if (!/^\d+$/.test(rangePart)) throw cronError(`cron ${name} field is not valid syntax`, { expression, field: name, part });
    if (stepPart !== undefined) {
      throw cronError(`cron ${name} step requires a range or "*"`, { expression, field: name, part });
    }
    add(Number(rangePart));
  }
  return out;
}

/**
 * Parse an expression.
 * @param {string} expression e.g. "0 * /6 * * *" (without the spaces)
 * @returns {{expression: string, minute: Set<number>, hour: Set<number>,
 *            dayOfMonth: Set<number>, month: Set<number>, dayOfWeek: Set<number>,
 *            domRestricted: boolean, dowRestricted: boolean}}
 */
export function parseCron(expression) {
  if (typeof expression !== 'string') {
    throw cronError('cron expression must be a string', { expression });
  }
  const trimmed = expression.trim().replace(/\s+/gu, ' ');
  if (!trimmed) throw cronError('cron expression is empty', { expression });
  const parts = trimmed.split(' ');
  if (parts.length !== 5) {
    throw cronError('cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week)', {
      expression,
      fields: parts.length,
      hint: parts.length === 6 ? 'seconds are not supported; drop the leading seconds field' : undefined,
    });
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, index) =>
    expandField(part, CRON_FIELDS[index], expression),
  );
  // 7 is Sunday in some dialects; normalise it to 0.
  if (dayOfWeek.has(7)) {
    dayOfWeek.add(0);
    dayOfWeek.delete(7);
  }
  return {
    expression: trimmed,
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

/** Does the moment `ms` (a Date) match the parsed expression? */
export function matchesCron(spec, ms) {
  const date = ms instanceof Date ? ms : new Date(ms);
  if (!Number.isFinite(date.getTime())) return false;
  if (!spec.minute.has(date.getMinutes())) return false;
  if (!spec.hour.has(date.getHours())) return false;
  if (!spec.month.has(date.getMonth() + 1)) return false;
  const domHit = spec.dayOfMonth.has(date.getDate());
  const dowHit = spec.dayOfWeek.has(date.getDay());
  // Vixie semantics: if both are restricted, either matching is enough.
  if (spec.domRestricted && spec.dowRestricted) return domHit || dowHit;
  if (spec.domRestricted) return domHit;
  if (spec.dowRestricted) return dowHit;
  return true;
}

/**
 * First matching minute strictly after `fromMs` (server-local clock).
 * Returns null when the expression can never fire (e.g. "0 0 30 2 *").
 */
export function nextRun(spec, fromMs) {
  const from = Number(fromMs);
  if (!Number.isFinite(from)) throw cronError('nextRun requires a finite epoch ms', { from: fromMs });
  let t = Math.floor(from / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let i = 0; i < MAX_SCAN_MINUTES; i += 1) {
    if (matchesCron(spec, t)) return t;
    t += MINUTE_MS;
  }
  return null;
}

/** Parse + prove it can fire. Used by config validation (fail-fast at boot). */
export function validateCron(expression) {
  const spec = parseCron(expression);
  const probe = Date.UTC(2026, 0, 1, 0, 0, 0);
  if (nextRun(spec, probe) === null) {
    throw cronError('cron expression never fires', { expression });
  }
  return spec;
}
