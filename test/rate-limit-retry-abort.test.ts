// Mutation slice 2 batch 4 (docs/mutation-data/slice2-triage/core.md,
// cluster A, the wait-retry block's abort and slot seams). The wait-retry
// opens its OWN candidate attempt (`openCandidateAttempt`), so it owns the
// same cancellation duties as the main loop: a retry that never got a
// stream, a retry that timed out, and a retry the user aborted must all end
// with the attempt's AbortController fired (claude-bridge only cancels its
// SDK query on options.signal abort — the 2026-09-27 token-burn incident),
// a SUCCESSFUL retry must NOT be aborted (its stream may still be needed for
// tool results), an aborted retry stops the walk instead of cascading, and
// a LOCAL retry's concurrency slot must be released for the next turn.
//
// The grace period, one-wait-per-walk, recordOk and throwing-retry cases of
// the same block are pinned in rate-limit-wait.test.ts.

import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import os from 'node:os';

import { writeNoOpScanCache, flushBackgroundScan } from './helpers/noop-scan-cache.ts';
import {
  healthyEvents,
  makeScriptedRegistry,
  rateLimitErrorEvents,
  rateLimitBaseCfg,
  rateLimitNearReset,
  rateLimitTestModel,
  scripted,
  type StreamScript,
} from './helpers/rate-limit-fixtures.ts';
import {
  drainStream,
  parkStateFiles,
  routerStatePaths,
  makePiCtx,
} from './helpers/extension-harness.ts';
import { bootProjectDir, teardownBoot } from './helpers/router-env.ts';

const { dynamicConfigPath, scanCachePath } = routerStatePaths();

async function withIsolatedRouter(
  configOverride: Record<string, unknown>,
  fn: (defaultExport: any) => Promise<void>
) {
  const { tmpDir, cwdSpy } = bootProjectDir(configOverride, 'router-rlabort-');
  const restoreState = parkStateFiles([dynamicConfigPath, scanCachePath]);
  writeNoOpScanCache(scanCachePath);
  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    await fn(mod.default as any);
  } finally {
    teardownBoot({ cwdSpy, tmpDir, restoreState });
  }
}

const joinedText = (events: AssistantMessageEvent[]) =>
  events
    .filter((e: any) => e.type === 'text_delta')
    .map((e: any) => e.delta ?? '')
    .join('');

const baseCfg = { ...rateLimitBaseCfg, rate_limit_wait_max_ms: 4_000 };

/** Silent until aborted (or 3 s) — a still-running provider after a timeout. */
const silentUntilAborted: StreamScript = (signal) =>
  (async function* () {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3_000);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true }
      );
    });
    yield { type: 'text_delta', contentIndex: 0, delta: 'LATE GHOST TEXT', partial: {} } as any;
    yield {
      type: 'done',
      reason: 'stop',
      message: { role: 'assistant', content: [], stopReason: 'stop' },
    } as any;
  })();

/**
 * One session, many turns — the REAL shape: session_start reloads persisted
 * state from disk, so a fresh session per turn would read a stale snapshot
 * (the in-memory recordOk deletion only reaches disk on the next save). All
 * turns of a fixture share one session, exactly like a live chat.
 */
