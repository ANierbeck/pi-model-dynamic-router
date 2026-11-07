// Mutation slice 2 batch 4 (docs/mutation-data/slice2-triage/core.md,
// cluster C rows 929/931, current mutants 713/717/720/722): the
// larger-candidates filter after a parseable runtime overflow. The walk must
// hand only candidates with a KNOWN window strictly larger than the
// requested-token count (or no known window at all) to the overflow rescue
// pass — a too-small model would just burn another doomed attempt, and a
// boundary model (window === requested) is exactly as doomed.
//
// The runtime-overflow → rescue-pass wiring itself and the context-window
// persistence are pinned in drive-stream-cascade-pins.test.ts and
// overflow-window-persistence.test.ts.

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

// Parseable overflow: the provider names its real window (196,608) and the
// requested token count (200,123) — the filter's minNeeded.
const OVERFLOW_DETAIL =
  'prompt is too long: 400: {"message":"This endpoint\'s maximum context length is 196608 tokens. However, you requested about 200123 tokens","code":400}';

// ~150k estimated tokens: every fixture model except tiny (170k) and the
// boundary (200,123) passes its pre-flight with margin, so the divergence is
// the OVERFLOW FILTER, not the pre-flight guard.
const bigTurn = { messages: [{ role: 'user', content: 'x '.repeat(300_000) }] };

async function run(groupStream: (model: any, context: any, options: any) => AsyncIterable<any>) {
  return drainStream(
    await Promise.resolve(groupStream({ provider: 'standard', id: 'standard' }, bigTurn, {}))
  );
}

describe('driveStream: the overflow rescue pass filters its candidates', () => {
  it('tries only unknown-window and strictly-larger models, never the boundary', async () => {
    await withIsolatedRouter(
      {
        ...BASE_CONFIG,
        // Pool order via gdpval: small → boundary → tiny → unknown → big.
        gdpval_builtin: {
          small: 1000,
          boundary: 990,
          tiny: 980,
          unknown: 970,
          big: 960,
        },
      },
      [
        // Declared 250k so the pre-flight passes; the provider's real window
        // is 196,608 — the runtime rejection is what triggers the rescue.
        { ...cloudModel('overflow-provider', 'small'), contextWindow: 250_000 },
        // Window EXACTLY minNeeded (200,123): pristine excludes it (not
        // strictly larger), a `>=` mutant attempts it next.
        { ...cloudModel('boundary-provider', 'boundary'), contextWindow: 200_123 },
        // 170k: passes its own pre-flight (150k + safety + output), but is
        // below minNeeded — the filter must drop it.
        { ...cloudModel('tiny-provider', 'tiny'), contextWindow: 170_000 },
        // No declared window: unknown windows are allowed through — the
        // rescue pass must not starve on missing metadata.
        { ...(cloudModel('unknown-provider', 'unknown') as any), contextWindow: undefined },
        { ...cloudModel('big-provider', 'big'), contextWindow: 1_000_000 },
      ],
      async ({ groupStream, streamSimple }) => {
        streamSimple.mockImplementation((model: any) => {
          if (model.id === 'small') return errorStream(OVERFLOW_DETAIL);
          return successStream(`${model.id} served`);
        });

        const text = streamText(await run(groupStream));

        // The rescue pass tried the unknown-window model (which served) …
        expect(text).toContain('unknown served');
        const attempted = streamSimple.mock.calls.map((c: any[]) => c[0].id);
        expect(attempted).toEqual(['small', 'unknown']);
        // … and NOT the boundary twin (window === minNeeded), not the
        // too-small model, and not big (the walk ended before it).
        expect(attempted).not.toContain('boundary');
        expect(attempted).not.toContain('tiny');
      }
    );
  }, 30_000);
});
