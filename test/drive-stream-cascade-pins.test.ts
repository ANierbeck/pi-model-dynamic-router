// Mutation slice 2 follow-up (docs/mutation-data/slice2-triage/probe.md,
// clusters 1-4): pins for the part of driveStream that runs AFTER a walk has
// failed — the fallback cascade head, the context-overflow short-circuit and
// the all-behind-breaker probe gate. Each assertion names the behaviour a
// surviving mutant would change; none of them is a restatement of the code.

import { describe, it, expect } from 'vitest';

import {
  BASE_CONFIG,
  cloudModel,
  drainStream,
  emptyStream,
  errorStream,
  streamErrorText,
  streamText,
  successStream,
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

// `standard` holds the high scorers, `simple` the low ones: a failed walk in
// `standard` has a real, disjoint fallback pool to cascade into.
const CASCADE_CONFIG = {
  ...BASE_CONFIG,
  model_groups: {
    standard: { fallback_groups: ['simple'], min_gdpval: 900, max_cost: 1000 },
    simple: { fallback_groups: [], min_gdpval: 0, max_gdpval: 899, max_cost: 1000 },
  },
  gdpval_builtin: { 'hi-1': 1000, 'hi-2': 990, 'lo-1': 800 },
};
const CASCADE_MODELS = [
  cloudModel('hi-provider-a', 'hi-1'),
  cloudModel('hi-provider-b', 'hi-2'),
  cloudModel('lo-provider', 'lo-1'),
];

describe('driveStream: fallback cascade head', () => {
  it('walks into the fallback group once every candidate failed, and says so', async () => {
    await withIsolatedRouter(
      CASCADE_CONFIG,
      CASCADE_MODELS,
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation((model: any) =>
          model.id === 'lo-1' ? successStream('fallback group answered') : emptyStream()
        );

        const events = await run(groupStream);
        const text = streamText(events);

        // The cascade ran: the lower-ranked pool answered ...
        expect(text).toContain('fallback group answered');
        expect(streamSimple.mock.calls.map((c: any[]) => c[0].id)).toEqual([
          'hi-1',
          'hi-2',
          'lo-1',
        ]);
        // ... and the user was told which group failed and where the turn went.
        expect(text).toContain('All models in standard failed, trying simple...');
        expect(streamErrorText(events)).not.toContain('candidate(s) failed');
      }
    );
  }, 30_000);

  it('a configured fallback group with no candidates ends in the plain failure, not in a crash', async () => {
    await withIsolatedRouter(
      {
        ...CASCADE_CONFIG,
        // `simple` is configured but its score floor excludes every model.
        model_groups: {
          standard: { fallback_groups: ['simple'], min_gdpval: 900 },
          simple: { fallback_groups: [], min_gdpval: 5000, max_cost: 1000 },
        },
      },
      CASCADE_MODELS,
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation(() => emptyStream());

        const events = await run(groupStream);

        const errText = streamErrorText(events);
        expect(errText).toContain('candidate(s) failed');
        // A crash here would surface as the outer catch's wording.
        expect(errText).not.toContain('outside the candidate loop');
        expect(streamText(events)).not.toContain('All models in standard failed');
        // The empty `simple` pool is never walked.
        expect(streamSimple.mock.calls.map((c: any[]) => c[0].id)).not.toContain('lo-1');
      }
    );
  }, 30_000);
});

