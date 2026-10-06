// test/provider-breaker.test.ts
// Provider circuit breaker, Phase 1 (docs/plans/2026-10-06-provider-circuit-breaker.md).
// Provider-agnostic: fixtures use generic provider ids (local-ness comes from
// PROVIDER_MAP, never from names in the mechanism) and the error texts seen in
// the 2026-10-06 router.log evidence.

import { describe, it, expect } from 'vitest';
import {
  countsAsProviderEvidence,
  recordProviderFailure,
  recordProviderSuccess,
  isProviderOpen,
  breakerState,
  openBreakers,
  BREAKER_COOLDOWN_LADDER_MS,
  WEDGE_WINDOW_MS,
} from '../src/provider-breaker.ts';
import type { Cache } from '../src/types.ts';

const MIN = 60_000;
// 'cloud-a' / 'cloud-b' are not in PROVIDER_MAP (cloud, N = 3); 'ollama' is
// the local provider there (N = 2). Locality is the only provider fact used.


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

describe('trip rule (D2)', () => {
  it('opens a cloud provider only on the third distinct model', () => {
    const cache: Cache = {};
    expect(recordProviderFailure(cache, 'cloud-a/m1', 'empty_response', undefined, 0)).toBe(false);
    expect(recordProviderFailure(cache, 'cloud-a/m2', 'empty_response', undefined, 1_000)).toBe(false);
    expect(isProviderOpen(cache, 'cloud-a', 1_001)).toBe(false);
    expect(recordProviderFailure(cache, 'cloud-a/m3', 'empty_response', undefined, 2_000)).toBe(true);
    expect(isProviderOpen(cache, 'cloud-a', 2_001)).toBe(true);
  });

  it('opens a local provider on the second distinct model', () => {
    const cache: Cache = {};
    expect(recordProviderFailure(cache, 'ollama/m1', 'empty_timeout', undefined, 0)).toBe(false);
    expect(recordProviderFailure(cache, 'ollama/m2', 'stall_timeout', undefined, 1_000)).toBe(true);
    expect(isProviderOpen(cache, 'ollama', 1_001)).toBe(true);
  });

  it('never trips on one model failing repeatedly', () => {
    const cache: Cache = {};
    for (let i = 0; i < 10; i++) recordProviderFailure(cache, 'cloud-a/m1', 'empty_response', undefined, i * 1_000);
    expect(isProviderOpen(cache, 'cloud-a', 20_000)).toBe(false);
    expect(breakerState(cache, 'cloud-a', 20_000).evidence).toEqual(['cloud-a/m1']);
  });

  it('drops evidence older than the window', () => {
    const cache: Cache = {};
    recordProviderFailure(cache, 'cloud-a/m1', 'empty_response', undefined, 0);
    recordProviderFailure(cache, 'cloud-a/m2', 'empty_response', undefined, 1_000);
    expect(recordProviderFailure(cache, 'cloud-a/m3', 'empty_response', undefined, WEDGE_WINDOW_MS + 1_001)).toBe(false);
    expect(breakerState(cache, 'cloud-a', WEDGE_WINDOW_MS + 1_002).evidence).toEqual(['cloud-a/m3']);
  });

  it('ignores failures that are not provider evidence', () => {
    const cache: Cache = {};
    const detail422 = '422 {"detail":"Extra inputs are not permitted: store"}';
    for (const m of ['m1', 'm2', 'm3', 'm4']) {
      expect(recordProviderFailure(cache, `cloud-a/${m}`, 'provider_error', detail422, 0)).toBe(false);
    }
    expect(breakerState(cache, 'cloud-a', 1).evidence).toEqual([]);
    expect(isProviderOpen(cache, 'cloud-a', 1)).toBe(false);
  });

  it('counts connection-shaped provider errors toward the trip', () => {
    const cache: Cache = {};
    recordProviderFailure(cache, 'ollama/m1', 'provider_error', 'Connection error.', 0);
    expect(recordProviderFailure(cache, 'ollama/m2', 'provider_error', 'Connection error.', 1)).toBe(true);
  });

  it('reports "newly opened" only once per open', () => {
    const cache: Cache = {};
    recordProviderFailure(cache, 'ollama/a', 'empty_timeout', undefined, 0);
    expect(recordProviderFailure(cache, 'ollama/b', 'empty_timeout', undefined, 1_000)).toBe(true);
    expect(recordProviderFailure(cache, 'ollama/c', 'empty_timeout', undefined, 2_000)).toBe(false);
  });

  it('isolates providers from each other', () => {
    const cache: Cache = {};
    recordProviderFailure(cache, 'cloud-a/m1', 'empty_response', undefined, 0);
    recordProviderFailure(cache, 'cloud-a/m2', 'empty_response', undefined, 1);
    recordProviderFailure(cache, 'cloud-b/m1', 'empty_response', undefined, 2);
    recordProviderFailure(cache, 'cloud-b/m2', 'empty_response', undefined, 3);
    expect(isProviderOpen(cache, 'cloud-a', 4)).toBe(false);
    expect(isProviderOpen(cache, 'cloud-b', 4)).toBe(false);
    recordProviderFailure(cache, 'cloud-a/m3', 'empty_response', undefined, 5);
    expect(isProviderOpen(cache, 'cloud-a', 6)).toBe(true);
    expect(isProviderOpen(cache, 'cloud-b', 6)).toBe(false);
  });

  it('is safe without a cache', () => {
    expect(isProviderOpen(undefined, 'cloud-a', 0)).toBe(false);
    expect(breakerState(undefined, 'cloud-a', 0)).toEqual({ open: false, tripCount: 0, evidence: [] });
  });
});

