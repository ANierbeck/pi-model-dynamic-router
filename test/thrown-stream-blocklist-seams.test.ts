// test/thrown-stream-blocklist-seams.test.ts
//
// Kills the last open slice-2 real-gap mutants (docs/mutation-triage.md,
// "Slice 2 test round" leftovers; the IDs there predate PR #115, so the
// regions are located by content, not line):
//
//  1. Cluster H — a stream that THROWS (not an error EVENT): the catch path
//     of the candidate loop. The existing breaker fixtures use empty/error-
//     event streams, so every assertion of the catch path (narration,
//     session_errors, blocklist evidence, breaker narration, aggregate
//     failure lines) was untested.
//  2. The blocklist observer gates — the main-loop
//     `if (reason === 'provider_error' && detail) observeFailure(...)` and
//     its post-wait-retry twin. A mutant over-feeds the learned blocklist
//     with rate-limit/empty evidence (spurious Tier-2 blocks) or starves it
//     of the bare-422 evidence it exists for.
//  3. The silent-skip path — tryStream returns null WITHOUT a skipReason:
//     the walk must record the failure with detail undefined and must not
//     print "undefined" as a failure line.
//
// Red evidence (2026-11-08): each guard was hand-mutated in
// src/stream-orchestrator.ts and the matching test went red — see the
// ledger in docs/mutation-triage.md.

import { describe, it, expect, vi } from 'vitest';
import { walkStubWorld } from './helpers/walk-stub-ctx.js';

vi.mock('../src/logger.ts', () => ({
  routerLog: vi.fn(),
  warnLog: vi.fn(),
  errorLog: vi.fn(),
  debugLog: vi.fn(),
  debugLogOnce: vi.fn(),
  forgetDebugOnce: vi.fn(),
  setProjectLogDir: vi.fn(),
}));

/** Text of the walk's terminal error event (the aggregate failure message). */
function errorText(events: unknown[]): string {
  return events
    .filter((e: any) => e.type === 'error')
    .map((e: any) =>
      Array.isArray(e.error?.content)
        ? e.error.content.map((c: any) => String(c?.text ?? '')).join('')
        : ''
    )
    .join('');
}

describe('a stream OPEN that throws lands in the .catch seam', () => {
  it('narrates, records the session error, and lists the failure', async () => {
    const world = walkStubWorld({
      ctxOverrides: {
        tryStream: vi.fn(async () => {
          throw new Error('Connection error 502');
        }),
      },
    });
    const { text, events } = await world.run(['prov/a', 'prov/b']);

    // The open-failure narration names the ref and the raw cause.
    expect(text).toContain(
      '> [router] Trying next model (prov/a unavailable: Connection error 502)'
    );

    // The session_errors seam: a thrown open is a provider_error with the
    // raw message (review round 2, Finding 1).
    expect(world.ctx.recordStreamFailure).toHaveBeenCalledTimes(2);
    expect(world.ctx.recordStreamFailure).toHaveBeenCalledWith(
      'prov/a',
      'provider_error',
      undefined,
      'Connection error 502'
    );

    // The aggregate failure event lists every candidate's line.
    const err = errorText(events);
    expect(err).toContain('All 2 candidate(s) failed');
    expect(err).toContain('• prov/a: Connection error 502');
  });

  it('sanitizes credentials out of the open-failure narration', async () => {
    const world = walkStubWorld({
      ctxOverrides: {
        tryStream: vi.fn(async () => {
          throw new Error('Connection error sk-live-abc123456');
        }),
      },
    });
    const { text } = await world.run(['prov/a']);
    // Same bar as the consume-catch narration: provider text must not carry
    // credentials into the transcript.
    expect(text).toContain('Connection error [redacted]');
    expect(text).not.toContain('sk-live-abc123456');
  });

  it('narrates the breaker once the thrown opens trip the provider evidence', async () => {
    let calls = 0;
    const world = walkStubWorld({
      ctxOverrides: {
        tryStream: vi.fn(async () => {
          throw new Error('Connection error 502');
        }),
        observeProviderFailure: vi.fn(() => ++calls === 2),
      },
    });
    const { text } = await world.run(['prov/a', 'prov/b']);
    expect(text).toContain('prov looks wedged');
    expect(text).toContain('Skipping prov models for 2 min');
  });
});

