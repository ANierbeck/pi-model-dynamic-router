// test/provider-breaker-orchestration.test.ts
// Phase 2 of the provider circuit breaker plan
// (docs/plans/2026-10-06-provider-circuit-breaker.md): driveStream feeds
// provider-level evidence to the breaker for CLOUD providers too (D1/D2),
// skips the tripped provider's remaining candidates within the SAME walk
// (D3, the intra-walk short-circuit) and never dead-ends when every
// candidate sits behind an open breaker (D4 — a forced half-open probe of
// the soonest-expiring breaker instead of "all candidates failed").
//
// The four cases are the plan's Phase 2 red-first list, verbatim:
//   1. 4 models of provider X return empty → the third failure trips, the
//      4th is skipped in the same walk, a provider Y candidate still answers;
//   2. ALL candidates belong to a tripped provider → forced half-open probe
//      instead of "all candidates failed";
//   3. 400/422 errors from 3 models do NOT trip;
//   4. a rate-limit-shaped empty response (parsed reset time) does NOT trip.

import { describe, it, expect } from 'vitest';

import {
  countOccurrences,
  drainStream,
  withIsolatedRouter,
  cloudModel,
  BASE_CONFIG,
  emptyStream,
  errorStream,
  successStream,
  streamText,
  streamErrorText,
} from './helpers/drive-stream-env.ts';

