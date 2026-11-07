// Mutation slice 3, cluster A (docs/mutation-triage.md): the outer-signal
// chaining in openCandidateAttempt. Pi hands groupStream an AbortSignal (a
// user abort, a sub-call budget); every candidate attempt gets its OWN
// controller whose signal must follow the outer one — otherwise the provider
// query keeps running after the caller cancelled (the 2026-09-27 token-burn
// incident), and an ALREADY-aborted caller must not burn even one attempt.
//
// Walk-level harness (test/helpers/walk-stub-ctx.ts): the real driveStream
// walk; the outer signal is the `options` argument of driveStream. The one
// candidate hangs 400 ms in consumeWithDetection — the window in which the
// test aborts the outer signal and inspects the attempt's.

import { describe, it, expect, vi } from 'vitest';

import { walkStubWorld } from './helpers/walk-stub-ctx.ts';

vi.mock('../src/logger.ts', async (orig) => {
  const actual = await orig<typeof import('../src/logger.ts')>();
  return { ...actual, debugLog: vi.fn(), routerLog: vi.fn(), warnLog: vi.fn(), errorLog: vi.fn() };
});

/** One candidate whose consume hangs 400 ms, then fails as a stall. */
function hangingCandidateWorld() {
  return walkStubWorld({
    consume: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ ok: false, reason: 'stall_timeout' }), 400)
      ),
  });
}

describe("openCandidateAttempt chains the caller's AbortSignal", () => {
  it("a mid-stream outer abort reaches the candidate's attempt signal", async () => {
    const w = hangingCandidateWorld();
    const outer = new AbortController();
    const walkDone = w.run(['a/one'], { signal: outer.signal });

    await new Promise((r) => setTimeout(r, 100));
    expect(w.attempts).toHaveLength(1);
    expect(w.attempts[0].signal!.aborted).toBe(false);

    outer.abort(new Error('user cancelled'));
    await new Promise((r) => setTimeout(r, 50));

    // The chain listener fired: the provider-side query is cancelled with
    // the caller's reason, not left running in the background.
    expect(w.attempts[0].signal!.aborted).toBe(true);
    await walkDone;
  }, 15_000);

  it('an ALREADY-aborted caller aborts the attempt at creation', async () => {
    const w = hangingCandidateWorld();
    const walkDone = w.run(['a/one'], { signal: AbortSignal.abort(new Error('too late')) });

    // Inspect INSIDE the consume window: the walk's own finally would
    // abandon the attempt later anyway, so only the state at open time
    // proves the caller's abort reached the attempt at creation.
    await new Promise((r) => setTimeout(r, 100));
    expect(w.attempts).toHaveLength(1);
    expect(w.attempts[0].signal!.aborted).toBe(true);
    await walkDone;
  }, 15_000);

  it('a live outer signal leaves the attempt signal live', async () => {
    const w = hangingCandidateWorld();
    const outer = new AbortController();
    const walkDone = w.run(['a/one'], { signal: outer.signal });

    await new Promise((r) => setTimeout(r, 150));
    expect(w.attempts).toHaveLength(1);
    // No spurious abort: a healthy cascade must not cancel its candidates.
    expect(w.attempts[0].signal!.aborted).toBe(false);
    await walkDone;
  }, 15_000);
});
