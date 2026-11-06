// Pins what a stream that THROWS while it is consumed does to the walk: the
// stream proxy turns the throw into a soft `stream_threw` failure, and the walk
// narrates it with the real message and moves on. Whether a throw should count
// as provider-breaker evidence is an open design question (ADR-0026 evidence
// kinds do not list stream_threw); it is deliberately not pinned here.
//
// Mutation triage note (docs/mutation-data/slice2-triage/core.md, cluster H):
// the `catch (streamError)` block of the walk is NOT reached by a throwing
// stream (the proxy catches it first); it runs only when a recording seam
// throws after a result came back. That block needs a seam-throwing fixture
// and is left open in docs/mutation-triage.md.

import { describe, it, expect } from 'vitest';

import {
  BASE_CONFIG,
  cloudModel,
  drainStream,
  streamErrorText,
  streamText,
  successStream,
  withIsolatedRouter,
} from './helpers/drive-stream-env.ts';

// The error is raised while the walk iterates the stream, not when it is created.
const thrownStream = (message: string) => ({
  [Symbol.asyncIterator]: () => ({
    next: async () => {
      throw new Error(message);
    },
  }),
});

const USER_TURN = { messages: [{ role: 'user', content: 'do the thing' }] };

async function run(groupStream: (model: any, context: any, options: any) => AsyncIterable<any>) {
  return drainStream(
    await Promise.resolve(groupStream({ provider: 'standard', id: 'standard' }, USER_TURN, {}))
  );
}

// Higher GDP ranks first in the walk: the models a test expects to be tried
// before the answering one must rank above it.
const CONFIG = {
  ...BASE_CONFIG,
  gdpval_builtin: { 't-1': 1000, 't-2': 990, 'x-1': 980, 'x-2': 970, 'x-3': 960, 'x-4': 950 },
};

describe('driveStream: a stream that throws is a soft failure', () => {
  it('the narration names the failing ref, the real message, and the next candidate', async () => {
    await withIsolatedRouter(
      CONFIG,
      [cloudModel('thrown-provider', 't-1'), cloudModel('thrown-provider', 't-2')],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation((model: any) =>
          model.id === 't-1' ? thrownStream('socket reset by peer') : successStream('t-2 answered')
        );
        const text = streamText(await run(groupStream));

        expect(text).toContain('t-2 answered');
        expect(text).toContain(
          '> [router] thrown-provider/t-1 — stream error: socket reset by peer, trying thrown-provider/t-2 …'
        );
      }
    );
  }, 30_000);

  it('when every candidate fails, the aggregate error records the throw as stream_threw', async () => {
    await withIsolatedRouter(
      CONFIG,
      [cloudModel('thrown-provider', 't-1'), cloudModel('thrown-provider', 't-2')],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation(() => thrownStream('boom'));
        const errors = streamErrorText(await run(groupStream));

        expect(errors).toContain('thrown-provider/t-1: stream_threw');
      }
    );
  }, 30_000);
});
