// test/rate-limit-body-log.test.ts
// The 429 body is the only evidence that tells a daily account cap from a
// shared upstream pool. Since 2026-10-07 the router logged only the
// narration, so the cause of a failure could not be read back from the log.
// formatRateLimitBodyForLog() is the single formatter for that log line:
// one line, bounded, and free of credentials.

import { describe, it, expect } from 'vitest';
import { formatRateLimitBodyForLog } from '../src/detection.ts';

describe('formatRateLimitBodyForLog', () => {
  it('keeps the provider message, flattened to one line', () => {
    const body = '402: {\n  "message": "Rate limit exceeded: free-models-per-day. Add 10 credits",\n  "code": 429\n}';
    const out = formatRateLimitBodyForLog(body);
    expect(out).not.toContain('\n');
    expect(out).toContain('free-models-per-day');
  });

  it('bounds the length so one 429 cannot flood the log', () => {
    const out = formatRateLimitBodyForLog('x'.repeat(5000));
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith('…')).toBe(true);
  });

  it('redacts API keys and bearer tokens', () => {
    const out = formatRateLimitBodyForLog(
      'Authorization: Bearer sk-or-v1-abcdef1234567890 failed, key sk-proj-ZZZZ9999xxxx',
    );
    expect(out).not.toContain('abcdef1234567890');
    expect(out).not.toContain('ZZZZ9999xxxx');
    expect(out).toContain('[redacted]');
  });

  it('returns an empty string for a missing body', () => {
    expect(formatRateLimitBodyForLog(undefined)).toBe('');
    expect(formatRateLimitBodyForLog('')).toBe('');
  });
});
