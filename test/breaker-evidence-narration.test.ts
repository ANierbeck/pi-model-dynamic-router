// Mutation slice 3, clusters C and D (docs/mutation-triage.md): the
// breaker-open narration's evidence phrase and full text. The existing
// seam-throw fixtures assert only `looks wedged` — the KIND_PHRASE table,
// the uniform-vs-mixed collapse, the second floor and the `/ 1000`, the
// returned template, the cloud fix hint and the whole narration sentence
// were all unasserted.
//
// Walk-level harness (test/helpers/walk-stub-ctx.ts): the candidate fails
// with a provider_error and observeProviderFailure returns true — the call
// site that narrates through the REAL narrateBreakerOpen, reading breaker
// evidence seeded into the context's cache — the same shape
// recordProviderFailure writes.

import { describe, it, expect, vi } from 'vitest';

import { walkStubWorld } from './helpers/walk-stub-ctx.ts';

vi.mock('../src/logger.ts', async (orig) => {
  const actual = await orig<typeof import('../src/logger.ts')>();
  return { ...actual, debugLog: vi.fn(), routerLog: vi.fn(), warnLog: vi.fn(), errorLog: vi.fn() };
});

const WEDGE_REF = 'wedge-provider/wedge';

/** Seed the cache the way recordProviderFailure does: evidence per model. */
function breakerCache(evidence: Record<string, { kind: string; at: number }>) {
  return { provider_breaker: { 'wedge-provider': { evidence } } };
}

async function narratedBreakerSkip(cache: unknown): Promise<string> {
  const w = walkStubWorld({
    results: { '*': { ok: false, reason: 'provider_error', detail: 'boom' } },
    ctxOverrides: {
      cache,
      // The provider_error branch narrates the breaker open when the
      // observer confirms the trip.
      observeProviderFailure: () => true,
    },
  });
  const { text } = await w.run([WEDGE_REF]);
  return text;
}

describe('the breaker-open narration names its evidence', () => {
  it.each([
    ['empty_response', 'returned empty responses'],
    ['empty_timeout', 'timed out with no response'],
    ['stall_timeout', 'stalled mid-stream'],
    ['provider_error', 'reported provider errors'],
  ])(
    'uniform %s evidence gets its kind phrase',
    async (kind, phrase) => {
      const now = Date.now();
      const text = await narratedBreakerSkip(
        breakerCache({
          m1: { kind, at: now - 5_000 },
          m2: { kind, at: now - 4_000 },
          m3: { kind, at: now - 3_000 },
        })
      );
      expect(text).toContain(
        `> [router] wedge-provider looks wedged: 3 distinct model(s) ${phrase} within 5 s.`
      );
    },
    15_000
  );

  it('mixed-kind evidence collapses to the generic "failed"', async () => {
    const now = Date.now();
    const text = await narratedBreakerSkip(
      breakerCache({
        m1: { kind: 'empty_response', at: now - 5_000 },
        m2: { kind: 'stall_timeout', at: now - 3_000 },
      })
    );
    expect(text).toContain('2 distinct model(s) failed within 5 s.');
    // … and never a single-kind phrase.
    expect(text).not.toContain('returned empty responses');
    expect(text).not.toContain('stalled mid-stream');
  }, 15_000);

  it('sub-second spans floor at "within 1 s"', async () => {
    const now = Date.now();
    const text = await narratedBreakerSkip(
      breakerCache({ m1: { kind: 'empty_response', at: now - 100 } })
    );
    expect(text).toContain('1 distinct model(s) returned empty responses within 1 s.');
  }, 15_000);

  it('carries the cooldown and the cloud fix hint (ADR-0025: no provider-specific advice)', async () => {
    const now = Date.now();
    const text = await narratedBreakerSkip(
      breakerCache({ m1: { kind: 'provider_error', at: now - 2_000 } })
    );
    expect(text).toContain('Skipping wedge-provider models for 2 min.');
    expect(text).toContain(
      'Fix: check the provider/extension (e.g. reload the session); the breaker clears on the next success.'
    );
  }, 15_000);
});
