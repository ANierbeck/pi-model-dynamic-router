import { describe, it, expect } from 'vitest';
import { isExpectedTransientError } from '../src/stream-driver.ts';

describe('isExpectedTransientError', () => {
  it('recognizes "no api provider registered"', () => {
    expect(isExpectedTransientError('Error: no API provider registered for mistral')).toBe(true);
  });

  it('delegates rate-limit/spend-limit detection to the shared RATE_LIMIT_PATTERNS table', () => {
    // Patterns only present in the unified table (src/detection.ts), not in
    // the old 6-pattern local list this function used to hardcode.
    expect(isExpectedTransientError('Claude five_hour rate limit hit')).toBe(true);
    expect(isExpectedTransientError('You have exceeded your quota')).toBe(true);
    expect(isExpectedTransientError('rate_limit_exceeded')).toBe(true);
    expect(isExpectedTransientError('the provider is overloaded')).toBe(true);
  });

  it('returns false for an unrelated error', () => {
    expect(isExpectedTransientError('TypeError: cannot read property of undefined')).toBe(false);
  });
});
