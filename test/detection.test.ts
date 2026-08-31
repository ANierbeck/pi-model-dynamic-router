// test/detection.test.ts
// Tests for the unified provider-error text detection (src/detection.ts).
//
// Pins the SINGLE source of truth for rate-limit + overflow pattern matching.
// Previously isRateLimitText (consumeWithDetection, 15 patterns) and
// isRateLimitError (driveStream, 7 patterns) diverged — a rate-limit could
// trigger a fallback in one path but not the other. Both now go through
// RATE_LIMIT_PATTERNS here.

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import {
  isRateLimitText,
  isOverflowErrorText,
  isOverflowDeltaText,
  parseResetAtMs,
  isPaidCloudRateLimitFailure,
  RATE_LIMIT_PATTERNS,
} from '../src/detection.ts';

describe('isRateLimitText — unified rate-limit detection', () => {
  it('matches the patterns the old isRateLimitError knew', () => {
    // These came from the old 7-pattern isRateLimitError; must still match.
    expect(isRateLimitText('Error: rate limit exceeded')).toBe(true);
    expect(isRateLimitText('You are out of usage credits')).toBe(true);
    expect(isRateLimitText('spend limit reached')).toBe(true);
    expect(isRateLimitText('quota exhausted')).toBe(true);
    expect(isRateLimitText('limit hit')).toBe(true);
    expect(isRateLimitText('rate_limit_exceeded')).toBe(true);
    expect(isRateLimitText('server overloaded')).toBe(true);
  });

  it('matches the patterns only the old isRateLimitText knew', () => {
    // These were ONLY in the 15-pattern isRateLimitText; isRateLimitError
    // missed them. After unification, all paths recognize them.
    expect(isRateLimitText('Warning: five_hour rate limit hit')).toBe(true);
    expect(isRateLimitText('Claude Code returned an error result')).toBe(true);
    expect(isRateLimitText('monthly spend limit')).toBe(true);
    expect(isRateLimitText('rate_limit error')).toBe(true);
  });

  it('does not match legitimate prose', () => {
    expect(isRateLimitText('Here is the code you requested.')).toBe(false);
    expect(isRateLimitText('The model produced a good response.')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isRateLimitText('RATE LIMIT EXCEEDED')).toBe(true);
    expect(isRateLimitText('Quota Exceeded')).toBe(true);
  });

  it('RATE_LIMIT_PATTERNS is the union of both old sets (no divergence)', () => {
    // The unification must not drop any pattern from either old set.
    expect(RATE_LIMIT_PATTERNS).toContain('rate_limit_exceeded'); // was only in isRateLimitError
    expect(RATE_LIMIT_PATTERNS).toContain('five_hour'); // was only in isRateLimitText
    expect(RATE_LIMIT_PATTERNS).toContain('claude code returned an error'); // isRateLimitText only
    expect(RATE_LIMIT_PATTERNS).toContain('overloaded'); // both
  });
});

describe('isOverflowErrorText — broad patterns for error events', () => {
  it('matches provider overflow rejections', () => {
    expect(isOverflowErrorText('prompt is too long')).toBe(true);
    expect(isOverflowErrorText('maximum context length exceeded')).toBe(true);
    expect(isOverflowErrorText('context window is full')).toBe(true);
  });

  it('is intentionally broad (safe for error events only)', () => {
    // "context window" is broad — fine for error events, NOT for text_delta.
    expect(isOverflowErrorText('context window')).toBe(true);
  });
});

describe('isOverflowDeltaText — narrow patterns for text_delta content', () => {
  it('matches provider overflow rejections', () => {
    expect(isOverflowDeltaText('prompt is too long')).toBe(true);
    expect(isOverflowDeltaText('too large for model with 128k context')).toBe(true);
    expect(isOverflowDeltaText('exceeds the maximum context length')).toBe(true);
  });

  it('does NOT match broad phrases that legitimate prose might contain', () => {
    // roborev job 203: assistant prose about the router legitimately says
    // "context window" — the narrow text_delta set must not match it.
    expect(isOverflowDeltaText('the context window is 128k tokens')).toBe(false);
    expect(isOverflowDeltaText('maximum context length is a constraint')).toBe(false);
  });
});

