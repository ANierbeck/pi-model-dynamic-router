// test/provider-breaker.test.ts
// Provider circuit breaker, Phase 1 (docs/plans/2026-10-06-provider-circuit-breaker.md).
// Provider-agnostic: fixtures use generic provider ids (local-ness comes from
// PROVIDER_MAP, never from names in the mechanism) and the error texts seen in
// the 2026-10-06 router.log evidence.

import { describe, it, expect } from 'vitest';
import { countsAsProviderEvidence } from '../src/provider-breaker.ts';

describe('countsAsProviderEvidence (D1)', () => {
  it('counts empty responses and both timeout kinds without needing a detail', () => {
    expect(countsAsProviderEvidence('empty_response')).toBe(true);
    expect(countsAsProviderEvidence('empty_timeout')).toBe(true);
    expect(countsAsProviderEvidence('stall_timeout')).toBe(true);
  });

  it.each([
    'Connection error.',
    'connect ECONNREFUSED 127.0.0.1:11434',
    'read ECONNRESET',
    'TypeError: fetch failed',
    'write EPIPE',
    'connect ETIMEDOUT 10.0.0.1:443',
    '500 Internal Server Error',
    '502 Bad Gateway',
    '503 Service Unavailable',
    '504 Gateway Timeout',
    'upstream service unavailable',
  ])('counts a connection/5xx-shaped provider_error: %s', (detail) => {
    expect(countsAsProviderEvidence('provider_error', detail)).toBe(true);
  });

  it.each([
    // False-positive class from the log evidence: per-model request/shape errors.
    '400 {"message":"Reasoning prompt mode is not enabled for this model"}',
    '422 {"detail":"Extra inputs are not permitted: store"}',
    '404 model not found',
    'status code (no body)',
    // Rate limits / quota: the rate-limit path owns them (D1).
    '429 Too Many Requests',
    'You exceeded your current quota',
    'rate limit reached, retry in 20s',
    '503 overloaded, rate limit',
    // Abort / overflow.
    'The operation was aborted',
    'prompt is too long: 250000 tokens > 200000 maximum',
    // Account-wide auth: out of scope (Q3), per-model backoff only.
    '401 Unauthorized',
    '402 Payment Required',
    // Generic wrapper without any connection/5xx evidence.
    'Provider returned error',
    '',
  ])('does not count: %s', (detail) => {
    expect(countsAsProviderEvidence('provider_error', detail)).toBe(false);
  });

  it('does not count a provider_error without a detail', () => {
    expect(countsAsProviderEvidence('provider_error')).toBe(false);
  });

  it('lets a 4xx status win over incidental 5xx-shaped wording', () => {
    expect(countsAsProviderEvidence('provider_error', '400 request id 503 upstream service unavailable')).toBe(false);
  });
});
