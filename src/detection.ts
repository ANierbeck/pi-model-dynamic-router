// src/detection.ts
// Single source of truth for provider-error text detection.
//
// PREVIOUSLY there were TWO rate-limit scanners with DIVERGENT pattern sets:
//   - isRateLimitText  (index.ts consumeWithDetection, 15 patterns)
//   - isRateLimitError (index.ts driveStream cascade, 7 patterns)
// They disagreed: isRateLimitError missed 'five_hour'/'claude code returned
// an error'; isRateLimitText missed 'rate_limit_exceeded'. A rate-limit could
// trigger a fallback in one code path but not the other. Both now go through
// the unified RATE_LIMIT_PATTERNS table here.
//
// Overflow detection (error-event vs text_delta) also lived inline in
// index.ts; moved here so the pattern tables are co-located and testable.

/**
 * Patterns that indicate a rate-limit / spend-limit / subscription error.
 * These can arrive as error events OR as text_delta content (claude-bridge
 * pushes rate-limit warnings as text via piUI.notify, and some error results
 * with non-success subtype fall through without an error event).
 *
 * Union of the two previous pattern sets — no divergence between code paths.
 */
export const RATE_LIMIT_PATTERNS: readonly string[] = [
  'rate limit',
  'spend limit',
  'usage credits',
  'out of',
  'limit hit',
  'claude code returned an error',
  'monthly spend',
  'five_hour',
  'five hour',
  'quota',
  'credits',
  'exceeded',
  'overloaded',
  'rate_limit',
  'rate_limit_exceeded',
];

/**
 * Patterns that indicate the prompt exceeded the model's context window.
 * Mirrors @earendil-works/pi-ai/utils/overflow OVERFLOW_PATTERNS.
 *
 * Safe for `error` EVENTS ONLY: an error event comes from provider/transport
 * infrastructure, never from the model's own generated prose, so a generic
 * phrase like "context window" can't false-positive there.
 */
export const ERROR_OVERFLOW_PATTERNS: readonly string[] = [
  'prompt is too long',
  'maximum context length',
  'context length is',
  'too large for model with',
  'maximum context',
  'context window',
  'token count exceeds',
  'exceeds the context',
];

/**
 * Narrower patterns for TEXT_DELTA content. This router's own domain is
 * context windows/compaction, so a legitimate assistant response can
 * plausibly contain broad phrases like "context window" while discussing
 * the router itself (roborev job 203 High finding). Only match phrasings a
 * provider actually uses to reject an oversized prompt, which ordinary
 * assistant prose won't reproduce.
 */
export const TEXT_DELTA_OVERFLOW_PATTERNS: readonly string[] = [
  'too large for model with',
  'prompt is too long',
  'exceeds the maximum context length',
  'exceeds the context window',
];

/**
 * Parses a reset-at timestamp from a rate-limit error message.
 *
 * claude-bridge emits the reset time in two forms:
 *   - As a structured field `info.resetsAt` (ISO 8601 string or Unix ms)
 *     that gets forwarded via the extension event bus.
 *   - As a formatted string in `piUI.notify(...)` text:
 *     "… resets DD. Mon YYYY, HH:MM:SS TZ …"
 *
 * When the router sees the rate-limit text in the stream (from `piUI.notify`
 * via an error/text_delta event), the structured field is already gone — only
 * the formatted string remains. This function parses it back to a Unix-ms
 * value using a German locale pattern (the format produced by `toLocaleString`
 * with `timeZoneName: "short"`).
 *
 * The parsed value is validated: must be a finite future timestamp (within
 * 48h) to guard against clock-skew / parsed garbage. Returns undefined if
 * parsing fails — the caller falls back to the standard escalating backoff.
 */
export function parseResetAtMs(text: string): number | undefined {
  // DD. Mon YYYY, HH:MM:SS TZ (German locale, produced by toLocaleString
  // with the standard date/time options in claude-bridge's formatResetTimestamp)
  // claude-bridge formats dates as "DD. Mon YYYY, HH:MM:SS TZ" (e.g. "30. Aug. 2026, 17:00:00 MESZ").
  // Note: there are TWO literal dots in the pattern ("DD." and "Mon.") — both must be escaped
  // as \\d (dot) not . (wildcard)!
  const mdy = text.match(/\b(\d{1,2})\.\s+(\w+)\.\s+(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})\s+([A-Z]{2,5})\b/);
  if (!mdy) return undefined;
  // Groups: [fullMatch, day, month, year, hour, minute, second, tz]
  const [, day, monRaw, year, hour, minute, second] = mdy;
  const MONTH: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const month = MONTH[monRaw];
  if (month === undefined) return undefined;
  try {
    // We use UTC. The TZ abbreviation (e.g. MESZ) indicates the *display*
    // offset, not the actual offset to UTC. The error text comes from
    // claude-bridge which forwards Anthropic's resetsAt (already a UTC
    // moment), then formats it in the *user's local timezone*. We don't
    // know the user's exact timezone from the text alone — we only know
    // the local clock reading. Conservatively assume the timestamp is
    // already in UTC (close enough; the backoff is the same order of
    // magnitude either way, and the user can tell from the warning text
    // that the time is in their local TZ).
    const ms = Date.UTC(
      Number(year),
      month,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );
    if (!Number.isFinite(ms)) return undefined;
    const now = Date.now();
    // Sanity-check the parsed timestamp: must be a future time within 7 days
    // to guard against clock-skew / parsed garbage. Anthropic's rate-limit
    // windows are five_hour (5h), seven_day (7d), and seven_day_opus (~7d);
    // the 7d ceiling covers them all. Anything past 7 days is almost certainly
    // a parsing error and would be worse than the standard escalating backoff.
    if (ms <= now || ms > now + 7 * 24 * 60 * 60 * 1000) return undefined;
    return ms;
  } catch {
    return undefined;
  }
}

/** True if text matches any rate-limit / spend-limit pattern. */
export function isRateLimitText(text: string): boolean {
  const lower = text.toLowerCase();
  return RATE_LIMIT_PATTERNS.some((p) => lower.includes(p));
}

/** True if text matches an overflow pattern suitable for error EVENTS (broad). */
export function isOverflowErrorText(text: string): boolean {
  const lower = text.toLowerCase();
  return ERROR_OVERFLOW_PATTERNS.some((p) => lower.includes(p));
}

/** True if text matches an overflow pattern suitable for text_delta (narrow). */
export function isOverflowDeltaText(text: string): boolean {
  const lower = text.toLowerCase();
  return TEXT_DELTA_OVERFLOW_PATTERNS.some((p) => lower.includes(p));
}
