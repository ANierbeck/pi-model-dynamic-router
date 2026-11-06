// test/cooldown-collapse-retried-narration.test.ts
// B3 (mutation R3, red-first): the total-cooldown-collapse retry block in
// driveStream (stream-orchestrator.ts, "Total cooldown collapse"). When
// EVERY candidate is in a rate-limit cooldown, driveStream picks the
// soonest-expiring one, WAITS for it (guarded by rate_limit_wait_max_ms),
// and force-retries that ONE model; the retried stream's soft-failure
// result is then narrated. Two R3 recheck clusters lived here:
//
//  1. The collapse-wait guard (L1204, 10 surviving mutants): the existing
//     "collapse branch WAITS" test (test/rate-limit-wait.test.ts) asserts
//     'All models in cooldown' — a prefix shared by BOTH the wait and the
//     force-retry narration, so every guard mutant that flips the branch
//     passed vacuously. These tests assert the branch-distinctive wording
//     ("— waiting" vs ", retrying") on both sides.
//
//  2. The retried-result narration block (L1262-1267, 7 surviving mutants):
//     NO test ever drove a collapse retry that returned repetition_loop or
//     truncated_length — the "stuck in a repetition loop" / "output
//     truncated at max tokens (task incomplete)" narrations of the collapse
//     block were never observed by the suite. (The driveStream cascade's
//     own repetition/truncation narrations at L941-964 ARE covered by
//     test/consolidated-stream-error-pins.test.ts — this is specifically
//     the collapse-retry copy of that handling.)
//
// The three tests drive the real machinery end-to-end (no mocks beyond the
// scripted streams): both candidates return a reset-free rate-limit error on
// their first call, so the cascade records short backoff cooldowns for both
// models, the per-candidate wait path stays off (it needs a KNOWN reset),
// and the collapse branch fires; the retried model's scripted stream then
// decides which narration the block must print.
//
// Red evidence (observed before landing, git-stash method): the collapse
// guard flipped to force-retry, the narration guard flipped to `if (true)`,
// and an emptied truncation string each turned the corresponding test RED
// against the mutated tree; all reverted before the suite went green.

import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';

import { makeExtensionContext, routerStatePaths } from './helpers/extension-harness.ts';
import {
  writeNoOpScanCache,
  flushBackgroundScan,
  removeNoOpScanCacheDefault,
} from './helpers/noop-scan-cache.ts';
import { withRouterEnv } from './helpers/router-env.ts';
import { testModelCost } from './helpers/stream-fixtures.ts';

