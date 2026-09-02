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
 * A second, unrelated format is also recognized: Claude Code CLI's own
 * spend-limit message carries no date, just an informal wall-clock time and
 * an IANA zone name — "your session limit resets 7pm (Europe/Berlin)". Since
 * there's no date, this is interpreted as "the next occurrence of that
 * wall-clock time in that zone" (today if still ahead of now, else
 * tomorrow), converted via Intl instead of the TZ-abbreviation lookup table
 * above (a real IANA identifier needs no guessing).
 *
 * The parsed value is validated: must be a finite future timestamp (within
 * 7 days, matching Anthropic's seven_day/seven_day_opus rate-limit windows —
 * see the inline comment below) to guard against clock-skew / parsed garbage.
 * Returns undefined if parsing fails — the caller falls back to the standard
 * escalating backoff.
 */

/**
 * Converts a wall-clock date/time in a given IANA zone to a Unix-ms UTC
 * instant, without a timezone library. Standard single-iteration technique:
 * treat the target fields as if they were UTC (a "guess"), format that guess
 * back through the target zone to see what wall-clock time it displays there,
 * and the difference between the guess and that round-trip IS the zone's
 * offset at that instant — subtracting it from the guess recovers the real
 * UTC instant. Accurate except within the same hour as a DST transition,
 * which is an acceptable approximation for a rate-limit cooldown estimate.
 */
function zonedTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcGuess)).map((p) => [p.type, p.value]));
  // Intl's 24h formatter can emit "24" for midnight instead of "00".
  const guessedHour = parts.hour === '24' ? 0 : Number(parts.hour);
  const guessedLocalAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    guessedHour,
    Number(parts.minute),
    Number(parts.second)
  );
  return utcGuess + (utcGuess - guessedLocalAsUtc);
}