describe('state machine and cooldown ladder (D5)', () => {
  function trip(cache: Cache, at: number): void {
    recordProviderFailure(cache, 'ollama/a', 'empty_timeout', undefined, at);
    recordProviderFailure(cache, 'ollama/b', 'empty_timeout', undefined, at + 1);
  }

  it('ladder is 2, 5, 15 minutes', () => {
    expect(BREAKER_COOLDOWN_LADDER_MS).toEqual([2 * MIN, 5 * MIN, 15 * MIN]);
  });

  it('first trip is open for the first ladder step and reports its expiry', () => {
    const cache: Cache = {};
    trip(cache, 0);
    const first = BREAKER_COOLDOWN_LADDER_MS[0];
    expect(breakerState(cache, 'ollama', 100)).toMatchObject({ open: true, until: 1 + first, tripCount: 1 });
    expect(isProviderOpen(cache, 'ollama', first)).toBe(true);
    expect(isProviderOpen(cache, 'ollama', 1 + first)).toBe(false);
  });

  it('after expiry a failure with no success in between re-opens one ladder step up', () => {
    const cache: Cache = {};
    trip(cache, 0);
    const t1 = 1 + BREAKER_COOLDOWN_LADDER_MS[0];
    expect(recordProviderFailure(cache, 'ollama/a', 'empty_timeout', undefined, t1)).toBe(true);
    expect(breakerState(cache, 'ollama', t1)).toMatchObject({
      open: true,
      until: t1 + BREAKER_COOLDOWN_LADDER_MS[1],
      tripCount: 2,
    });
  });

  it('caps at the last ladder step', () => {
    const cache: Cache = {};
    trip(cache, 0);
    let now = 1;
    for (let i = 0; i < 5; i++) {
      now = breakerState(cache, 'ollama', now).until!;
      recordProviderFailure(cache, 'ollama/a', 'empty_timeout', undefined, now);
    }
    const s = breakerState(cache, 'ollama', now);
    expect(s.until).toBe(now + BREAKER_COOLDOWN_LADDER_MS[BREAKER_COOLDOWN_LADDER_MS.length - 1]);
    expect(s.tripCount).toBe(6);
  });

  it('a success closes the breaker, clears the evidence and resets the ladder', () => {
    const cache: Cache = {};
    trip(cache, 0);
    const t1 = 1 + BREAKER_COOLDOWN_LADDER_MS[0];
    recordProviderFailure(cache, 'ollama/a', 'empty_timeout', undefined, t1);
    recordProviderSuccess(cache, 'ollama/c');
    expect(breakerState(cache, 'ollama', t1 + 1)).toEqual({ open: false, tripCount: 0, evidence: [] });

    // The next wedge starts at the first step again, and needs fresh evidence.
    expect(recordProviderFailure(cache, 'ollama/a', 'empty_timeout', undefined, t1 + 2)).toBe(false);
    expect(recordProviderFailure(cache, 'ollama/b', 'empty_timeout', undefined, t1 + 3)).toBe(true);
    expect(breakerState(cache, 'ollama', t1 + 3)).toMatchObject({ until: t1 + 3 + BREAKER_COOLDOWN_LADDER_MS[0], tripCount: 1 });
  });

  it('a success of one provider leaves another provider open', () => {
    const cache: Cache = {};
    trip(cache, 0);
    recordProviderSuccess(cache, 'cloud-a/m1');
    expect(isProviderOpen(cache, 'ollama', 100)).toBe(true);
  });
});

describe('openBreakers (status displays)', () => {
  it('lists only currently open breakers with their expiry', () => {
    const cache: Cache = {};
    recordProviderFailure(cache, 'ollama/a', 'empty_timeout', undefined, 0);
    recordProviderFailure(cache, 'ollama/b', 'empty_timeout', undefined, 1);
    recordProviderFailure(cache, 'cloud-a/m1', 'empty_response', undefined, 2);
    expect(openBreakers(cache, 10)).toEqual([{ provider: 'ollama', until: 1 + BREAKER_COOLDOWN_LADDER_MS[0] }]);
    expect(openBreakers(cache, 1 + BREAKER_COOLDOWN_LADDER_MS[0])).toEqual([]);
    expect(openBreakers(undefined, 10)).toEqual([]);
  });
});