describe('a stream CONSUME that rejects lands in the loop catch (cluster H)', () => {
  it('narrates, records session errors and blocklist evidence, and lists every failure', async () => {
    const world = walkStubWorld({
      ctxOverrides: {
        consumeWithDetection: vi.fn(async () => {
          throw new Error('Connection error 502');
        }),
      },
    });
    const { text, events } = await world.run(['prov/a', 'prov/b']);

    // Narration per failed candidate, with the next-attemptable suffix.
    expect(text).toContain('> [router] prov/a — error: Connection error 502, trying prov/b …');
    expect(text).toContain('> [router] prov/b — error: Connection error 502');

    // The session_errors seam (review round 2, Finding 1).
    expect(world.ctx.recordStreamFailure).toHaveBeenCalledTimes(2);
    expect(world.ctx.recordStreamFailure).toHaveBeenCalledWith(
      'prov/a',
      'provider_error',
      undefined,
      'Connection error 502'
    );

    // Blocklist evidence: only the consume catch feeds observeFailure with
    // the raw text (the open seam deliberately does not).
    expect(world.ctx.observeFailure).toHaveBeenCalledTimes(2);
    expect(world.ctx.observeFailure).toHaveBeenCalledWith('prov/a', 'Connection error 502');

    // The aggregate failure event lists every candidate's line.
    const err = errorText(events);
    expect(err).toContain('All 2 candidate(s) failed');
    expect(err).toContain('• prov/a: Connection error 502');
    expect(err).toContain('• prov/b: Connection error 502');
  });

  it('sanitizes credentials out of the consume-catch narration', async () => {
    const world = walkStubWorld({
      ctxOverrides: {
        consumeWithDetection: vi.fn(async () => {
          throw new Error('Connection error sk-live-abc123456');
        }),
      },
    });
    const { text } = await world.run(['prov/a']);
    expect(text).toContain('> [router] prov/a — error: Connection error [redacted]');
    expect(text).not.toContain('sk-live-abc123456');
  });

  it('narrates the breaker once the consume throws trip the provider evidence', async () => {
    let calls = 0;
    const world = walkStubWorld({
      ctxOverrides: {
        consumeWithDetection: vi.fn(async () => {
          throw new Error('Connection error 502');
        }),
        observeProviderFailure: vi.fn(() => ++calls === 3),
      },
    });
    const { text } = await world.run(['prov/a', 'prov/b', 'prov/c']);
    expect(text).toContain('prov looks wedged');
    expect(text).toContain('Skipping prov models for 2 min');
  });
});

describe('the blocklist observer gates feed ONLY provider_error-with-detail', () => {
  it('main loop: rate limits and empty responses carry no blocklist evidence', async () => {
    const world = walkStubWorld({
      results: {
        'prov/rl': { ok: false, reason: 'rate_limit_exceeded', detail: '429: Too many requests' },
        'prov/empty': { ok: false, reason: 'empty_response' },
      },
    });
    await world.run(['prov/rl', 'prov/empty']);
    // Pristine: neither result is provider_error-with-detail, so the learned
    // blocklist sees NOTHING. (A `&& -> ||` or `-> true` mutant feeds the
    // 429 body / calls with undefined detail.)
    expect(world.ctx.observeFailure).not.toHaveBeenCalled();
  });

  it('post-wait retry: a bare 422 feeds the blocklist, a repeated rate limit does not', async () => {
    const calls: Record<string, number> = {};
    const world = walkStubWorld({
      ctxOverrides: {
        getRateLimitWaitMaxMs: () => 60_000,
        consumeWithDetection: vi.fn(
          async (_s: any, _p: any, _e: number, _st: number, ref: string) => {
            calls[ref] = (calls[ref] ?? 0) + 1;
            if (calls[ref] === 1)
              return {
                ok: false,
                reason: 'rate_limit_exceeded',
                detail: '429: rate limited, resets soon',
                resetAtMs: Date.now() + 50,
              };
            // The post-wait retry answers with a bare 422 — the exact case
            // the seam exists for (2026-09-27 wave).
            return { ok: false, reason: 'provider_error', detail: '422 status code (no body)' };
          }
        ),
      },
    });
    const { text } = await world.run(['prov/w']);

    // Exactly one blocklist observation, with the 422 text — not the 429.
    expect(world.ctx.observeFailure).toHaveBeenCalledTimes(1);
    expect(world.ctx.observeFailure).toHaveBeenCalledWith('prov/w', '422 status code (no body)');
    expect(text).toContain('still failing after waiting (provider_error)');
  }, 30_000);

  it('post-wait retry that rate limits again feeds no blocklist evidence', async () => {
    const calls: Record<string, number> = {};
    const world = walkStubWorld({
      ctxOverrides: {
        getRateLimitWaitMaxMs: () => 60_000,
        consumeWithDetection: vi.fn(
          async (_s: any, _p: any, _e: number, _st: number, ref: string) => {
            calls[ref] = (calls[ref] ?? 0) + 1;
            return {
              ok: false,
              reason: 'rate_limit_exceeded',
              detail: '429: rate limited again',
              resetAtMs: Date.now() + 50,
            };
          }
        ),
      },
    });
    await world.run(['prov/w2']);
    expect(world.ctx.observeFailure).not.toHaveBeenCalled();
  }, 30_000);
});

describe('a silent skip (tryStream null, no skipReason) records without "undefined"', () => {
  it('records the failure with detail undefined and no undefined failure line', async () => {
    const world = walkStubWorld({
      ctxOverrides: {
        skipReasons: new Map<string, string>(),
        tryStream: vi.fn(async (ref: string) => {
          // prov/b explains itself; prov/a is silent (no skipReason).
          if (ref === 'prov/b') world.ctx.skipReasons.set('prov/b', 'no API key');
          return null;
        }),
      },
    });
    const { events } = await world.run(['prov/a', 'prov/b']);

    // The explained skip names its reason; the silent one must not print
    // "undefined" as the failure line.
    const err = errorText(events);
    expect(err).toContain('• prov/b: no API key');
    expect(err).not.toContain('undefined');

    // Both are recorded exactly once — the silent one with detail undefined
    // (the explained one with its reason as the detail).
    expect(world.ctx.recordStreamFailure).toHaveBeenCalledWith(
      'prov/a',
      'provider_error',
      undefined,
      undefined
    );
    expect(world.ctx.recordStreamFailure).toHaveBeenCalledWith(
      'prov/b',
      'provider_error',
      undefined,
      'no API key'
    );
  });
});
