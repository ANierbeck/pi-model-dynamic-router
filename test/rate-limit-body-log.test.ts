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
    // Sourcery PR #74: the bearer fixture used to start with sk-, so the
    // sk- rule alone satisfied the assertions and the Bearer rule was
    // never verified (vacuous). The bearer token now has a non-sk prefix.
    const out = formatRateLimitBodyForLog(
      'Authorization: Bearer ghp_16C7eXfUllClarity947abcde failed, key sk-proj-ZZZZ9999xxxx',
    );
    expect(out).not.toContain('ghp_16C7eXfUllClarity947abcde');
    expect(out).not.toContain('ZZZZ9999xxxx');
    expect(out).toContain('[redacted]');
  });

  it('redacts credential values echoed in key/value pairs (Sourcery PR #74)', () => {
    const out = formatRateLimitBodyForLog(
      '{"error":{"message":"Usage limit","api_key":"pk_live_9f8e7d6c5b4a3210","auth_token":"tok_Ax9yB8z7C6w5"}}',
    );
    expect(out).not.toContain('pk_live_9f8e7d6c5b4a3210');
    expect(out).not.toContain('tok_Ax9yB8z7C6w5');
    expect(out).toContain('[redacted]');
  });

  it('strips terminal control sequences a provider body could carry (Sourcery PR #74)', () => {
    const out = formatRateLimitBodyForLog('\u001b[31mRate limit\u001b[0m exceeded\u0007');
    expect(out).not.toContain('\u001b');
    expect(out).toBe('Rate limit exceeded');
  });

  it('keeps ordinary words that merely contain key/token (no false positives)', () => {
    const out = formatRateLimitBodyForLog(
      '{"error":{"type":"upstream_error","note":"tokens per minute: keyboard tokenizers"}}',
    );
    expect(out).toContain('tokens per minute');
    expect(out).toContain('keyboard');
  });

  it('returns an empty string for a missing body', () => {
    expect(formatRateLimitBodyForLog(undefined)).toBe('');
    expect(formatRateLimitBodyForLog('')).toBe('');
  });
});
