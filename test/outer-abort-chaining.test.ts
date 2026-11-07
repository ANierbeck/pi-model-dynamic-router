// Mutation slice 3, cluster A (docs/mutation-triage.md): the outer-signal
// chaining in openCandidateAttempt. Pi hands groupStream an AbortSignal (a
// user abort, a sub-call budget); every candidate attempt gets its OWN
// controller whose signal must follow the outer one — otherwise the provider
// query keeps running after the caller cancelled (the 2026-09-27 token-burn
// incident), and an ALREADY-aborted caller must not burn even one attempt.
//
// Walk-level harness (test/helpers/walk-stub-ctx.ts): the real driveStream
// walk; the outer signal is the `options` argument of driveStream. The one
// candidate hangs in consumeWithDetection until the test releases it — no
// timer, so the attempt's state can only be changed by the abort chain (a
// timed consume would let the walk's own finally abandon the attempt and
// make the assertions vacuously pass under event-loop delay).

import { describe, it, expect, vi } from 'vitest';

import { walkStubWorld } from './helpers/walk-stub-ctx.ts';

vi.mock('../src/logger.ts', async (orig) => {
  const actual = await orig<typeof import('../src/logger.ts')>();
  return { ...actual, debugLog: vi.fn(), routerLog: vi.fn(), warnLog: vi.fn(), errorLog: vi.fn() };
});

/** One candidate whose consume hangs until the test releases it. */
function hangingCandidateWorld() {
  let release!: () => void;
  const hang = new Promise<unknown>((resolve) => {
    release = () => resolve({ ok: false, reason: 'stall_timeout' });
  });
  const w = walkStubWorld({ consume: () => hang });
  return { w, release };
}

/** Waits until the walk has opened its (single) candidate attempt. */
async function firstAttempt(w: { attempts: { ref: string }[] }): Promise<void> {
  await vi.waitFor(() => expect(w.attempts).toHaveLength(1));
}

describe("openCandidateAttempt chains the caller's AbortSignal", () => {
  it("a mid-stream outer abort reaches the candidate's attempt signal with the caller's reason", async () => {
    const { w, release } = hangingCandidateWorld();
    const outer = new AbortController();
    const walkDone = w.run(['a/one'], { signal: outer.signal });

    await firstAttempt(w);
    expect(w.attempts[0].signal!.aborted).toBe(false);

    // The chain listener fires synchronously on abort: the provider-side
    // query is cancelled immediately, with the caller's reason — not left
    // running in the background and not with a generic one.
    const reason = new Error('user cancelled');
    outer.abort(reason);
    expect(w.attempts[0].signal!.aborted).toBe(true);
    expect(w.attempts[0].signal!.reason).toBe(reason);

    release();
    await walkDone;
  }, 15_000);

  it('an ALREADY-aborted caller aborts the attempt at creation, with its reason', async () => {
    const { w, release } = hangingCandidateWorld();
    const reason = new Error('too late');
    const walkDone = w.run(['a/one'], { signal: AbortSignal.abort(reason) });

    // Inspect while the consume still hangs: the walk's own finally would
    // abandon the attempt later anyway, so only the state at open time
    // proves the caller's abort reached the attempt at creation.
    await firstAttempt(w);
    expect(w.attempts[0].signal!.aborted).toBe(true);
    expect(w.attempts[0].signal!.reason).toBe(reason);

    release();
    await walkDone;
  }, 15_000);

  it('a live outer signal leaves the attempt signal live', async () => {
    const { w, release } = hangingCandidateWorld();
    const outer = new AbortController();
    const walkDone = w.run(['a/one'], { signal: outer.signal });

    await firstAttempt(w);
    // No spurious abort: a healthy cascade must not cancel its candidates.
    expect(w.attempts[0].signal!.aborted).toBe(false);

    release();
    await walkDone;
  }, 15_000);
});
