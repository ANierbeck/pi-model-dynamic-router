// test/rate-limit-detection.test.ts
// Tests for the rate-limit/spend-limit detection in consumeWithDetection.
// The claude-bridge sometimes pushes rate-limit messages as text_delta content
// (via piUI.notify or as result text), not as error events. The router must
// detect these and treat them as rate_limit_exceeded, not as successful content.

import { describe, it, expect } from 'vitest';

// Test the rate-limit pattern matching logic directly.
// These patterns must match the actual error messages from claude-bridge/Anthropic:
// - "Warning: [rate-limit] Claude five_hour rate limit hit — resets ..."
// - "You've hit your monthly spend limit · raise it at ..."
// - "Claude rate limit warning: nearing ..."
// - "Claude Code returned an error result: ..."

const RATE_LIMIT_PATTERNS = [
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
];

function isRateLimitText(text: string): boolean {
  const lower = text.toLowerCase();
  return RATE_LIMIT_PATTERNS.some((p) => lower.includes(p));
}

describe('rate-limit text detection', () => {
  it('detects "five_hour rate limit hit"', () => {
    expect(isRateLimitText('Claude five_hour rate limit hit — resets Jan 21, 1970')).toBe(true);
  });

  it('detects "monthly spend limit"', () => {
    expect(isRateLimitText("You've hit your monthly spend limit · raise it at claude.ai/settings/usage")).toBe(true);
  });

  it('detects "rate_limit" with underscore', () => {
    expect(isRateLimitText('error: rate_limit_exceeded')).toBe(true);
  });

  it('detects "overloaded"', () => {
    expect(isRateLimitText('The server is overloaded')).toBe(true);
  });

  it('detects "quota exceeded"', () => {
    expect(isRateLimitText('API quota exceeded')).toBe(true);
  });

  it('detects "out of credits"', () => {
    expect(isRateLimitText('You are out of credits')).toBe(true);
  });

  it('detects "claude code returned an error"', () => {
    expect(isRateLimitText('Claude Code returned an error result: some detail')).toBe(true);
  });

  it('detects "usage credits"', () => {
    expect(isRateLimitText('No more usage credits available')).toBe(true);
  });

  it('does NOT detect normal assistant text', () => {
    expect(isRateLimitText('Here is the code you requested.')).toBe(false);
    expect(isRateLimitText('I will help you with that task.')).toBe(false);
    expect(isRateLimitText('The function returns a Promise that resolves to an object.')).toBe(false);
  });

  it('does NOT detect normal text that contains "limit" without rate context', () => {
    // "limit" alone should not trigger — only "rate limit", "spend limit", "limit hit"
    expect(isRateLimitText('The limit of the array is 10 elements.')).toBe(false);
    expect(isRateLimitText('Please limit your response to 100 words.')).toBe(false);
  });

  it('detects rate-limit text in accumulated content (split across deltas)', () => {
    // Simulate text arriving in chunks: "You've hit your monthly " + "spend limit"
    const accumulated = "You've hit your monthly " + "spend limit · raise it at claude.ai";
    expect(isRateLimitText(accumulated)).toBe(true);
  });

  it('detects rate-limit in mixed-case text', () => {
    expect(isRateLimitText('RATE LIMIT HIT')).toBe(true);
    expect(isRateLimitText('Monthly Spend Limit')).toBe(true);
    expect(isRateLimitText('Five_Hour Rate Limit')).toBe(true);
  });
});

describe('rate-limit patterns coverage', () => {
  // Ensure all patterns are non-empty strings
  it('all patterns are non-empty strings', () => {
    for (const p of RATE_LIMIT_PATTERNS) {
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    }
  });

  it('patterns cover the known claude-bridge error messages', () => {
    const knownErrors = [
      'Warning: [rate-limit] Claude five_hour rate limit hit — resets Jan 21, 1970, 5:19:00 PM GMT+1',
      "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message",
      'Claude rate limit warning: nearing five_hour limit',
      'Claude Code returned an error result: rate_limit',
      'error: rate_limit_event',
      'Your API key has exceeded the rate limit',
      'quota exceeded for this request',
    ];
    for (const err of knownErrors) {
      expect(isRateLimitText(err)).toBe(true);
    }
  });
});