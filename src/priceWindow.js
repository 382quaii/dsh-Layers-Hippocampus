/**
 * DeepSeek peak/valley windows, computed LOCALLY (v1.5.6).
 *
 * No external price plugin is required: the rule is deterministic and offline.
 * Beijing time, Monday–Friday:
 *   PEAK  09:00–12:00 and 14:00–18:00
 *   LOW   everything else (lunch break, nights, weekends)
 *
 * Chinese public holidays are NOT modelled here (they move every year and need a
 * calendar); the caller may override the probe with `DSH_DREAM_PRICE=low|high`
 * or a Host price service. This module is a pure function of `now`.
 */

export const BEIJING_OFFSET_MS = 8 * 3_600_000;

/** Peak windows as Beijing-local [startHour, endHour) pairs. */
export const PEAK_WINDOWS = Object.freeze([
  Object.freeze([9, 12]),
  Object.freeze([14, 18]),
]);

/** Beijing wall-clock parts for an epoch instant. */
export function beijingParts(now = Date.now()) {
  const shifted = new Date(Number(now) + BEIJING_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(), // 0=Sunday … 6=Saturday
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** Epoch ms for a Beijing wall-clock time on the SAME Beijing day as `now`. */
function beijingEpoch(parts, hour) {
  return Date.UTC(parts.year, parts.month, parts.day, hour, 0, 0) - BEIJING_OFFSET_MS;
}

/** True in a weekday peak window; weekends and off-hours are low valley. */
export function isLowValley(now = Date.now()) {
  const parts = beijingParts(now);
  if (parts.weekday === 0 || parts.weekday === 6) return true;
  return !PEAK_WINDOWS.some(([start, end]) => parts.hour >= start && parts.hour < end);
}

/** Alias that reads naturally in a scheduling context. */
export const isPeakHour = (now = Date.now()) => !isLowValley(now);

/**
 * First instant at/after `now` that is LOW valley. Already-low returns `now`.
 * The scan is bounded to 8 days so a malformed clock can never spin forever.
 */
export function nextLowValleyStart(now = Date.now()) {
  if (isLowValley(now)) return now;
  const parts = beijingParts(now);
  // The only peak windows are 09–12 and 14–18: from inside one, the next change is
  // that window's end. Weekends can never be peak, so no date rollover is needed.
  for (const [start, end] of PEAK_WINDOWS) {
    if (parts.hour >= start && parts.hour < end) return beijingEpoch(parts, end);
  }
  return now; // unreachable: isLowValley() already proved we are not in a peak window
}

/** One object for the panel/route: window, reason, next change. */
export function windowInfo(now = Date.now()) {
  const parts = beijingParts(now);
  const low = isLowValley(now);
  const nextStart = low ? null : nextLowValleyStart(now);
  return {
    low,
    reason: low ? 'low-valley' : 'peak-hour',
    beijingHour: parts.hour,
    beijingMinute: parts.minute,
    weekday: parts.weekday,
    nextLowAt: nextStart,
  };
}
