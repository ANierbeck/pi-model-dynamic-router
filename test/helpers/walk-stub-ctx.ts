// test/helpers/walk-stub-ctx.ts
// Shared WALK-LEVEL harness for stream-orchestrator tests: the real
// driveStream walk over explicit candidates with a stub context, so the
// candidate ORDER is part of the fixture (the full-stack groupStream harness
// sorts cost-0 local models to the front of the pool). Extracted from the
// mutation slice-2/3 test round when the third copy of the stub tripped the
// repeatedBlocks ratchet.
//
// The logger must stay mocked per test FILE (vi.mock is hoisted per file) —
// importing this helper does not mock anything by itself.

import { vi } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { StreamOrchestrator } from '../../src/stream-orchestrator.ts';

export interface WalkAttempt {
  ref: string;
  signal: AbortSignal | undefined;
}

export interface WalkStubConfig {
  /** consumeWithDetection result per ref; '*' is the fallback. Default ok. */
  results?: Record<string, unknown>;
  /** Custom consume result factory; wins over `results`. */
  consume?: (ref: string) => unknown;
  /** Refs whose provider breaker is open (pre-flight skip). */
  breakerOpen?: string[];
  /** Extra/overriding ctx fields (cache, observeProviderFailure, …). */
  ctxOverrides?: Record<string, unknown>;
}

export interface WalkWorld {
  ctx: any;
  attempts: WalkAttempt[];
  run: (candidates: string[], options?: unknown) => Promise<{ text: string; events: unknown[] }>;
}

export function walkStubWorld(config: WalkStubConfig = {}): WalkWorld {
  const attempts: WalkAttempt[] = [];
  const ctx: any = {
    cfg: { model_groups: { standard: { method: 'best' } }, model_metrics: {}, providers: {} },
    cache: {},
    router: { setActiveGroup: vi.fn(), setCurModel: vi.fn() },
    escalation: { level: 'standard' },
    resolve: () => null,
    estimateContextTokens: () => 100,
    tryStream: vi.fn(async (ref: string, _context: any, options: any) => {
      attempts.push({ ref, signal: options?.signal });
      return { stream: (async function* () {})() };
    }),
    consumeWithDetection: vi.fn(
      async (_stream: any, _proxy: any, _empty: number, _stall: number, ref: string) => {
        if (config.consume) return await config.consume(ref);
        const results = (config.results ?? {}) as Record<string, any>;
        return results[ref] ?? results['*'] ?? { ok: true };
      }
    ),
    recordStreamFailure: vi.fn(),
    recordOk: vi.fn(),
    observeFailure: vi.fn(),
    observeProviderFailure: vi.fn(() => false),
    isLimited: () => false,
    clearLimit: vi.fn(),
    isBreakerOpen: (ref: string) => (config.breakerOpen ?? []).includes(ref),
    noteBreakerSkip: vi.fn(),
    getModelContextWindow: () => 1_000_000,
    updateModelContextWindow: vi.fn(),
    getEmptyResponseTimeout: () => 60_000,
    getStallTimeout: () => 60_000,
    getRateLimitWaitMaxMs: () => 0,
    formatResetMsg: () => '',
    releaseLocalSlot: vi.fn(),
    // M3: the walk books each finished stream's duration into the turn.
    addTurnStreamMs: vi.fn(),
    wedgeCooldownText: () => '2 min',
    limitFreeDayCap: () => false,
    lookupGdp: () => null,
    lastDynamicModel: '',
    sessionCtx: undefined,
    ...(config.ctxOverrides ?? {}),
  };
  const orch = new StreamOrchestrator(ctx);
  const run = async (candidates: string[], options?: unknown) => {
    const proxy = createAssistantMessageEventStream();
    const events: any[] = [];
    const done = (async () => {
      for await (const ev of proxy) events.push(ev);
    })();
    await orch.driveStream(
      proxy,
      candidates,
      { messages: [] } as any,
      (options ?? undefined) as any,
      undefined,
      'standard'
    );
    // driveStream returned, but the proxy needs its terminal event drained;
    // the success/aggregate paths pushed one already.
    await Promise.race([done, new Promise((r) => setTimeout(r, 500))]);
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => e.delta ?? '')
      .join('');
    return { text, events };
  };
  return { ctx, attempts, run };
}