describe('driveStream: context-overflow short-circuit', () => {
  const bigTurn = { messages: [{ role: 'user', content: 'x '.repeat(60_000) }] };
  const smallWindow = (provider: string, id: string) => ({
    ...cloudModel(provider, id),
    contextWindow: 8_000,
  });
  const OVERFLOW_CONFIG = {
    ...BASE_CONFIG,
    gdpval_builtin: { 's-1': 1000, 's-2': 990, 'big-1': 980 },
  };

  it('asks for compaction when EVERY candidate was skipped for its context window', async () => {
    await withIsolatedRouter(
      OVERFLOW_CONFIG,
      [smallWindow('small-a', 's-1'), smallWindow('small-b', 's-2')],
      async ({ groupStream, streamSimple }) => {
        const events = await run(groupStream, bigTurn);

        const err: any = events.find((e: any) => e.type === 'error');
        expect(err).toBeDefined();
        const content = (err.error.content ?? []).map((c: any) => c.text ?? '').join('');
        // Both texts are consumed downstream: the visible line and the
        // "prompt is too long" message Pi's compaction trigger matches on.
        expect(content).toMatch(
          /Conversation \(\d+ tokens\) exceeds every available model's context window/
        );
        expect(content).toContain('triggering compaction');
        expect(String(err.error.errorMessage)).toMatch(
          /^prompt is too long: \d+ tokens exceeds the maximum context length of available models$/
        );
        expect(streamSimple).not.toHaveBeenCalled();
      }
    );
  }, 30_000);

  it('does NOT ask for compaction when one candidate was skipped and another really failed', async () => {
    await withIsolatedRouter(
      OVERFLOW_CONFIG,
      [smallWindow('small-a', 's-1'), cloudModel('big-provider', 'big-1')],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation(() => emptyStream());

        const events = await run(groupStream, bigTurn);

        // The big-window model was tried and failed: compaction would not
        // help, and telling the user to compact would be wrong.
        const errText = streamErrorText(events);
        expect(streamSimple.mock.calls.map((c: any[]) => c[0].id)).toEqual(['big-1']);
        expect(errText).toContain('candidate(s) failed');
        expect(errText).not.toContain('exceeds every available model');
        expect(errText).not.toContain('prompt is too long');
      }
    );
  }, 30_000);

  it('does NOT ask for compaction when every candidate failed for another reason', async () => {
    await withIsolatedRouter(
      OVERFLOW_CONFIG,
      [cloudModel('big-provider', 'big-1')],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation(() => errorStream('500 internal server error'));

        const events = await run(groupStream);

        const errText = streamErrorText(events);
        expect(errText).toContain('candidate(s) failed');
        expect(errText).not.toContain('exceeds every available model');
        expect(errText).not.toContain('prompt is too long');
      }
    );
  }, 30_000);
});

describe('driveStream: all-behind-breaker probe gate', () => {
  const WEDGE_CONFIG = {
    ...BASE_CONFIG,
    gdpval_builtin: { 'x-1': 1000, 'x-2': 990, 'x-3': 980, 'y-1': 900 },
  };

  it('names the wedged provider and the probed ref in the narration', async () => {
    await withIsolatedRouter(
      WEDGE_CONFIG,
      [
        cloudModel('wedge-provider', 'x-1'),
        cloudModel('wedge-provider', 'x-2'),
        cloudModel('wedge-provider', 'x-3'),
      ],
      async ({ groupStream, streamSimple }) => {
        let x1Calls = 0;
        streamSimple.mockImplementation((model: any) => {
          if (model.id === 'x-1' && ++x1Calls === 2) return successStream('probe recovered');
          return emptyStream();
        });

        const text = streamText(await run(groupStream));

        expect(text).toContain(
          'All remaining candidates sit behind open provider breakers — probing wedged provider wedge-provider via wedge-provider/x-1…'
        );
      }
    );
  }, 30_000);

  it('does NOT force a probe while only SOME candidates sit behind an open breaker', async () => {
    await withIsolatedRouter(
      WEDGE_CONFIG,
      [
        cloudModel('wedge-provider', 'x-1'),
        cloudModel('wedge-provider', 'x-2'),
        cloudModel('wedge-provider', 'x-3'),
        cloudModel('spare-provider', 'y-1'),
      ],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation((model: any) =>
          // The spare provider fails with a per-model error: no breaker for it.
          model.provider === 'spare-provider'
            ? errorStream('400 {"message":"bad request"}')
            : emptyStream()
        );

        const events = await run(groupStream);

        // The wedge tripped (3 empties) but the spare candidate is not
        // behind a breaker, so the walk ends without a forced probe: x-1 is
        // attempted exactly once (a probe would re-attempt it).
        const attempted = streamSimple.mock.calls.map((c: any[]) => c[0].id);
        expect(attempted.slice(0, 4)).toEqual(['x-1', 'x-2', 'x-3', 'y-1']);
        expect(attempted.filter((id: string) => id === 'x-1')).toHaveLength(1);
        expect(streamText(events)).not.toContain('probing wedged provider');
        expect(streamErrorText(events)).toContain('candidate(s) failed');
      }
    );
  }, 30_000);
});