describe('driveStream: cloud provider breaker wiring (plan Phase 2)', () => {
  it('case 1 — four empty responses of one cloud provider: the third trips, the fourth is skipped in the same walk, a spare provider answers', async () => {
    await withIsolatedRouter(
      {
        ...BASE_CONFIG,
        gdpval_builtin: { 'x-1': 1000, 'x-2': 990, 'x-3': 980, 'x-4': 970, 'y-1': 900 },
      },
      [
        cloudModel('wedge-provider', 'x-1'),
        cloudModel('wedge-provider', 'x-2'),
        cloudModel('wedge-provider', 'x-3'),
        cloudModel('wedge-provider', 'x-4'),
        cloudModel('spare-provider', 'y-1'),
      ],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation((model: any) => {
          if (model.provider === 'wedge-provider') return emptyStream();
          return successStream('spare provider answered');
        });

        const events = await drainStream(
          await Promise.resolve(
            groupStream(
              { provider: 'standard', id: 'standard' },
              { messages: [{ role: 'user', content: 'do the thing' }] },
              {}
            )
          )
        );
        const text = streamText(events);

        expect(text).toContain('spare provider answered');
        // D3: the fourth candidate of the tripped provider never reached
        // the provider — skipped within the same walk.
        const attempted = streamSimple.mock.calls.map((c: any[]) => c[0].id);
        expect(attempted).toEqual(['x-1', 'x-2', 'x-3', 'y-1']);
        // Narration fires exactly once per open (D6).
        expect(text).toContain('wedge-provider looks wedged');
        expect(countOccurrences(text, 'looks wedged')).toBe(1);
      }
    );
  }, 30_000);

  it('case 2 — every candidate sits behind the open breaker: forced half-open probe answers instead of "all candidates failed"', async () => {
    await withIsolatedRouter(
      {
        ...BASE_CONFIG,
        gdpval_builtin: { 'x-1': 1000, 'x-2': 990, 'x-3': 980, 'x-4': 970 },
      },
      [
        cloudModel('wedge-provider', 'x-1'),
        cloudModel('wedge-provider', 'x-2'),
        cloudModel('wedge-provider', 'x-3'),
        cloudModel('wedge-provider', 'x-4'),
      ],
      async ({ groupStream, streamSimple }) => {
        let x1Calls = 0;
        streamSimple.mockImplementation((model: any) => {
          if (model.id === 'x-1') {
            x1Calls++;
            // The wedge cleared by the time the forced probe re-attempts
            // the highest-ranked candidate.
            if (x1Calls === 2) return successStream('probe recovered');
          }
          return emptyStream();
        });

        const events = await drainStream(
          await Promise.resolve(
            groupStream(
              { provider: 'standard', id: 'standard' },
              { messages: [{ role: 'user', content: 'do the thing' }] },
              {}
            )
          )
        );
        const text = streamText(events);

        // D4: the probe was attempted (x-1 twice) and its answer won —
        // no terminal "all candidates failed" error event.
        expect(x1Calls).toBe(2);
        expect(text).toContain('probe recovered');
        expect(text).toContain('probing wedged provider');
        expect(streamErrorText(events)).not.toContain('candidate(s) failed');
      }
    );
  }, 30_000);

  it('case 2b — a failed forced probe is labeled "probing wedged provider" in the error aggregation', async () => {
    await withIsolatedRouter(
      {
        ...BASE_CONFIG,
        gdpval_builtin: { 'x-1': 1000, 'x-2': 990, 'x-3': 980, 'x-4': 970 },
      },
      [
        cloudModel('wedge-provider', 'x-1'),
        cloudModel('wedge-provider', 'x-2'),
        cloudModel('wedge-provider', 'x-3'),
        cloudModel('wedge-provider', 'x-4'),
      ],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation(() => emptyStream());

        const events = await drainStream(
          await Promise.resolve(
            groupStream(
              { provider: 'standard', id: 'standard' },
              { messages: [{ role: 'user', content: 'do the thing' }] },
              {}
            )
          )
        );
        const text = streamText(events);

        // The probe ran (x-1 attempted twice) and its failure is labeled
        // as the forced half-open probe in the terminal error aggregation.
        expect(streamSimple.mock.calls.filter((c: any[]) => c[0].id === 'x-1')).toHaveLength(2);
        expect(text).toContain('probing wedged provider');
        const errText = streamErrorText(events);
        expect(errText).toContain('candidate(s) failed');
        expect(errText).toContain('probing wedged provider');
      }
    );
  }, 30_000);

  it('case 3 — 400/422/404 errors from three models of one provider do NOT trip the breaker', async () => {
    await withIsolatedRouter(
      {
        ...BASE_CONFIG,
        gdpval_builtin: { 'x-1': 1000, 'x-2': 990, 'x-3': 980, 'y-1': 900 },
      },
      [
        cloudModel('wedge-provider', 'x-1'),
        cloudModel('wedge-provider', 'x-2'),
        cloudModel('wedge-provider', 'x-3'),
        cloudModel('spare-provider', 'y-1'),
      ],
      async ({ groupStream, streamSimple }) => {
        const errors: Record<string, string> = {
          'x-1': '400 {"message":"Reasoning prompt mode is not enabled for this model"}',
          'x-2': '422 status code (no body)',
          'x-3': '404 model not found',
        };
        streamSimple.mockImplementation((model: any) => {
          if (errors[model.id]) return errorStream(errors[model.id]);
          return successStream('spare provider answered');
        });

        const events = await drainStream(
          await Promise.resolve(
            groupStream(
              { provider: 'standard', id: 'standard' },
              { messages: [{ role: 'user', content: 'do the thing' }] },
              {}
            )
          )
        );
        const text = streamText(events);

        expect(text).toContain('spare provider answered');
        // Per-model request/shape errors are NOT provider evidence: all
        // three candidates were attempted, nothing was skipped, no
        // narration.
        const attempted = streamSimple.mock.calls.map((c: any[]) => c[0].id);
        expect(attempted).toEqual(['x-1', 'x-2', 'x-3', 'y-1']);
        expect(text).not.toContain('looks wedged');
      }
    );
  }, 30_000);

  it('case 4 — a rate-limit-shaped failure with a parsed reset time does NOT trip the breaker', async () => {
    await withIsolatedRouter(
      {
        ...BASE_CONFIG,
        gdpval_builtin: { 'x-1': 1000, 'x-2': 990, 'x-3': 980, 'y-1': 900 },
      },
      [
        cloudModel('wedge-provider', 'x-1'),
        cloudModel('wedge-provider', 'x-2'),
        cloudModel('wedge-provider', 'x-3'),
        cloudModel('spare-provider', 'y-1'),
      ],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation((model: any) => {
          if (model.provider === 'wedge-provider') {
            // Rate-limit wording WITH a parseable reset time — the
            // rate-limit path owns these; a subscription window running
            // out is not a wedge (plan D1).
            return errorStream('429 Too Many Requests — rate limit reached, resets 23:59');
          }
          return successStream('spare provider answered');
        });

        const events = await drainStream(
          await Promise.resolve(
            groupStream(
              { provider: 'standard', id: 'standard' },
              { messages: [{ role: 'user', content: 'do the thing' }] },
              {}
            )
          )
        );
        const text = streamText(events);

        expect(text).toContain('spare provider answered');
        const attempted = streamSimple.mock.calls.map((c: any[]) => c[0].id);
        expect(attempted).toEqual(['x-1', 'x-2', 'x-3', 'y-1']);
        expect(text).not.toContain('looks wedged');
      }
    );
  }, 30_000);
});
