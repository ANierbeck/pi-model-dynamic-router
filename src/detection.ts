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
 *
 * Safe for provider/transport ERROR TEXT ONLY (error events, thrown errors,
 * failure details). NEVER apply them to the model's own text_delta output:
 * they match everyday prose ('out of', 'exceeded', 'quota', 'credits', 'rate
 * limit'), and scanning answers with them killed every response that merely
 * talked about limits (2026-09-27 afternoon incident). A real Claude limit
 * reaches the router as an error event — pi-claude-bridge prefixes its
 * errorMessage with "Claude rate limit"; its yellow warning is a piUI.notify
 * UI notification that never enters the stream.
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
const ERROR_OVERFLOW_PATTERNS: readonly string[] = [
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
/**
 * text_delta overflow detection only looks at the first N characters of an
 * answer. A provider that rejects an oversized prompt as text sends that
 * rejection as the whole, short response; a real answer that discusses
 * prompt size later on must never be killed for quoting the same phrase.
 */
export const OVERFLOW_TEXT_SCAN_MAX_CHARS = 400;

const TEXT_DELTA_OVERFLOW_PATTERNS: readonly string[] = [
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
 * When the router sees the rate-limit text in an error event's message, the
 * structured field is already gone — only
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
 * Month names, lower-cased, without a trailing dot: en-US + en-GB + de-DE in
 * short and long form (owner decision 2026-10-07: "international, best case").
 * Intl only abbreviates some months ("Sept" in en-GB, "Sept." in de-DE, but
 * "März"/"Mai"/"Juni"/"Juli" are spelled out), hence both forms per language.
 * Lookup is the only gate: an unknown name returns undefined, never a guess.
 */
const MONTH_INDEX: Record<string, number> = {
  jan: 0, january: 0, januar: 0,
  feb: 1, february: 1, februar: 1,
  mar: 2, march: 2, 'mär': 2, 'märz': 2, maerz: 2,
  apr: 3, april: 3,
  may: 4, mai: 4,
  jun: 5, june: 5, juni: 5,
  jul: 6, july: 6, juli: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, okt: 9, oktober: 9,
  nov: 10, november: 10,
  dec: 11, december: 11, dez: 11, dezember: 11,
};

// A month token: Latin-1 letters (\w is ASCII-only and would miss "ä"), the
// trailing dot optional (de-DE: "Okt.", but "Mai").
const MON = '([A-Za-zÀ-ÖØ-öø-ÿ]+)\\.?';
// A zone token: an explicit GMT/UTC offset ("GMT+2", "UTC-5", "GMT+5:30" —
// the en-US rendering outside the US) or a 2-6 letter abbreviation.
const ZONE = '((?:GMT|UTC)[+\\-\u2212]\\d{1,2}(?::\\d{2})?|[A-Za-zÀ-ÖØ-öø-ÿ]{2,6})';
const CLOCK = '(\\d{1,2}):(\\d{2})(?::(\\d{2}))?';

// de-DE / en-GB: "4. Okt. 2026, 12:37:00 MESZ", "4 Oct 2026, 12:37:00 CEST",
// "4. Oktober 2026 um 12:37:00 MESZ", "4 October 2026 at 12:37:00 CET".
const DAY_FIRST_RE = new RegExp(
  `\\b(\\d{1,2})\\.?\\s+${MON}\\s+(\\d{4})(?:,|\\s+(?:um|at))\\s+${CLOCK}\\s+${ZONE}\\b`,
  'i'
);
// en-US: "Oct 4, 2026, 12:37:00 PM GMT+2", "October 4, 2026 at 12:37:00 PM GMT+2".
// A narrow no-break space before AM/PM (newer ICU) is covered by \s.
const MONTH_FIRST_RE = new RegExp(
  `\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?:,|\\s+at)\\s+${CLOCK}\\s*(AM|PM)\\s+${ZONE}\\b`,
  'i'
);

interface DatedReset {
  day: string;
  month: number;
  year: string;
  hour: string;
  minute: string;
  second: string;
  tz: string;
}

/** Normalizes either dated shape to 24-hour wall-clock fields plus the zone token, or undefined. */
function parseDatedZonedReset(text: string): DatedReset | undefined {
  const dayFirst = text.match(DAY_FIRST_RE);
  if (dayFirst) {
    const [, day, monRaw, year, hour, minute, second, tz] = dayFirst;
    const month = MONTH_INDEX[monRaw.toLowerCase()];
    if (month === undefined) return undefined;
    return { day, month, year, hour, minute, second: second ?? '0', tz };
  }
  const monthFirst = text.match(MONTH_FIRST_RE);
  if (monthFirst) {
    const [, monRaw, day, year, hour12, minute, second, ampm, tz] = monthFirst;
    const month = MONTH_INDEX[monRaw.toLowerCase()];
    if (month === undefined) return undefined;
    // 12-hour clock: 12 AM -> 0, 12 PM -> 12, 9 PM -> 21.
    const hour = String((Number(hour12) % 12) + (ampm.toUpperCase() === 'PM' ? 12 : 0));
    return { day, month, year, hour, minute, second: second ?? '0', tz };
  }
  return undefined;
}

/**
 * Hours ahead of UTC for an explicit "GMT+2" / "UTC-5" / "GMT+5:30" token, or
 * undefined for anything else (named abbreviations are looked up separately;
 * ambiguous ones such as EST/CST/BST stay unmapped on purpose). Bounded to the
 * real-world range so a garbage offset can't produce a plausible instant.
 */
function explicitOffsetHours(tz: string): number | undefined {
  const m = tz.match(/^(?:GMT|UTC)([+\-\u2212])(\d{1,2})(?::(\d{2}))?$/i);
  if (!m) return undefined;
  const hours = Number(m[2]);
  const minutes = m[3] ? Number(m[3]) : 0;
  if (hours > 14 || minutes > 59) return undefined;
  const magnitude = hours + minutes / 60;
  return m[1] === '+' ? magnitude : -magnitude;
}

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
  // Dated, zoned reset text in the shapes toLocaleString() produces
  // (see parseDatedZonedReset below). The claude-bridge format is the de-DE
  // one; en-US / en-GB and long month names are accepted too.
  const dated = parseDatedZonedReset(text);
  if (!dated) return parseInformalZonedReset(text) ?? parseTimeOnlyReset(text);
  const { day, month, year, hour, minute, second, tz } = dated;
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
  const offsetHours = tz in TZ_OFFSET_HOURS ? TZ_OFFSET_HOURS[tz] : explicitOffsetHours(tz);
  if (offsetHours === undefined) return undefined;
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

/**
 * Third reset-time format: claude-bridge's describeRateLimitFailure emits
 * "Claude rate limit (five_hour) — resets 9:52:44 PM: <failure>" — a bare
 * time from toLocaleTimeString(), no date, no zone (live finding
 * 2026-10-03: unparsed in every locale, so a genuine five_hour rejection
 * fell back to the 60s escalating backoff and re-burned a doomed bridge
 * attempt every minute for the rest of the window).
 *
 * The bridge formats on the SAME machine the router runs on, so the
 * local timezone is the correct interpretation. Resolves to the NEXT
 * occurrence of that wall-clock time (5h windows can cross midnight).
 */
function parseTimeOnlyReset(text: string): number | undefined {
  const m = text.match(/\bresets\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!m) return undefined;
  // 12-hour clock: 12pm → 12, 9pm → 21, 12am → 0, 9am → 9; 24h passes through.
  let hour = Number(m[1]);
  const ampm = m[4]?.toLowerCase();
  if (ampm === 'pm') hour = (hour % 12) + 12;
  else if (ampm === 'am') hour = hour % 12;
  const minute = Number(m[2]);
  const second = m[3] ? Number(m[3]) : 0;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, second, 0);
  let ms = candidate.getTime();
  if (ms <= now.getTime()) ms += 24 * 60 * 60 * 1000; // already passed → next occurrence
  // Same plausibility guard as the other formats.
  if (ms <= now.getTime() || ms > now.getTime() + 7 * 24 * 60 * 60 * 1000) return undefined;
  return ms;
}

// ── OpenRouter free-tier daily cap ─────────────────────────────────────

/**
 * OpenRouter's account-wide daily cap on :free models (50/day without
 * credits, 1000/day with 10): the 429 body reads
 * "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000
 * free model requests per day".
 *
 * This limit is ACCOUNT-WIDE — one 429 covers every openrouter/*:free
 * model at once — and resets at 00:00 UTC. Live finding 2026-10-03: the
 * router treated it as an ordinary per-model 429 with the escalating 60s
 * backoff, so every later turn re-burned a doomed attempt per :free
 * candidate for the rest of the day (1475 router.log lines in one day,
 * 14 of that session's 23 recorded errors).
 */
export function isFreeTierDailyCapText(text: string): boolean {
  return text.includes('free-models-per-day');
}

/**
 * The next 00:00 UTC strictly after `now` — the documented reset of the
 * free-models-per-day cap. At exactly midnight the cap just cleared, so
 * the NEXT midnight (+24h) is returned.
 */
export function nextUtcMidnightMs(now: number = Date.now()): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return next > now ? next : next + 86_400_000;
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
 * signal on its own (empty response or timeout). provider_error is NOT
 * rate-limit-shaped by reason alone — isPaidCloudRateLimitFailure gates it
 * on the error text (HTTP 429/402 or rate-limit wording), because an
 * unrecognized provider finish_reason is usually a request-shaped client
 * error (e.g. Mistral's bare 422), not a masked rate-limit.
 */
function isRateLimitLikeReason(reason: string): boolean {
  return reason === 'empty_response'
    || reason === 'empty_timeout'
    || reason === 'stall_timeout';
}

/**
 * Patterns indicating a stream was torn down by a client-side or
 * cascade-induced abort (e.g. a parent subagent fanout crashing, an outer
 * AbortSignal firing) rather than by the provider itself. pi-ai's own
 * structured signal for this is an `error` event with `.reason === 'aborted'`
 * (handled separately, see stream-proxy.ts's consumeWithDetection userAborted
 * check — roborev job 345 HIGH). This table catches the SAME situation when
 * it instead surfaces as free-text inside a generic `error` event whose
 * `.reason` is NOT `'aborted'` — observed in practice from claude-bridge,
 * whose own AbortError gets serialized into `errorMessage` as "This operation
 * was aborted" without setting the structured `reason` field.
 *
 * Without this check, such text falls through to the providerErrorDetected
 * branch and gets classified as `reason: 'provider_error'`, which
 * isPaidCloudRateLimitFailure treated as rate-limit-shaped for any paid
 * cloud model (provider_error is text-gated since 2026-09-27, but abort
 * text must still never be counted as a provider failure at all) —
 * applying a 2-hour hard cooldown to a model that was never actually
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
const ABORT_LIKE_PATTERNS: readonly string[] = [
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
 * Was previously duplicated verbatim in the driveStream main loop (index.ts at
 * in its recordStreamFailure() escalation helper — the two copies had
 * already drifted out of sync once this session (provider_error was added to
 * one but not the other), which would have made the user-facing "treated as
 * rate-limit" message lie about which backoff tier was actually applied.
 */
export function isPaidCloudRateLimitFailure(ref: string, reason: string, errorText?: string): boolean {
  const isCloudProvider = !ref.startsWith('ollama/') && !ref.startsWith('lm-studio/');
  const isFreeModel = ref.includes(':free');
  if (!isCloudProvider || isFreeModel) return false;
  // provider_error is only rate-limit-shaped when the underlying HTTP status
  // is 429 or 402, or when the error text indicates a rate-limit. Client
  // request errors (4xx except 429/402) are not rate-limit-shaped.
  if (reason !== 'provider_error') {
    return isRateLimitLikeReason(reason);
  }
  // For provider_error, we conservatively treat it as rate-limit-shaped only
  // when the error text contains a rate-limit indicator. This prevents
  // escalating 422/400/403 client errors as rate-limits.
  // Word-boundary status match: "14293 tokens" must not read as 429, and a
  // bare "402"/"429" carries no rate-limit wording for isRateLimitText.
  if (/\b(?:429|402)\b/.test(errorText ?? '')) {
    return true;
  }
  return isRateLimitText(errorText ?? '');
}