async function drainStream(
  stream: AsyncIterable<AssistantMessageEvent>
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

/** All router/model chat text (narrations + streamed content). */
function allText(events: AssistantMessageEvent[]): string {
  return events
    .filter((e: any) => e.type === 'text_delta')
    .map((e: any) => e.delta ?? '')
    .join('');
}

/** Full text of the terminal error event(s) — the aggregate failure block. */
function streamErrorText(events: AssistantMessageEvent[]): string {
  return events
    .filter((e: any) => e.type === 'error')
    .map((e: any) => {
      const content = Array.isArray(e.error?.content)
        ? e.error.content.map((c: any) => String(c?.text ?? '')).join('')
        : '';
      return `${content}\n${String(e.error?.errorMessage ?? '')}`;
    })
    .join('\n');
}

/**
 * Scripted model registry (same choreography idea as rate-limit-wait.test.ts):
 * each stream call for a model serves the NEXT script entry, falling back to
 * the LAST entry once the script is exhausted — so whichever model the
 * collapse picks as bestRef, its retry serves the scenario's retry events.
 */
function makeScriptedRegistry(modelsByRef: Record<string, any>) {
  const calls: string[] = [];
  /** The AbortSignal the walk forwarded on each call (openCandidateAttempt's). */
  const signals: (AbortSignal | undefined)[] = [];
  /** Per-ref hook: return 'throw' to make that call reject like a bridge error. */
  const throwOnCall = new Map<string, number>();
  const scripts: Record<string, AssistantMessageEvent[][]> = {};
  const entries = Object.entries(modelsByRef).map(([ref, m]) => ({ ref, model: m }));

  const streamSimple = vi.fn((model: any, _context: any, options?: any) => {
    const found = entries.find((e) => e.model.id === model.id)!;
    calls.push(found.ref);
    signals.push(options?.signal);
    const idx = calls.filter((c) => c === found.ref).length - 1;
    if (throwOnCall.get(found.ref) === idx) throw new Error('bridge exploded');
    const script = scripts[found.ref] ?? [];
    const events = idx < script.length ? script[idx] : (script[script.length - 1] ?? []);
    return (async function* () {
      for (const ev of events) yield ev;
    })();
  });

  return {
    calls,
    signals,
    throwOnCall,
    scripts,
    registry: {
      getAvailable: () => entries.map((e) => e.model),
      find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
      getApiKeyForProvider: async () => null,
      runtime: { streamSimple },
    },
  };
}

/**
 * A rate-limit error with NO parseable reset time: the cooldown falls back
 * to the short backoff ladder, and the per-candidate wait-and-retry path
 * stays off (that path requires a KNOWN, near reset).
 */
function rateLimitNoResetEvents(): AssistantMessageEvent[] {
  return [
    {
      type: 'error',
      reason: 'error',
      error: { message: 'Warning: rate limit exceeded (tpm)' },
    } as any,
  ];
}

/**
 * Content streams, then the stream ends cleanly with done.reason 'length' —
 * max output tokens hit. The real consumeWithDetection reports
 * { ok: false, reason: 'truncated_length' } for this (the interception that
 * test/consolidated-stream-error-pins.test.ts pinned for the cascade path).
 */
function truncatingEvents(): AssistantMessageEvent[] {
  return [
    { type: 'text_delta', contentIndex: 0, delta: 'half an answer, cut off mid-' } as any,
    {
      type: 'done',
      reason: 'length',
      message: {
        role: 'assistant',
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        stopReason: 'length',
        timestamp: Date.now(),
      },
    } as any,
  ];
}

/**
 * One 43-char unit repeated 12x (~516 chars): detectDegenerateRepetition
 * (REPETITION_MIN_TOTAL_LEN 400, REPETITION_MIN_REPEATS 6, unit 20-400
 * chars, ≥8 letters) fires during consumption and consumeWithDetection
 * reports { ok: false, reason: 'repetition_loop', detail }. The unit text
 * deliberately shares no wording with the narrations asserted below.
 */
function repetitionEvents(): AssistantMessageEvent[] {
  return [
    {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'The assistant echoes the same filler line. '.repeat(12),
    } as any,
  ];
}

function cloudModel(provider: string, id: string) {
  return {
    provider,
    id,
    api: 'openai-completions',
    contextWindow: 1_000_000,
    cost: testModelCost(),
  };
}

const baseCfg = {
  free_models: [],
  providers: { openrouter: { free_models: [] } },
  model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
  empty_response_timeout_ms: 5_000,
  reasoning_empty_response_timeout_ms: 5_000,
  stall_timeout_ms: 30_000,
};

/**
 * Boots the router in an isolated tmp project and drives ONE collapse
 * scenario end-to-end. Both models first return a reset-free rate-limit
 * error (short backoff cooldowns for both → the cascade ends with every
 * candidate limited and the collapse branch fires); the retried model then
 * serves `retryEvents` (script index 1, also the last-entry fallback, so it
 * applies whichever model wins the shortest-cooldown pick).
 */
/** What one collapse scenario observed, handed to the assertion callback. */
interface CollapseRun {
  text: string;
  errText: string;
  calls: string[];
  /** The AbortSignal forwarded on each upstream call, in call order. */
  signals: (AbortSignal | undefined)[];
  /** Wall-clock duration of the whole groupStream drain. */
  elapsedMs: number;
}

async function driveCollapseScenario(
  retryEvents: () => AssistantMessageEvent[],
  assert: (helpers: CollapseRun) => void,
  overrides: {
    config?: Record<string, unknown>;
    /** Make the retry call of `ref` reject, like a bridge that throws. */
    throwOnRetryOf?: string;
  } = {}
): Promise<void> {
  const cfg = {
    ...baseCfg,
    gdpval_builtin: { 'lim-model': 1000, 'sec-model': 900 },
    rate_limit_wait_max_ms: 4_000,
    backoff_minutes: [0.02, 0.04],
    soft_backoff_ms: [1000, 2000],
    ...overrides.config,
  };
  const { dynamicConfigPath, scanCachePath } = routerStatePaths();
  const dynBak = `${dynamicConfigPath}.bak`;
  const cacheBak = `${scanCachePath}.bak`;
  let hadDyn = false;
  let hadCache = false;
  await withRouterEnv(
    async (defaultExport: any, tmpDir) => {
      const { ctx: pi, onHandlers } = makeExtensionContext();
      defaultExport(pi);

      const mock = makeScriptedRegistry({
        'lim-provider/lim-model': cloudModel('lim-provider', 'lim-model'),
        'sec-provider/sec-model': cloudModel('sec-provider', 'sec-model'),
      });
      // First call of BOTH models: reset-free rate-limit error. Every later
      // call (the collapse retry) serves the scenario's retry script.
      mock.scripts['lim-provider/lim-model'] = [rateLimitNoResetEvents(), retryEvents()];
      mock.scripts['sec-provider/sec-model'] = [rateLimitNoResetEvents(), retryEvents()];
      if (overrides.throwOnRetryOf) mock.throwOnCall.set(overrides.throwOnRetryOf, 1);

      const ctx: any = { modelRegistry: mock.registry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
      await onHandlers['session_start']?.({}, ctx);
      await flushBackgroundScan();

      const startedAt = Date.now();
      const events = await drainStream(
        defaultExport.groupStream(
          { provider: 'standard', id: 'standard' },
          { messages: [{ role: 'user', content: 'do work' }] },
          {}
        )
      );

      assert({
        text: allText(events),
        errText: streamErrorText(events),
        calls: mock.calls,
        signals: mock.signals,
        elapsedMs: Date.now() - startedAt,
      });
    },
    {
      config: cfg,
      seedScanCache: false,
      beforeImport: () => {
        hadDyn = fs.existsSync(dynamicConfigPath);
        hadCache = fs.existsSync(scanCachePath);
        if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
        if (hadCache) fs.renameSync(scanCachePath, cacheBak);
        writeNoOpScanCache(scanCachePath);
      },
      teardown: () => {
        if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
        removeNoOpScanCacheDefault();
        if (hadCache) fs.renameSync(cacheBak, scanCachePath);
      },
    }
  );
}

describe('cooldown-collapse: retried-result narrations (B3 / mutation R3)', () => {
  it('collapse WAITS for the shortest cooldown and narrates a truncated_length retry', async () => {
    await driveCollapseScenario(truncatingEvents, ({ text, errText, calls }) => {
      // The WAIT branch fired — the force-retry narration ("All models in
      // cooldown, retrying ...") must NOT have. This is the branch-
      // distinctive assertion the existing collapse test was missing (its
      // 'All models in cooldown' prefix matched BOTH narrations).
      expect(text).toContain('All models in cooldown — waiting');
      expect(text).not.toContain('All models in cooldown, retrying');
      // The retried stream ended with done.reason 'length' — the collapse
      // block's retried-narration printed the truncation notice.
      expect(text).toContain('output truncated at max tokens (task incomplete)');
      // The turn still ends in the aggregate failure event.
      expect(errText).toContain('candidate(s) failed');
      // 2 cascade attempts (one per model) + exactly ONE collapse retry.
      expect(calls).toHaveLength(3);
    });
  }, 30_000);

  it('narrates a repetition_loop retry as "stuck in a repetition loop"', async () => {
    await driveCollapseScenario(repetitionEvents, ({ text, errText }) => {
      expect(text).toContain('All models in cooldown — waiting');
      expect(text).toContain('stuck in a repetition loop');
      // The repetition-side narration, not the truncation one.
      expect(text).not.toContain('output truncated at max tokens');
      expect(errText).toContain('candidate(s) failed');
    });
  }, 30_000);

  it('a rate_limit_exceeded retry does NOT print the repetition/truncation narration', async () => {
    await driveCollapseScenario(rateLimitNoResetEvents, ({ text, errText }) => {
      expect(text).toContain('All models in cooldown — waiting');
      // The else branch owns rate-limit retries — the repetition/
      // truncation narration block must not fire for them.
      expect(text).not.toContain('output truncated at max tokens');
      expect(text).not.toContain('stuck in a repetition loop');
      expect(errText).toContain('candidate(s) failed');
    });
  }, 30_000);
});

// ── guard, duration, bookkeeping (mutation slice 2, collapse region) ────────
//
// The triage in docs/mutation-data/slice2-triage/collapse.md lists survivors
// that the narration tests above cannot reach: the wait-vs-force-retry guard
// with a cap enabled, the wait duration, the shortest-cooldown tie-break, the
// throwing retry, the abandoned/live retry signal, and the aggregate failure
// block. Each test below names the behaviour a surviving mutant changes.

describe('cooldown-collapse: wait-vs-force-retry guard', () => {
  it('force-retries instead of waiting when the cooldown exceeds the wait cap', async () => {
    await driveCollapseScenario(
      rateLimitNoResetEvents,
      ({ text, calls }) => {
        // 1.2s cooldown vs a 500ms cap: waiting would sleep past the cap.
        expect(text).toContain('All models in cooldown, retrying');
        expect(text).not.toContain('All models in cooldown — waiting');
        expect(calls).toHaveLength(3);
      },
      { config: { rate_limit_wait_max_ms: 500 } }
    );
  }, 30_000);

  it('waits when the cooldown is exactly at the wait cap (boundary is inclusive)', async () => {
    await driveCollapseScenario(
      rateLimitNoResetEvents,
      ({ text }) => {
        // bestSecs is ceil(remaining/1000) = 2 for the 1.2s tier-1 cooldown,
        // so bestSecs*1000 === waitMaxMs: the inclusive comparison waits.
        expect(text).toContain('All models in cooldown — waiting');
        expect(text).not.toContain('All models in cooldown, retrying');
      },
      { config: { rate_limit_wait_max_ms: 2000 } }
    );
  }, 30_000);

  it('sleeps the full cooldown plus the 2s grace before retrying', async () => {
    await driveCollapseScenario(
      rateLimitNoResetEvents,
      ({ elapsedMs, text }) => {
        expect(text).toContain('All models in cooldown — waiting');
        // 3s cooldown + 2s grace = ~5s. A shortened sleep (cooldown - grace,
        // or cooldown/1000 + grace) finishes in ~1s / ~2s.
        expect(elapsedMs).toBeGreaterThanOrEqual(4_500);
      },
      { config: { backoff_minutes: [0.05], rate_limit_wait_max_ms: 4000 } }
    );
  }, 30_000);
});

describe('cooldown-collapse: retry bookkeeping', () => {
  it('retries the FIRST of two equally-cooldown candidates', async () => {
    await driveCollapseScenario(
      rateLimitNoResetEvents,
      ({ calls, text }) => {
        // Both models carry the same tier-1 soft backoff, so the pick is a tie
        // and must keep the earlier (higher-ranked) candidate.
        expect(calls).toHaveLength(3);
        expect(calls[0]).toBe('lim-provider/lim-model');
        expect(calls[2]).toBe('lim-provider/lim-model');
        expect(text).toContain('retrying lim-provider/lim-model');
      },
      { config: { rate_limit_wait_max_ms: 0 } }
    );
  }, 30_000);

  it('reports a retry whose upstream call throws instead of dropping it from the aggregate', async () => {
    await driveCollapseScenario(
      rateLimitNoResetEvents,
      ({ errText }) => {
        // The retried model threw: its message must still appear in the
        // user-visible aggregate list, not vanish.
        expect(errText).toContain('candidate(s) failed');
        expect(errText).toContain('lim-provider/lim-model');
        expect(errText).toContain('bridge exploded');
        // A null retry target must not be dereferenced: that would throw out
        // of the walk and replace the aggregate with "Routing failed".
        expect(errText).not.toContain('Routing failed');
      },
      { throwOnRetryOf: 'lim-provider/lim-model' }
    );
  }, 30_000);

  it('does not abort the winning attempt signal after a successful retry', async () => {
    await driveCollapseScenario(
      () => [
        { type: 'text_delta', contentIndex: 0, delta: 'recovered after the collapse' } as any,
        {
          type: 'done',
          reason: 'stop',
          message: {
            role: 'assistant',
            content: [],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        } as any,
      ],
      ({ text, errText, calls, signals }) => {
        expect(text).toContain('recovered after the collapse');
        // A successful recovery must not also push the aggregate failure.
        expect(errText).not.toContain('candidate(s) failed');
        // The retried attempt's signal is still live: abandoning the winner
        // would kill a successful toolUse turn's SDK query.
        expect(calls).toHaveLength(3);
        expect(signals[2]?.aborted).toBe(false);
      }
    );
  }, 30_000);
});