export function parseResetAtMs(text: string): number | undefined {
  // DD. Mon YYYY, HH:MM:SS TZ (German locale, produced by toLocaleString
  // with the standard date/time options in claude-bridge's formatResetTimestamp)
  // claude-bridge formats dates as "DD. Mon YYYY, HH:MM:SS TZ" (e.g. "30. Aug. 2026, 17:00:00 MESZ").
  // Note: there are TWO literal dots in the pattern ("DD." and "Mon.") — both must be escaped
  // as \\d (dot) not . (wildcard)!
  //
  // The month token is NOT always followed by a dot, and is not always ASCII:
  // de-DE's Intl short-month format only abbreviates SOME months ("Jan.",
  // "Feb.", "Aug.", "Sept.", "Okt.", "Nov.", "Dez.") while spelling others out
  // in full with no trailing dot ("März", "Mai", "Juni", "Juli") — verified
  // against Node's actual de-DE Intl output. `\w` never matches accented
  // letters like ä (the `u` regex flag doesn't change that; \w stays
  // ASCII-only), and a required trailing `\.` would reject "März"/"Mai"/
  // "Juni"/"Juli" outright — so the previous pattern silently failed to parse
  // 4 of 12 months and (via the MONTH table below being English-only) treated
  // several more as unparsed too. Fixed: an explicit Latin-1 letter class for
  // the month token, and the trailing dot is now optional.
  const mdy = text.match(
    /\b(\d{1,2})\.\s+([A-Za-zÀ-ÖØ-öø-ÿ]+)\.?\s+(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})\s+([A-Za-zÀ-ÖØ-öø-ÿ]{2,6})\b/
  );
  if (!mdy) return parseInformalZonedReset(text);
  // Groups: [fullMatch, day, month, year, hour, minute, second, tz]
  const [, day, monRaw, year, hour, minute, second, tz] = mdy;
  // Both English abbreviations (in case an English-locale Pi install produces
  // them) and German ones (de-DE Intl short-month output, the format
  // claude-bridge actually uses today — see comment above).
  const MONTH: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Mär: 2, März: 2, Apr: 3, May: 4, Mai: 4,
    Jun: 5, Juni: 5, Jul: 6, Juli: 6, Aug: 7, Sep: 8, Sept: 8,
    Oct: 9, Okt: 9, Nov: 10, Dec: 11, Dez: 11,
  };
  const month = MONTH[monRaw];
  if (month === undefined) return undefined;
  // Maps the TZ abbreviation captured above to hours-ahead-of-UTC (roborev
  // job 351 MEDIUM/354 LOW×2). The claude-bridge text carries local
  // wall-clock digits (Anthropic's resetsAt reformatted via toLocaleString in
  // the user's timezone) — without correcting for the offset, treating those
  // digits as literal UTC makes the parsed instant *later* than the real
  // reset by the zone's full offset (e.g. 2h for MESZ/CEST), which on a 5h
  // five_hour window is a ~40% overestimate, not a rounding error.
  //
  // Deliberately limited to the ONLY verified/documented use case (German
  // locale: MEZ/MESZ, CET/CEST as the English label for the same zones) —
  // an earlier version of this table speculatively added common US
  // abbreviations (EST/CST/MST/PST, BST) "in case an English-locale Pi
  // install produces them", which introduced two real problems: (1) several
  // of those abbreviations are genuinely ambiguous (CST = US Central Standard
  // Time OR China Standard Time; BST = British Summer Time OR Bangladesh
  // Standard Time) with no way to disambiguate from the text alone, and (2)
  // for negative-offset zones specifically, guessing wrong is NOT safe the
  // way the old "unmapped → offset 0" fallback was for positive-offset
  // zones — it makes the parsed cooldown expire BEFORE the real reset
  // (premature retry), the exact failure mode this feature exists to
  // prevent. Rather than maintain an ever-growing, never-fully-verified
  // list, an unmapped abbreviation now returns undefined (see below) so the
  // caller falls back to the standard escalating backoff — safe in all
  // directions, just less precise, exactly like the pre-existing behavior
  // before this reset-time feature existed.
  const TZ_OFFSET_HOURS: Record<string, number> = {
    UTC: 0, GMT: 0,
    MEZ: 1, MESZ: 2, // Germany (CET/CEST), German abbreviation — the documented case
    CET: 1, CEST: 2, // same zones, English abbreviation
  };
  if (!(tz in TZ_OFFSET_HOURS)) return undefined;
  const offsetHours = TZ_OFFSET_HOURS[tz];
  try {
    // Date.UTC(...) on the raw local digits produces a timestamp numerically
    // equal to "local wall-clock time interpreted as UTC", which is exactly
    // offsetHours ahead of the real UTC instant (local = UTC + offset).
    // Subtracting the offset recovers the real instant for mapped zones.
    const ms = Date.UTC(
      Number(year),
      month,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ) - offsetHours * 60 * 60 * 1000;
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

/**
 * Second reset-time format, tried when the claude-bridge date+TZ-abbreviation
 * pattern above doesn't match. Claude Code CLI's own spend-limit message has
 * no date, just an informal 12-hour time and a real IANA zone identifier:
 * "your session limit resets 7pm (Europe/Berlin)" or "7:30pm (America/New_York)".
 * Since there's no date, this resolves to the NEXT occurrence of that
 * wall-clock time in that zone — today if it hasn't happened yet, tomorrow
 * otherwise.
 */
function parseInformalZonedReset(text: string): number | undefined {
  const zoned = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([A-Za-z]+\/[A-Za-z_]+)\)/i);
  if (!zoned) return undefined;
  const [, hourRaw, minuteRaw, ampm, timeZone] = zoned;
  let hour = Number(hourRaw) % 12;
  if (ampm.toLowerCase() === 'pm') hour += 12;
  const minute = minuteRaw ? Number(minuteRaw) : 0;
  try {
    const now = Date.now();
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const todayParts = Object.fromEntries(dtf.formatToParts(new Date(now)).map((p) => [p.type, p.value]));
    const year = Number(todayParts.year);
    const month = Number(todayParts.month);
    const day = Number(todayParts.day);
    let ms = zonedTimeToUtcMs(year, month, day, hour, minute, timeZone);
    if (ms <= now) {
      // Already passed today in that zone — next occurrence is tomorrow.
      // Date.UTC (inside zonedTimeToUtcMs) normalizes day = actualDaysInMonth+1
      // into the next month automatically, so no manual month/year rollover
      // is needed here.
      ms = zonedTimeToUtcMs(year, month, day + 1, hour, minute, timeZone);
    }
    if (!Number.isFinite(ms)) return undefined;
    // Same guard as the date+TZ-abbreviation format above, though a
    // next-occurrence time-of-day can never exceed 24h out in practice.
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

/**
 * True if a failure `reason` looks rate-limit-shaped rather than a definitive
 * signal on its own (empty response, timeout, or an unrecognized provider
 * finish_reason) — the caller still must combine this with provider/pricing
 * tier (see isPaidCloudRateLimitFailure below) before treating it as a real
 * rate limit.
 */
export function isRateLimitLikeReason(reason: string): boolean {
  return reason === 'empty_response'
    || reason === 'empty_timeout'
    || reason === 'stall_timeout'
    || reason === 'provider_error';
}

/**
 * Patterns indicating a stream was torn down by a client-side or
 * cascade-induced abort (e.g. a parent subagent fanout crashing, an outer
 * AbortSignal firing) rather than by the provider itself. pi-ai's own
 * structured signal for this is an `error` event with `.reason === 'aborted'`
 * (handled separately, see index.ts's consumeWithDetection userAborted
 * check — roborev job 345 HIGH). This table catches the SAME situation when
 * it instead surfaces as free-text inside a generic `error` event whose
 * `.reason` is NOT `'aborted'` — observed in practice from claude-bridge,
 * whose own AbortError gets serialized into `errorMessage` as "This operation
 * was aborted" without setting the structured `reason` field.
 *
 * Without this check, such text falls through to the providerErrorDetected
 * branch and gets classified as `reason: 'provider_error'`, which
 * isPaidCloudRateLimitFailure treats as rate-limit-shaped for any paid cloud
 * model — applying a 2-hour hard cooldown to a model that was never actually
 * rate-limited, just caught in the blast radius of an unrelated crash. This
 * was the root cause of a live incident: a subagent fanout crashed Ollama,
 * the crash cascade aborted an in-flight pi-claude/claude-sonnet-5 call, and
 * the router locked Sonnet out of `tactical`/`strategic` for 2 hours (F10,
 * 2026-09-02 architecture review).
 *
 * Deliberately narrow and evidence-based (matching this file's existing
 * pattern-table philosophy) rather than a broad "aborted" substring match —
 * a genuine provider-side rejection could plausibly use similar wording for
 * an unrelated reason, and understating this list only costs a soft backoff
 * instead of a 2-hour hard cooldown (a far cheaper false negative than the
 * reverse).
 */
export const ABORT_LIKE_PATTERNS: readonly string[] = [
  'operation was aborted',
  'the operation was aborted',
  'aborterror',
];

/** True if text matches a client-side/cascade-abort pattern (see above). */
export function isAbortLikeText(text: string): boolean {
  const lower = text.toLowerCase();
  return ABORT_LIKE_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Single source of truth (roborev job 348 LOW) for "should this failure on
 * `ref` be escalated to a hard rate-limit cooldown + key rotation, instead of
 * the short soft-backoff ladder": a PAID cloud model (not local, not
 * `:free`-suffixed) hitting a rate-limit-shaped reason. Local/free models get
 * only the soft backoff, since those failures are commonly just transient
 * overload rather than a masked 429/auth error.
 *
 * Was previously duplicated verbatim in index.ts's driveStream main loop and
 * in its recordStreamFailure() escalation helper — the two copies had
 * already drifted out of sync once this session (provider_error was added to
 * one but not the other), which would have made the user-facing "treated as
 * rate-limit" message lie about which backoff tier was actually applied.
 */
export function isPaidCloudRateLimitFailure(ref: string, reason: string): boolean {
  const isCloudProvider = !ref.startsWith('ollama/') && !ref.startsWith('lm-studio/');
  const isFreeModel = ref.includes(':free');
  return isCloudProvider && isRateLimitLikeReason(reason) && !isFreeModel;
}
