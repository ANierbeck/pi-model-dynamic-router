// test/helpers/rate-limit-fixtures.ts
// Shared fixtures for the wait-retry test family (rate-limit-wait.test.ts
// pinned the first half of the block, rate-limit-retry-abort.test.ts the
// abort/slot half). Extracted when the second file's copies of the mock
// registry and base config tripped the repeatedBlocks ratchet — the two
// files are deliberately near-identical fixtures, so the shared parts live
// here once.
//
// Differences from rate-limit-wait.test.ts's local (baselined) copies:
// every call's AbortSignal is recorded (the abort-slot tests inspect it)
// and scripts replay CYCLICALLY (a rate-limit → healthy pattern must stay
// "near reset" on every turn — a reset baked at setup time is stale by the
// next turn and the walk cascades instead of waiting).

import { vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';

import { testModelCost } from './stream-fixtures.ts';

export type StreamScript = (
  signal: AbortSignal | undefined
) => AsyncIterable<AssistantMessageEvent>;

export interface ScriptedCall {
  ref: string;
  signal: AbortSignal | undefined;
}

/** Mock registry: each model serves its script (cyclically by call index). */
export function makeScriptedRegistry(modelsByRef: Record<string, any>) {
  const calls: ScriptedCall[] = [];
  const scripts: Record<string, StreamScript[]> = {};
  const modelList = Object.entries(modelsByRef).map(([ref, model]) => ({ ref, model }));

  const streamSimple = vi.fn((model: any, _context: any, options: any) => {
    const ref = modelList.find((e) => e.model.id === model.id)!.ref;
    const signal: AbortSignal | undefined = options?.signal;
    calls.push({ ref, signal });
    const script = scripts[ref] ?? [];
    const idx = calls.filter((c) => c.ref === ref).length - 1;
    // Cyclic: a model with [rateLimit, healthy] replays the whole pattern on
    // every turn — the shape the two-turn cooldown tests need.
    const run = script.length ? script[idx % script.length] : undefined;
    return run ? run(signal) : (async function* () {})();
  });

  const registry = {
    getAvailable: () => modelList.map((e) => e.model),
    find: (provider: string, modelId: string) => modelsByRef[`${provider}/${modelId}`] ?? null,
    getApiKeyForProvider: async () => 'k',
    runtime: { streamSimple },
  };
  return { calls, scripts, registry };
}

/** The cloud-model shape the wait-retry fixtures use. */
export function rateLimitTestModel(provider: string, id: string) {
  return { provider, id, api: `${provider}-api`, contextWindow: 1_000_000, cost: testModelCost() };
}

export function formatResetAt(resetAtMs: number): string {
  return new Date(resetAtMs).toLocaleString('de-DE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Europe/Berlin',
    timeZoneName: 'short',
  });
}

export function rateLimitErrorEvents(resetAtMs: number): AssistantMessageEvent[] {
  return [
    {
      type: 'error',
      reason: 'error',
      error: {
        message: `Warning: rate limit exceeded (tpm) — resets at ${formatResetAt(resetAtMs)}`,
      },
    } as any,
  ];
}

export function healthyEvents(text: string): AssistantMessageEvent[] {
  return [
    {
      type: 'text_delta',
      contentIndex: 0,
      delta: text,
      partial: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' },
    } as any,
    {
      type: 'done',
      reason: 'stop',
      message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' },
    } as any,
  ];
}

export const scripted =
  (events: AssistantMessageEvent[]): StreamScript =>
  () =>
    (async function* () {
      for (const ev of events) yield ev;
    })();

/**
 * Rate limit with a reset 1.5 s in the future — computed per INVOCATION, so
 * a cyclic script stays "near reset" on every turn (a reset baked at setup
 * time is stale by the next turn and the walk cascades instead of waiting).
 */
export const rateLimitNearReset: StreamScript = () =>
  (async function* () {
    for (const ev of rateLimitErrorEvents(Date.now() + 1_500)) yield ev;
  })();

// No rate_limit_wait_max_ms here: the shipped default (router-defaults.yaml)
// is 120 s; tests that need the bounded wait set it explicitly — including the
// retry-abort file, whose 4 s cap keeps the fixtures fast.
export const rateLimitBaseCfg = {
  free_models: [],
  providers: { openrouter: { free_models: [] } },
  model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
  empty_response_timeout_ms: 5_000,
  reasoning_empty_response_timeout_ms: 5_000,
  stall_timeout_ms: 30_000,
};
