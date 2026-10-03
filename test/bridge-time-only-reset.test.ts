/**
 * claude-bridge narrates a REAL rate-limit reset as
 *   "Claude rate limit (five_hour) — resets 9:52:44 PM: <failure>"
 * — a time-only stamp from toLocaleTimeString(), no date, no zone.
 *
 * Live finding 2026-10-03: parseResetAtMs could not read that format in ANY
 * locale, so on a genuine five_hour rejection the router fell back to the
 * 60s escalating backoff and re-burned a doomed bridge attempt every minute
 * for the rest of the window.
 *
 * The bridge formats with toLocaleTimeString() on the SAME machine the
 * router runs on, so the local timezone is the correct interpretation.
 */
import { describe, it, expect } from 'vitest';
import { parseResetAtMs } from '../src/detection.ts';

const within = (ms: number | undefined, fromMs: number, minH: number, maxH: number) =>
  ms !== undefined && ms > fromMs + minH * 3600_000 && ms < fromMs + maxH * 3600_000;

describe('parseResetAtMs: claude-bridge time-only reset', () => {
  it('parses the en-US 12-hour format the bridge emits on an English-locale host', () => {
    const now = Date.now();
    const reset = new Date(now + 2 * 3600_000);
    const text = `Claude rate limit (five_hour) — resets ${reset.toLocaleTimeString('en-US')}: Claude Code returned an error`;
    expect(within(parseResetAtMs(text), now, 1.9, 2.1)).toBe(true);
  });

  it('parses the de-DE 24-hour format ("resets 21:52:44")', () => {
    const now = Date.now();
    const reset = new Date(now + 2 * 3600_000);
    const text = `Claude rate limit (five_hour) — resets ${reset.toLocaleTimeString('de-DE')}: Fehler`;
    expect(within(parseResetAtMs(text), now, 1.9, 2.1)).toBe(true);
  });

  it('resolves a time that already passed today to its NEXT occurrence (5h windows cross midnight)', () => {
    const now = Date.now();
    // Ten minutes AGO today → next occurrence is ~23h50m out.
    const passed = new Date(now - 10 * 60_000);
    const text = `Claude rate limit (five_hour) — resets ${passed.toLocaleTimeString('en-US')}: err`;
    const ms = parseResetAtMs(text);
    expect(ms).toBeDefined();
    expect(ms! - now).toBeGreaterThan(23 * 3600_000);
    expect(ms! - now).toBeLessThan(24.2 * 3600_000);
  });

  it('does not misread ordinary text as a reset time', () => {
    expect(parseResetAtMs('error 429: resets backoff 3.5')).toBeUndefined();
    expect(parseResetAtMs('no time here at all')).toBeUndefined();
  });

  it('keeps the richer date+zone format working (mdy path, not time-only)', () => {
    // The documented German format with a TZ abbreviation goes through the
    // mdy path; 2099 is > 7 days out → rejected by its plausibility guard.
    expect(parseResetAtMs('resets 30. Aug. 2099, 17:00:00 MESZ')).toBeUndefined();
    // Zone-agnostic construction: the mdy parser interprets the wall-clock
    // digits in the STATED zone (MESZ = UTC+2), so render the target instant
    // in UTC+2 — via getUTC* on target+2h, never via local getters (CI runs
    // on UTC; a local-getters version passed on a CEST machine and failed
    // on the runner, 2026-10-03).
    const now = Date.now();
    const meszWall = new Date(now + 3 * 3600_000 + 2 * 3600_000);
    const day = meszWall.getUTCDate();
    const mon = meszWall.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const year = meszWall.getUTCFullYear();
    const hm = `${meszWall.getUTCHours()}:${String(meszWall.getUTCMinutes()).padStart(2, '0')}:00`;
    const text2 = `resets ${day}. ${mon}. ${year}, ${hm} MESZ`;
    expect(within(parseResetAtMs(text2), now, 2.9, 3.1)).toBe(true);
  });
});
