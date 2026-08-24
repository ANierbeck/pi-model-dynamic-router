// test/detection.test.ts
// Tests for the unified provider-error text detection (src/detection.ts).
//
// Pins the SINGLE source of truth for rate-limit + overflow pattern matching.
// Previously isRateLimitText (consumeWithDetection, 15 patterns) and
// isRateLimitError (driveStream, 7 patterns) diverged — a rate-limit could
// trigger a fallback in one path but not the other. Both now go through
// RATE_LIMIT_PATTERNS here.

import { describe, it, expect } from 'vitest';
import {
  isRateLimitText,
  isOverflowErrorText,
  isOverflowDeltaText,
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
