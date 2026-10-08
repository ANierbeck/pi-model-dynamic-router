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
import os from 'node:os';
import path from 'node:path';
import {
  writeNoOpScanCache,
  removeNoOpScanCache,
  flushBackgroundScan,
} from './helpers/noop-scan-cache.ts';

const dynamicConfigPath = path.join(process.env.PI_ROUTER_STATE_DIR!, 'router-config.dynamic.json');
const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');

async function drainStream(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
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
  const scripts: Record<string, AssistantMessageEvent[][]> = {};
  const entries = Object.entries(modelsByRef).map(([ref, m]) => ({ ref, model: m }));

  const streamSimple = vi.fn((model: any) => {
    const found = entries.find((e) => e.model.id === model.id)!;
    calls.push(found.ref);
    const script = scripts[found.ref] ?? [];
    const idx = calls.filter((c) => c === found.ref).length - 1;
    const events = idx < script.length ? script[idx] : script[script.length - 1] ?? [];
    return (async function* () {
      for (const ev of events) yield ev;
    })();
  });

  return {
    calls,
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
    { type: 'done', reason: 'length' } as any,
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
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
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
async function driveCollapseScenario(
  retryEvents: () => AssistantMessageEvent[],
  assert: (helpers: { text: string; errText: string; calls: string[] }) => void
): Promise<void> {
  const cfg = {
    ...baseCfg,
    gdpval_builtin: { 'lim-model': 1000, 'sec-model': 900 },
    rate_limit_wait_max_ms: 4_000,
    backoff_minutes: [0.02, 0.04],
    soft_backoff_ms: [1000, 2000],
  };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-collapse-narr-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(cfg));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const hadDyn = fs.existsSync(dynamicConfigPath);
  const hadCache = fs.existsSync(scanCachePath);
  if (hadDyn) fs.renameSync(dynamicConfigPath, `${dynamicConfigPath}.bak`);
  if (hadCache) fs.renameSync(scanCachePath, `${scanCachePath}.bak`);
  writeNoOpScanCache(scanCachePath);

  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    const defaultExport: any = mod.default;
    const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};
    const pi: any = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerProvider: vi.fn(),
      setModel: vi.fn(async () => true),
      on: vi.fn((event: string, handler: any) => {
        onHandlers[event] = handler;
      }),
    };
    defaultExport(pi);

    const mock = makeScriptedRegistry({
      'lim-provider/lim-model': cloudModel('lim-provider', 'lim-model'),
      'sec-provider/sec-model': cloudModel('sec-provider', 'sec-model'),
    });
    // First call of BOTH models: reset-free rate-limit error. Every later
    // call (the collapse retry) serves the scenario's retry script.
    mock.scripts['lim-provider/lim-model'] = [rateLimitNoResetEvents(), retryEvents()];
    mock.scripts['sec-provider/sec-model'] = [rateLimitNoResetEvents(), retryEvents()];

    const ctx: any = { modelRegistry: mock.registry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
    await onHandlers['session_start']?.({}, ctx);
    await flushBackgroundScan();

    const events = await drainStream(
      defaultExport.groupStream(
        { provider: 'standard', id: 'standard' },
        { messages: [{ role: 'user', content: 'do work' }] },
        {}
      )
    );

    assert({ text: allText(events), errText: streamErrorText(events), calls: mock.calls });
  } finally {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (hadDyn) fs.renameSync(`${dynamicConfigPath}.bak`, dynamicConfigPath);
    removeNoOpScanCache(scanCachePath);
    if (hadCache) fs.renameSync(`${scanCachePath}.bak`, scanCachePath);
  }
}

describe('cooldown-collapse: retried-result narrations (B3 / mutation R3)', () => {
  it(
    'collapse WAITS for the shortest cooldown and narrates a truncated_length retry',
    async () => {
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
    },
    30_000
  );

  it(
    'narrates a repetition_loop retry as "stuck in a repetition loop"',
    async () => {
      await driveCollapseScenario(repetitionEvents, ({ text, errText }) => {
        expect(text).toContain('All models in cooldown — waiting');
        expect(text).toContain('stuck in a repetition loop');
        // The repetition-side narration, not the truncation one.
        expect(text).not.toContain('output truncated at max tokens');
        expect(errText).toContain('candidate(s) failed');
      });
    },
    30_000
  );

  it(
    'a rate_limit_exceeded retry does NOT print the repetition/truncation narration',
    async () => {
      await driveCollapseScenario(rateLimitNoResetEvents, ({ text, errText }) => {
        expect(text).toContain('All models in cooldown — waiting');
        // The else branch owns rate-limit retries — the repetition/
        // truncation narration block must not fire for them.
        expect(text).not.toContain('output truncated at max tokens');
        expect(text).not.toContain('stuck in a repetition loop');
        expect(errText).toContain('candidate(s) failed');
      });
    },
    30_000
  );
});