describe('driveStream: context-overflow → larger candidates', () => {
  // The provider's own numbers, not our estimate: a parseable overflow error
  // names the model's real window and the tokens the request needed.
  const OVERFLOW_DETAIL =
    'prompt is too long: 400: {"message":"This endpoint\'s maximum context length is 196608 tokens. However, you requested about 197318 tokens","code":400}';
  const overflowStream = () => errorStream(OVERFLOW_DETAIL);
  const modelWithWindow = (provider: string, id: string, contextWindow: number) => ({
    ...cloudModel(provider, id),
    contextWindow,
  });

  it('tries only the candidates that can hold the tokens the provider reported', async () => {
    await withIsolatedRouter(
      { ...BASE_CONFIG, gdpval_builtin: { a: 1000, tiny: 990, edge: 980, big: 970 } },
      [
        modelWithWindow('overflow-provider', 'a', 200_000),
        modelWithWindow('tiny-provider', 'tiny', 100_000),
        // Exactly the reported need: not LARGER, so it must not be tried.
        modelWithWindow('edge-provider', 'edge', 197_318),
        modelWithWindow('big-provider', 'big', 1_000_000),
      ],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation((model: any) =>
          model.id === 'big' ? successStream('big model answered') : overflowStream()
        );

        const events = await run(groupStream);
        const attempted = streamSimple.mock.calls.map((c: any[]) => c[0].id);

        expect(attempted).toEqual(['a', 'big']);
        expect(streamText(events)).toContain('big model answered');
        // The narration names the discovered window and the need.
        expect(streamText(events)).toContain(
          'context window (196,608 tokens) < 197,318 needed — trying 1 larger model(s)'
        );
      }
    );
  }, 30_000);

  it('asks for compaction with the provider detail when no larger candidate remains', async () => {
    await withIsolatedRouter(
      { ...BASE_CONFIG, gdpval_builtin: { a: 1000 } },
      [modelWithWindow('overflow-provider', 'a', 200_000)],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation(() => overflowStream());

        const events = await run(groupStream);
        const err: any = events.find((e: any) => e.type === 'error');
        const content = (err.error.content ?? []).map((c: any) => c.text ?? '').join('');

        expect(content).toContain(
          'overflow-provider/a rejected the prompt as too large for its context window — triggering compaction.'
        );
        // The provider's own words survive into the compaction trigger.
        expect(String(err.error.errorMessage)).toContain(
          'prompt is too long: prompt is too long: 400'
        );
      }
    );
  }, 30_000);
});

describe('driveStream: unparseable context overflow', () => {
  it('falls back to the token estimate and narrates an unknown window', async () => {
    await withIsolatedRouter(
      {
        ...BASE_CONFIG,
        gdpval_builtin: { a: 1000, tiny: 990, big: 970 },
      },
      [
        { ...cloudModel('overflow-provider', 'a'), contextWindow: 200_000 },
        { ...cloudModel('tiny-provider', 'tiny'), contextWindow: 100_000 },
        { ...cloudModel('big-provider', 'big'), contextWindow: 1_000_000 },
      ],
      async ({ groupStream, streamSimple }) => {
        // Overflow-shaped, but without the provider's numbers: the branch has
        // to fall back to our own estimate and say the window is unknown.
        streamSimple.mockImplementation((model: any) =>
          model.id === 'big'
            ? successStream('big model answered')
            : errorStream('prompt is too long: 400 (no token counts in this body)')
        );

        const events = await run(groupStream);

        // Without the provider's numbers the filter can only use our own
        // estimate, so every remaining candidate looks large enough — and the
        // narration says the window is unknown instead of inventing one.
        expect(streamText(events)).toContain('context window (? tokens)');
        expect(streamText(events)).toContain('big model answered');
        expect(streamSimple.mock.calls.map((c: any[]) => c[0].id)).toEqual(['a', 'tiny', 'big']);
      }
    );
  }, 30_000);
});
