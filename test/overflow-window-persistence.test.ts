// Mutation slice 2 batch 4 (docs/mutation-data/slice2-triage/core.md,
// cluster C rows 918/919): the context window DISCOVERED from a provider's
// overflow error must persist in the registry, so later turns' pre-flight
// guard skips the model instead of burning another doomed attempt. The
// runtime-overflow → larger-candidates half of the branch is pinned in
// drive-stream-cascade-pins.test.ts; this file pins the persistence itself.
// (The next-turn skip alone would NOT prove it: the soft failure also puts
// the model on a 60 s cooldown, which skips it too. The registry entry is
// mutated in place, so the fixture object is the direct observable.)

import { describe, it, expect } from 'vitest';

import {
  BASE_CONFIG,
  cloudModel,
  drainStream,
  streamText,
  successStream,
  withIsolatedRouter,
} from './helpers/drive-stream-env.ts';

const errorStream = (message: string) =>
  (async function* () {
    yield { type: 'error', reason: 'error', error: { errorMessage: message } } as any;
  })();

// The registry says 250k, the endpoint really caps at 196,608 — the exact
// shape of the OpenRouter/minimax field case the discovery was built for.
const OVERFLOW_DETAIL =
  'prompt is too long: 400: {"message":"This endpoint\'s maximum context length is 196608 tokens. However, you requested about 200123 tokens","code":400}';

// ~195k estimated tokens: passes the pre-flight with the DECLARED 250k
// window (safety 12.5k + 4k output still fit), so the model is attempted and
// the provider's runtime rejection is what teaches the router the truth.
const bigTurn = { messages: [{ role: 'user', content: 'x '.repeat(390_000) }] };

async function run(groupStream: (model: any, context: any, options: any) => AsyncIterable<any>) {
  return drainStream(
    await Promise.resolve(groupStream({ provider: 'standard', id: 'standard' }, bigTurn, {}))
  );
}

describe('driveStream: a discovered context window persists', () => {
  it('writes the provider-reported window back into the registry entry', async () => {
    await withIsolatedRouter(
      { ...BASE_CONFIG, gdpval_builtin: { a: 1000, big: 990 } },
      [
        { ...cloudModel('overflow-provider', 'a'), contextWindow: 250_000 },
        { ...cloudModel('big-provider', 'big'), contextWindow: 1_000_000 },
      ],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation((model: any) =>
          model.id === 'a' ? errorStream(OVERFLOW_DETAIL) : successStream('big model answered')
        );

        const text = streamText(await run(groupStream));

        // The walk survived the runtime rejection via the larger candidate …
        expect(text).toContain('big model answered');
        expect(streamSimple.mock.calls.map((c: any[]) => c[0].id)).toEqual(['a', 'big']);
        // … and the model's registry entry now carries the DISCOVERED window,
        // not the optimistic declared one — the persistence the next turn's
        // pre-flight guard reads.
        const attempted = streamSimple.mock.calls.map((c: any[]) => c[0]);
        expect(attempted[0].contextWindow).toBe(196_608);
      }
    );
  }, 30_000);
});
