// Mutation slice 2 batch 3, cluster H (docs/mutation-data/slice2-triage/core.md):
// the `catch (streamError)` block of driveStream's walk. A throwing STREAM never
// reaches it (the stream proxy turns that into a soft `stream_threw` failure,
// see drive-stream-thrown-streams.test.ts); it runs when a recording seam
// throws after a candidate's result came back. The seam used here is the
// provider-breaker store, made to throw once per ref for the soft-failure
// evidence write; the catch block then does its own bookkeeping.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  BASE_CONFIG,
  cloudModel,
  countOccurrences,
  drainStream,
  emptyStream,
  streamText,
  successStream,
  withIsolatedRouter,
} from './helpers/drive-stream-env.ts';

const seam = vi.hoisted(() => ({ failWith: undefined as string | undefined }));

vi.mock('../src/provider-breaker.ts', async (orig) => {
  const actual = await orig<typeof import('../src/provider-breaker.ts')>();
  return {
    ...actual,
    // Throws only for the soft-failure evidence write (empty_response); the
    // catch block's own provider_error write goes through to the real store.
    recordProviderFailure: vi.fn((...args: Parameters<typeof actual.recordProviderFailure>) => {
      if (seam.failWith !== undefined && args[2] === 'empty_response')
        throw new Error(seam.failWith);
      return actual.recordProviderFailure(...args);
    }),
  };
});

const USER_TURN = { messages: [{ role: 'user', content: 'do the thing' }] };

async function run(groupStream: (model: any, context: any, options: any) => AsyncIterable<any>) {
  return drainStream(
    await Promise.resolve(groupStream({ provider: 'standard', id: 'standard' }, USER_TURN, {}))
  );
}

beforeEach(() => {
  seam.failWith = undefined;
});

describe('driveStream: a recording seam that throws is a failure of that candidate', () => {
  it('narrates the error, names the next candidate and walks on', async () => {
    seam.failWith = 'seam exploded';
    await withIsolatedRouter(
      { ...BASE_CONFIG, gdpval_builtin: { 's-1': 1000, 's-2': 990 } },
      [cloudModel('seam-provider', 's-1'), cloudModel('seam-provider', 's-2')],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation((model: any) =>
          model.id === 's-1' ? emptyStream() : successStream('s-2 answered')
        );
        const text = streamText(await run(groupStream));

        expect(text).toContain('s-2 answered');
        expect(text).toContain(
          '> [router] seam-provider/s-1 — error: seam exploded, trying seam-provider/s-2 …'
        );
      }
    );
  }, 30_000);

  it('puts every failed candidate into cooldown, so the cascade has to force-retry the shortest one', async () => {
    seam.failWith = 'seam exploded';
    await withIsolatedRouter(
      { ...BASE_CONFIG, gdpval_builtin: { 's-1': 1000, 's-2': 990 } },
      [cloudModel('seam-provider', 's-1'), cloudModel('seam-provider', 's-2')],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation(() => emptyStream());
        const text = streamText(await run(groupStream));

        // Both candidates failed through the catch block; its bookkeeping put
        // them in cooldown, which is why the walk ends in the shortest-cooldown
        // retry instead of a plain "all candidates failed".
        expect(text).toContain('All models in cooldown, retrying seam-provider/s-1');
        expect(streamSimple.mock.calls.map((c: any[]) => c[0].id)).toEqual(['s-1', 's-2', 's-1']);
      }
    );
  }, 30_000);

  it('transport-shaped seam errors are provider evidence: the third opens the breaker, the fourth is skipped', async () => {
    seam.failWith = 'connect ECONNRESET 10.0.0.1:443';
    await withIsolatedRouter(
      {
        ...BASE_CONFIG,
        gdpval_builtin: { 's-1': 1000, 's-2': 990, 's-3': 980, 's-4': 970, 'y-1': 900 },
      },
      [
        cloudModel('seam-provider', 's-1'),
        cloudModel('seam-provider', 's-2'),
        cloudModel('seam-provider', 's-3'),
        cloudModel('seam-provider', 's-4'),
        cloudModel('spare-provider', 'y-1'),
      ],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation((model: any) =>
          model.provider === 'seam-provider' ? emptyStream() : successStream('spare answered')
        );
        const text = streamText(await run(groupStream));

        expect(text).toContain('spare answered');
        expect(streamSimple.mock.calls.map((c: any[]) => c[0].id)).toEqual([
          's-1',
          's-2',
          's-3',
          'y-1',
        ]);
        expect(text).toContain('seam-provider looks wedged');
        expect(countOccurrences(text, 'looks wedged')).toBe(1);
      }
    );
  }, 30_000);

  it('a non-transport seam error is not provider evidence: all four candidates are tried', async () => {
    seam.failWith = 'seam exploded';
    await withIsolatedRouter(
      {
        ...BASE_CONFIG,
        gdpval_builtin: { 's-1': 1000, 's-2': 990, 's-3': 980, 's-4': 970, 'y-1': 900 },
      },
      [
        cloudModel('seam-provider', 's-1'),
        cloudModel('seam-provider', 's-2'),
        cloudModel('seam-provider', 's-3'),
        cloudModel('seam-provider', 's-4'),
        cloudModel('spare-provider', 'y-1'),
      ],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation((model: any) =>
          model.provider === 'seam-provider' ? emptyStream() : successStream('spare answered')
        );
        const text = streamText(await run(groupStream));

        expect(streamSimple.mock.calls.map((c: any[]) => c[0].id)).toEqual([
          's-1',
          's-2',
          's-3',
          's-4',
          'y-1',
        ]);
        expect(text).not.toContain('looks wedged');
      }
    );
  }, 30_000);
});
