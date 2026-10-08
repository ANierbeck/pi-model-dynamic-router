// test/reset-time-international.test.ts
// Multi-locale reset-time parsing (TODO.md, owner decision 2026-10-07:
// "international, best case"). parseResetAtMs historically understood only
// the de-DE shape claude-bridge renders ("4. Okt. 2026, 12:37:00 MESZ").
// Provider messages and foreign-locale machines produce the en-US shape
// ("Oct 4, 2026, 12:37:00 PM GMT+2"), the en-GB shape ("4 Oct 2026,
// 12:37:00 CEST") and long month names. Inputs are generated through the real
// Intl output (never hand-typed), so a typo in the test cannot match a typo
// in the implementation.

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { parseResetAtMs } from '../src/detection.ts';

let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  // Deterministic zone names (MEZ/MESZ, CET/CEST, GMT+1/GMT+2) on any CI machine.
  process.env.TZ = 'Europe/Berlin';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});
afterEach(() => {
  vi.useRealTimers();
});

const base = {
  day: 'numeric' as const,
  year: 'numeric' as const,
  hour: 'numeric' as const,
  minute: '2-digit' as const,
  second: '2-digit' as const,
  timeZoneName: 'short' as const,
};

for (const locale of ['en-US', 'en-GB', 'de-DE'] as const) {
  for (const month of ['short', 'long'] as const) {
    describe(`${locale} ${month} month names`, () => {
      for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
        it(`parses month index ${monthIndex} back to the exact instant`, () => {
          const now = new Date(2026, monthIndex, 1, 12, 0, 0);
          vi.useFakeTimers();
          vi.setSystemTime(now);
          const target = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000 + 37 * 60 * 1000);
          const formatted = target.toLocaleString(locale, { ...base, month });
          const text = `Warning: [rate-limit] Claude five_hour rate limit hit — resets ${formatted}`;
          expect(parseResetAtMs(text), formatted).toBe(target.getTime());
        });
      }
    });
  }
}

describe('explicit GMT/UTC offsets in the zone token', () => {
  const at = (iso: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T08:00:00Z'));
    return Date.parse(iso);
  };

  it('GMT+2 (the en-US rendering outside the US) resolves to the real instant', () => {
    const expected = at('2026-10-05T10:37:00Z'); // 12:37 at +2
    expect(parseResetAtMs('resets Oct 5, 2026, 12:37:00 PM GMT+2')).toBe(expected);
  });

  it('GMT-5 and half-hour offsets resolve too (explicit offsets are unambiguous)', () => {
    const west = at('2026-10-05T17:37:00Z'); // 12:37 at -5
    expect(parseResetAtMs('resets Oct 5, 2026, 12:37:00 PM GMT-5')).toBe(west);
    const india = Date.parse('2026-10-05T07:07:00Z'); // 12:37 at +5:30
    expect(parseResetAtMs('resets 5 Oct 2026, 12:37:00 GMT+5:30')).toBe(india);
  });

  it('12 AM / 12 PM follow the 12-hour clock', () => {
    const midnight = at('2026-10-04T22:05:00Z'); // 12:05 AM Oct 5 at +2
    expect(parseResetAtMs('resets Oct 5, 2026, 12:05:00 AM GMT+2')).toBe(midnight);
  });
});

describe('safety pins (unchanged contract — green at birth, deliberately)', () => {
  it('an ambiguous US abbreviation (EST/PDT/CST/BST) stays unparsed — fallback is the standard backoff', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T08:00:00Z'));
    expect(parseResetAtMs('resets Oct 5, 2026, 12:37:00 PM EST')).toBeUndefined();
    expect(parseResetAtMs('resets 5 Oct 2026, 12:37:00 PDT')).toBeUndefined();
  });

  it('an unknown month name is rejected, not guessed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T08:00:00Z'));
    expect(parseResetAtMs('resets 5 Octember 2026, 12:37:00 CEST')).toBeUndefined();
  });

  it('a reset more than 7 days out is still rejected in the new shapes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T08:00:00Z'));
    expect(parseResetAtMs('resets Oct 20, 2026, 12:37:00 PM GMT+2')).toBeUndefined();
  });

  it.each(['GMT+199', 'GMT+5:3', 'UTC-123', 'GMT+2:300'])(
    'a malformed offset token (%s) is rejected, never read as plain GMT (review Minor 1)',
    (zone) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-04T08:00:00Z'));
      expect(parseResetAtMs(`resets Oct 5, 2026, 12:37:00 PM ${zone}`)).toBeUndefined();
    }
  );

  it('plain GMT / UTC / MESZ still resolve (the lookahead must not eat the named zones)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T08:00:00Z'));
    expect(parseResetAtMs('resets Oct 5, 2026, 12:37:00 PM GMT')).toBe(Date.parse('2026-10-05T12:37:00Z'));
    expect(parseResetAtMs('resets 5. Okt. 2026, 12:37:00 MESZ')).toBe(Date.parse('2026-10-05T10:37:00Z'));
  });

  it('a nonsensical offset is rejected', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T08:00:00Z'));
    expect(parseResetAtMs('resets Oct 5, 2026, 12:37:00 PM GMT+99')).toBeUndefined();
  });
});