async function openSession(defaultExport: any, registry: any) {
  const { pi, onHandlers } = makePiCtx();
  defaultExport(pi);
  const ctx: any = { modelRegistry: registry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
  await onHandlers['session_start']?.({}, ctx);
  await flushBackgroundScan();
  return () => {
    const context: any = { messages: [{ role: 'user', content: 'do work' }] };
    return drainStream(
      defaultExport.groupStream({ provider: 'standard', id: 'standard' }, context, {})
    );
  };
}

describe("driveStream: the wait-retry owns its attempt's cancellation", () => {
  it('aborts the retry attempt when the retry stream never opened (tryStream threw)', async () => {
    await withIsolatedRouter(
      { ...baseCfg, gdpval_builtin: { 'limited-model': 1000, 'healthy-model': 900 } },
      async (defaultExport) => {
        const mock = makeScriptedRegistry({
          'lim-provider/limited-model': rateLimitTestModel('lim-provider', 'limited-model'),
          'ok-provider/healthy-model': rateLimitTestModel('ok-provider', 'healthy-model'),
        });
        mock.scripts['lim-provider/limited-model'] = [
          scripted(rateLimitErrorEvents(Date.now() + 1_500)),
          // The retry's tryStream throws → retryTarget null → the attempt
          // must be abandoned, not left running in the background.
          () => {
            throw new Error('bridge exploded on retry');
          },
        ];
        mock.scripts['ok-provider/healthy-model'] = [scripted(healthyEvents('healthy served'))];

        const turn = await openSession(defaultExport, mock.registry);
        const events = await turn();
        const text = joinedText(events as any);

        expect(text).toContain('healthy served');
        // The throw was already handled by the retry's own catch — a
        // null-deref through the abandoned target (mutant: `if (true)`)
        // would surface as a spurious "— error:" narration.
        expect(text).not.toMatch(/— error:/);
        const limCalls = mock.calls.filter((c) => c.ref === 'lim-provider/limited-model');
        expect(limCalls).toHaveLength(2);
        expect(limCalls[1].signal).toBeDefined();
        expect(limCalls[1].signal!.aborted).toBe(true);
      }
    );
  }, 30_000);

  it('does NOT abort a retry attempt that succeeded — its stream may carry tool results', async () => {
    await withIsolatedRouter(
      { ...baseCfg, gdpval_builtin: { 'limited-model': 1000, 'healthy-model': 900 } },
      async (defaultExport) => {
        const mock = makeScriptedRegistry({
          'lim-provider/limited-model': rateLimitTestModel('lim-provider', 'limited-model'),
          'ok-provider/healthy-model': rateLimitTestModel('ok-provider', 'healthy-model'),
        });
        mock.scripts['lim-provider/limited-model'] = [
          scripted(rateLimitErrorEvents(Date.now() + 1_500)),
          scripted(healthyEvents('served after wait')),
        ];
        mock.scripts['ok-provider/healthy-model'] = [scripted(healthyEvents('SHOULD NOT SERVE'))];

        const turn = await openSession(defaultExport, mock.registry);
        const events = await turn();

        expect(joinedText(events as any)).toContain('served after wait');
        const limCalls = mock.calls.filter((c) => c.ref === 'lim-provider/limited-model');
        expect(limCalls[1].signal).toBeDefined();
        // Aborting the winner kills claude-bridge's SDK query for the tool
        // loop (openCandidateAttempt's own doc) — the retry must stay live.
        expect(limCalls[1].signal!.aborted).toBe(false);
        expect(mock.calls.map((c) => c.ref)).not.toContain('ok-provider/healthy-model');
      }
    );
  }, 30_000);

  it('aborts a timed-out retry attempt (its late events must not leak)', async () => {
    await withIsolatedRouter(
      {
        ...baseCfg,
        gdpval_builtin: { 'limited-model': 1000, 'healthy-model': 900 },
        empty_response_timeout_ms: 300,
        reasoning_empty_response_timeout_ms: 300,
      },
      async (defaultExport) => {
        const mock = makeScriptedRegistry({
          'lim-provider/limited-model': rateLimitTestModel('lim-provider', 'limited-model'),
          'ok-provider/healthy-model': rateLimitTestModel('ok-provider', 'healthy-model'),
        });
        mock.scripts['lim-provider/limited-model'] = [
          scripted(rateLimitErrorEvents(Date.now() + 1_500)),
          silentUntilAborted,
        ];
        mock.scripts['ok-provider/healthy-model'] = [scripted(healthyEvents('healthy served'))];

        const turn = await openSession(defaultExport, mock.registry);
        const events = await turn();
        const text = joinedText(events as any);

        // The retry timed out, the walk said so and cascaded …
        expect(text).toContain('still failing after waiting (empty_timeout)');
        expect(text).toContain('healthy served');
        // … the still-running retry stream was cancelled (no background
        // token burn), and its late content never reached the output.
        const limCalls = mock.calls.filter((c) => c.ref === 'lim-provider/limited-model');
        expect(limCalls[1].signal!.aborted).toBe(true);
        expect(text).not.toContain('LATE GHOST TEXT');
      }
    );
  }, 30_000);

  it('an aborted retry stops the walk — no failure record, no cascade', async () => {
    await withIsolatedRouter(
      {
        ...baseCfg,
        gdpval_builtin: { 'limited-model': 1000, 'healthy-model': 900 },
        // Short first-level backoff: the rate-limit cooldown must be expired
        // by turn 2, so a SOFT cooldown the mutant arms on the aborted retry
        // (recordStreamFailure → 30 s soft backoff) is the only thing that
        // could still block the model.
        backoff_minutes: [0.01, 1],
      },
      async (defaultExport) => {
        const mock = makeScriptedRegistry({
          'lim-provider/limited-model': rateLimitTestModel('lim-provider', 'limited-model'),
          'ok-provider/healthy-model': rateLimitTestModel('ok-provider', 'healthy-model'),
        });
        mock.scripts['lim-provider/limited-model'] = [
          rateLimitNearReset,
          // The user aborted while the retry streamed — the structured event
          // shape the proxy normalizes cancellation to.
          scripted([{ type: 'error', reason: 'aborted', error: { stopReason: 'aborted' } } as any]),
        ];
        mock.scripts['ok-provider/healthy-model'] = [scripted(healthyEvents('SHOULD NOT SERVE'))];

        const turn = await openSession(defaultExport, mock.registry);
        const events = await turn();
        const text = joinedText(events as any);

        // An abort is not a model failure: no "still failing" narration …
        expect(text).not.toContain('still failing');
        // … and no further candidate is attempted after the user said stop.
        expect(mock.calls.map((c) => c.ref)).not.toContain('ok-provider/healthy-model');

        // And it leaves no cooldown either: the next turn attempts the model
        // again (cyclic scripts replay rate-limit → aborted). A fall-through
        // to recordStreamFailure (the mutant) arms the 30 s soft backoff and
        // the cloud model would carry this turn instead.
        await turn();
        const limCalls = mock.calls.filter((c) => c.ref === 'lim-provider/limited-model');
        expect(limCalls.length).toBeGreaterThanOrEqual(4);
        expect(mock.calls.map((c) => c.ref)).not.toContain('ok-provider/healthy-model');
      }
    );
  }, 30_000);
});

describe('driveStream: a successful retry resets the backoff escalation (recordOk)', () => {
  it('a third rate limit starts at escalation level 1, not 2', async () => {
    await withIsolatedRouter(
      {
        ...baseCfg,
        gdpval_builtin: { 'limited-model': 1000, 'healthy-model': 900 },
        // First hit backs off 600 ms (expired long before the next turn),
        // the ESCALATED hit backs off a full minute — the divergence the
        // recordOk reset is observable through.
        backoff_minutes: [0.01, 1],
      },
      async (defaultExport) => {
        const mock = makeScriptedRegistry({
          'lim-provider/limited-model': rateLimitTestModel('lim-provider', 'limited-model'),
          'ok-provider/healthy-model': rateLimitTestModel('ok-provider', 'healthy-model'),
        });
        // Cyclic: every turn hits the rate limit first, recovers on the retry.
        mock.scripts['lim-provider/limited-model'] = [
          rateLimitNearReset,
          scripted(healthyEvents('served after wait')),
        ];
        mock.scripts['ok-provider/healthy-model'] = [scripted(healthyEvents('cloud fallback'))];

        // Turns 1 and 2 behave identically either way: rate limit near reset
        // (600 ms backoff, expired before the next turn), wait, retry serves,
        // recordOk. The difference is the HITS counter the second rate limit
        // escalates from.
        const turn = await openSession(defaultExport, mock.registry);
        const first = await turn();
        expect(joinedText(first as any)).toContain('served after wait');
        const second = await turn();
        expect(joinedText(second as any)).toContain('served after wait');
        const third = await turn();

        // Turn 3 is where the paths split. Pristine — turn 2's recordOk reset
        // the hits counter, so turn 3's rate limit is a level-1 hit (600 ms
        // backoff): the model is attempted, waits, and the retry serves.
        // Mutant (recordOk dropped) — hits never reset, turn 3's rate limit
        // is a level-2 hit (60 s backoff): the model sits out the turn on
        // the escalated cooldown and the cloud model carries it.
        const text3 = joinedText(third as any);
        expect(text3).toContain('served after wait');
        expect(text3).not.toContain('backing off 60s');
        expect(mock.calls.map((c) => c.ref)).not.toContain('ok-provider/healthy-model');
      }
    );
  }, 45_000);
});

describe('driveStream: the wait-retry releases a LOCAL concurrency slot', () => {
  it('a local model that recovers on the retry serves the NEXT turn too', async () => {
    await withIsolatedRouter(
      {
        ...baseCfg,
        gdpval_builtin: { 'local-model:latest': 1000, 'healthy-model': 900 },
        // Cap 2, not 1: the MAIN attempt's slot is released only in the main
        // finally — AFTER the wait block — so the retry needs the second slot
        // (the walk's own design: a retrying local model holds both).
        // The local-slot cap (ollama_max_concurrent_streams) applies to ALL
        // local providers — lm-studio included (stream-proxy's localStreamLimit).
        ollama_max_concurrent_streams: 2,
        // Short first-level backoff: turn 2 must attempt the local model
        // again, not sit out the default 60 s cooldown.
        backoff_minutes: [0.01, 1],
      },
      async (defaultExport) => {
        // lm-studio, not ollama: local providers get the concurrency slot
        // too (PROVIDER_MAP), and the ollamaMockFiles ratchet forbids a new
        // file mocking ollama-utils — the daemon guard never fires for
        // lm-studio refs anyway.
        const localModel = {
          provider: 'lm-studio',
          id: 'local-model',
          api: 'openai-completions',
          contextWindow: 1_000_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
        const mock = makeScriptedRegistry({
          'lm-studio/local-model': localModel,
          'ok-provider/healthy-model': rateLimitTestModel('ok-provider', 'healthy-model'),
        });
        mock.scripts['lm-studio/local-model'] = [
          rateLimitNearReset,
          scripted(healthyEvents('local served after wait')),
        ];
        mock.scripts['ok-provider/healthy-model'] = [scripted(healthyEvents('cloud fallback'))];

        const turn = await openSession(defaultExport, mock.registry);
        const first = await turn();
        expect(joinedText(first as any)).toContain('local served after wait');

        // Second turn: the local model's slot was released by the retry's
        // finally — with a leaked slot (cap 1) this turn would be refused
        // with local_concurrency_limit and fall to the cloud model.
        const second = await turn();
        expect(joinedText(second as any)).toContain('local served after wait');
        expect(mock.calls.map((c) => c.ref)).not.toContain('ok-provider/healthy-model');
      }
    );
  }, 30_000);
});
