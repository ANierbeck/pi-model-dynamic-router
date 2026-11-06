// Mutation slice 2 (docs/mutation-data/slice2-triage/pre.md, clusters E/F/G/H):
// the pre-flight skips of walkCandidates each push a user-visible reason into
// the aggregate failure block, and a thrown open narrates the error text. No
// test asserted any of those strings — every mutant that empties, mis-numbers
// or mis-keys them survived. Each case below drives the real walk and asserts
// the exact text the user sees in the terminal error event.

import { describe, it, expect } from 'vitest';

import {
  BASE_CONFIG,
  cloudModel,
  drainStream,
  emptyStream,
  errorStream,
  streamErrorText,
  streamText,
  withIsolatedRouter,
} from './helpers/drive-stream-env.ts';

const USER_TURN = { messages: [{ role: 'user', content: 'do the thing' }] };

async function run(
  groupStream: (model: any, context: any, options: any) => AsyncIterable<any>,
  context: any = USER_TURN
) {
  return drainStream(
    await Promise.resolve(groupStream({ provider: 'standard', id: 'standard' }, context, {}))
  );
}

describe('walkCandidates: pre-flight skip reasons reach the aggregate', () => {
  it('names the open provider breaker and its remaining seconds', async () => {
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
        streamSimple.mockImplementation((model: any) =>
          model.provider === 'wedge-provider' ? emptyStream() : errorStream('500 upstream down')
        );

        const errText = streamErrorText(await run(groupStream));

        // The 4th candidate of the tripped provider is skipped pre-flight and
        // its reason lands in the aggregate the user sees. The remaining
        // seconds come from the breaker's own state: a wrong key, a clamped
        // zero or an inflated value all break the shape below.
        expect(errText).toMatch(/skipped, provider breaker open \((?:[1-9]\d{0,3})s remaining\)/);
        expect(errText).toContain('wedge-provider/x-4');
      }
    );
  }, 30_000);

  it('names the candidate context window and the tokens the turn needs', async () => {
    const small = { ...cloudModel('small-provider', 's-1'), contextWindow: 8_000 };
    await withIsolatedRouter(
      { ...BASE_CONFIG, gdpval_builtin: { 's-1': 1000, 'big-1': 990 } },
      [small, cloudModel('big-provider', 'big-1')],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation(() => errorStream('500 upstream down'));

        const errText = streamErrorText(
          await run(groupStream, { messages: [{ role: 'user', content: 'x '.repeat(60_000) }] })
        );

        // Overflow short-circuit does not fire (the big model was tried and
        // failed), so the small model's skip reason is what the user reads.
        expect(errText).toMatch(/skipped, context window 8000 < \d+ tokens needed/);
      }
    );
  }, 30_000);
});

describe('walkCandidates: thrown open', () => {
  it('narrates the thrown error text and aggregates it', async () => {
    await withIsolatedRouter(
      { ...BASE_CONFIG, gdpval_builtin: { 'a-1': 1000 } },
      [cloudModel('throw-provider', 'a-1')],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation(() => {
          throw new Error('bridge exploded');
        });

        const events = await run(groupStream);

        // The narration names the reason the model is unavailable — a
        // non-Error throw or a lost message would read "undefined".
        expect(streamText(events)).toContain(
          'Trying next model (throw-provider/a-1 unavailable: bridge exploded)'
        );
        const errText = streamErrorText(events);
        expect(errText).toContain('bridge exploded');
        expect(errText).not.toContain('undefined');
      }
    );
  }, 30_000);
});