describe('parseResetAtMs — extracts reset timestamps from rate-limit messages', () => {
  it('parses the German-locale format from claude-bridge formatResetTimestamp', () => {
    // This is the exact text produced by claude-bridge's formatResetTimestamp():
    // `toLocaleString(void 0, { day:"numeric", month:"short", year:"numeric",
    //   hour:"numeric", minute:"2-digit", second:"2-digit", timeZoneName:"short" })`
    // Date is computed relative to now (not hardcoded) — a fixed date eventually
    // becomes "today" or "the past" as the calendar catches up, which made this
    // test flip from pass to fail once the suite ran on/after 2026-08-30.
    const in3days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const day = in3days.getDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mon = months[in3days.getMonth()];
    const year = in3days.getFullYear();
    const text = `Warning: [rate-limit] Claude five_hour rate limit hit — resets ${day}. ${mon}. ${year}, 17:00:00 MESZ`;
    const ms = parseResetAtMs(text);
    expect(ms).toBeGreaterThan(Date.now());
    expect(ms).toBeLessThan(Date.now() + 7 * 24 * 60 * 60 * 1000);
  });

  it('parses the format in isolation', () => {
    // A bare "resets DD. Mon YYYY, HH:MM:SS TZ" should parse.
    // Use a date within 7 days (the sanity cap).
    const in3days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const day = in3days.getDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mon = months[in3days.getMonth()];
    const year = in3days.getFullYear();
    const text = `resets ${day}. ${mon}. ${year}, 12:00:00 EST`;
    const ms = parseResetAtMs(text);
    expect(ms).toBeGreaterThan(Date.now());
    expect(ms).toBeLessThan(Date.now() + 7 * 24 * 60 * 60 * 1000);
  });

  it('returns undefined for text with no reset-time pattern', () => {
    expect(parseResetAtMs('rate limit exceeded')).toBeUndefined();
    expect(parseResetAtMs('Warning: [rate-limit] Claude unknown rate limit')).toBeUndefined();
    expect(parseResetAtMs('')).toBeUndefined();
  });

  it('returns undefined for past timestamps', () => {
    // 30 Aug 2020 is definitely in the past
    const ms = parseResetAtMs('resets 30. Aug. 2020, 17:00:00 MESZ');
    expect(ms).toBeUndefined();
  });

  it('returns undefined for timestamps more than 7 days in the future', () => {
    // A suspiciously far future date should be rejected as garbage
    const ms = parseResetAtMs('resets 30. Aug. 2099, 17:00:00 MESZ');
    expect(ms).toBeUndefined();
  });

  it('handles single-digit day and hour', () => {
    // Use a date within 7 days (the sanity cap) with single-digit day and hour.
    const in3days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const day = in3days.getDate(); // single-digit possible
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mon = months[in3days.getMonth()];
    const year = in3days.getFullYear();
    const hour = in3days.getHours(); // single-digit possible
    const text = `resets ${day}. ${mon}. ${year}, ${hour}:05:00 EST`;
    const ms = parseResetAtMs(text);
    expect(ms).toBeGreaterThan(Date.now());
  });

  describe('German month names (roborev job 339 MEDIUM)', () => {
    // node's de-DE Intl short-month format only abbreviates SOME months with a
    // trailing dot ("Jan.", "Feb.", "Aug.", "Sept.", "Okt.", "Nov.", "Dez.")
    // and spells others out in full with NO trailing dot ("März", "Mai", "Juni",
    // "Juli") — this is the exact format claude-bridge's formatResetTimestamp()
    // produces on a German-locale machine. Before the fix, \w (ASCII-only,
    // never matches ä) combined with a mandatory trailing dot meant März/Mai/
    // Juni/Juli failed to match the regex at all, and the MONTH table (English
    // abbreviations only) meant Sept/Okt/Dez failed the lookup even when the
    // regex did match — silently losing the reset-time-aware cooldown for
    // roughly 7 of 12 months. Uses fake timers so every month can be tested
    // deterministically regardless of when the suite runs, and generates the
    // input text via the real `toLocaleString('de-DE', ...)` call (the same
    // one claude-bridge uses) rather than hand-typing month strings, so a typo
    // in the test can't accidentally match a typo in the implementation.
    //
    // Forces TZ=Europe/Berlin (restored after) so `toLocaleString`'s
    // timeZoneName output is deterministically MEZ/MESZ regardless of the
    // CI machine's actual system timezone — without this, a CI runner set to
    // e.g. UTC would render "UTC" instead, and one set to an unmapped zone
    // (e.g. America/New_York) would render a "GMT-4"-style offset that
    // wouldn't even match the TZ_OFFSET_HOURS lookup (roborev job 351 MEDIUM).
    let originalTz: string | undefined;
    beforeAll(() => {
      originalTz = process.env.TZ;
      process.env.TZ = 'Europe/Berlin';
    });
    afterAll(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const LOCALE_OPTS = {
      day: 'numeric' as const,
      month: 'short' as const,
      year: 'numeric' as const,
      hour: 'numeric' as const,
      minute: '2-digit' as const,
      second: '2-digit' as const,
      timeZoneName: 'short' as const,
    };

    // One month index per calendar quarter that needs the fix: März/Mai/Juni/
    // Juli (no trailing dot, non-ASCII for März) and Sept/Okt/Dez (German
    // abbreviation differs from the English one already in the table).
    const monthsNeedingFix = [2, 4, 5, 6, 8, 9, 11];

    for (const monthIndex of monthsNeedingFix) {
      it(`parses German locale text for month index ${monthIndex}`, () => {
        const now = new Date(2026, monthIndex, 1, 12, 0, 0);
        vi.useFakeTimers();
        vi.setSystemTime(now);

        const target = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
        const formatted = target.toLocaleString('de-DE', LOCALE_OPTS);
        const text = `Warning: [rate-limit] Claude five_hour rate limit hit — resets ${formatted}`;

        // With TZ forced to Europe/Berlin and the offset-aware fix
        // (TZ_OFFSET_HOURS in parseResetAtMs), the parsed value must recover
        // the real UTC instant — not the naive "local digits as UTC" value,
        // which would be off by the MEZ/MESZ offset (1-2h).
        const ms = parseResetAtMs(text);
        expect(ms).toBe(target.getTime());
      });
    }
  });
});

describe('isPaidCloudRateLimitFailure — single source of truth for the hard-cooldown gate (roborev job 348 LOW)', () => {
  it('treats a paid cloud model with a rate-limit-shaped reason as hard-cooldown-worthy', () => {
    expect(isPaidCloudRateLimitFailure('openrouter/some-paid-model', 'empty_response')).toBe(true);
    expect(isPaidCloudRateLimitFailure('openrouter/some-paid-model', 'empty_timeout')).toBe(true);
    expect(isPaidCloudRateLimitFailure('openrouter/some-paid-model', 'stall_timeout')).toBe(true);
    expect(isPaidCloudRateLimitFailure('openrouter/some-paid-model', 'provider_error')).toBe(true);
  });

  it('does NOT flag a free-suffixed model, even on a rate-limit-shaped reason', () => {
    expect(isPaidCloudRateLimitFailure('openrouter/some-model:free', 'provider_error')).toBe(false);
    expect(isPaidCloudRateLimitFailure('openrouter/some-model:free', 'empty_response')).toBe(false);
  });

  it('does NOT flag a local provider (ollama/lm-studio), even on a rate-limit-shaped reason', () => {
    expect(isPaidCloudRateLimitFailure('ollama/some-model', 'provider_error')).toBe(false);
    expect(isPaidCloudRateLimitFailure('lm-studio/some-model', 'empty_timeout')).toBe(false);
  });

  it('does NOT flag a paid cloud model for a non-rate-limit-shaped reason', () => {
    expect(isPaidCloudRateLimitFailure('openrouter/some-paid-model', 'context_overflow')).toBe(false);
    expect(isPaidCloudRateLimitFailure('openrouter/some-paid-model', 'repetition_loop')).toBe(false);
    expect(isPaidCloudRateLimitFailure('openrouter/some-paid-model', 'aborted')).toBe(false);
  });
});
