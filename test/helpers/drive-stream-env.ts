// Shared fixtures for tests that drive the router's groupStream end to end
// against a stubbed model registry (provider-breaker-orchestration, the
// slice-2 mutation pins): an isolated tmp project, cloud model stubs and the
// canned upstream streams.

import { vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';

import path from 'node:path';
import { makeExtensionContext, startSession } from './extension-harness.ts';
import { writeNoOpScanCache, removeNoOpScanCacheDefault } from './noop-scan-cache.ts';
import { doneEvent, testModelCost } from './stream-fixtures.ts';
import { bootProjectDir, rmTmpDir } from './router-env.ts';

export function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export async function drainStream(
  stream: AsyncIterable<AssistantMessageEvent>
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

/**
 * Boots the extension in an isolated tmp project (own router-config.json,
 * no-op scan cache, stubbed model registry) and hands the caller the
 * defaultExport plus the captured session_start handler wiring. Mirrors the
 * harness of test/provider-watchdog-integration.test.ts.
 */
export async function withIsolatedRouter(
  configOverride: Record<string, unknown>,
  models: unknown[],
  fn: (helpers: {
    groupStream: (model: any, context: any, options: any) => AsyncIterable<AssistantMessageEvent>;
    streamSimple: ReturnType<typeof vi.fn>;
  }) => Promise<void>
): Promise<void> {
  const scanCachePath = path.join(process.env.PI_ROUTER_STATE_DIR!, '.cache', 'scan-cache.json');
  const { tmpDir, cwdSpy } = bootProjectDir(configOverride, 'router-breaker-orch-');
  writeNoOpScanCache(scanCachePath);
  try {
    vi.resetModules();
    const mod = await import('../../index.ts');
    const defaultExport: any = mod.default;
    const { ctx: pi, onHandlers } = makeExtensionContext();
    defaultExport(pi);
    const streamSimple = vi.fn();
    const modelRegistry = {
      getAvailable: () => models,
      find: (provider: string, id: string) =>
        models.find((m: any) => m.provider === provider && m.id === id) ?? null,
      getApiKeyForProvider: async () => 'k',
      runtime: { streamSimple },
    };
    await startSession(onHandlers, { modelRegistry, cwd: tmpDir });

    await fn({
      groupStream: (model: any, context: any, options: any) =>
        defaultExport.groupStream(model, context, options) as AsyncIterable<AssistantMessageEvent>,
      streamSimple,
    });
  } finally {
    cwdSpy.mockRestore();
    removeNoOpScanCacheDefault();
    rmTmpDir(tmpDir);
  }
}

/** Model stub for the registry: cloud provider, large context, paid pricing. */
export function cloudModel(provider: string, id: string) {
  return {
    provider,
    id,
    api: 'openai-completions',
    contextWindow: 1_000_000,
    cost: testModelCost(),
  };
}

export const BASE_CONFIG = {
  free_models: [],
  rate_limit_wait_max_ms: 0,
  model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
};

/** Streams: empty (stopReason stop, 0 chars), error event, success. */
export const emptyStream = () =>
  (async function* () {
    yield doneEvent();
  })();
export const errorStream = (message: string) =>
  (async function* () {
    yield { type: 'error', error: { errorMessage: message } };
  })();
export const successStream = (text: string) =>
  (async function* () {
    yield { type: 'text_delta', delta: text };
    yield doneEvent();
  })();

export function streamText(events: AssistantMessageEvent[]): string {
  return events
    .filter((e: any) => e.type === 'text_delta')
    .map((e: any) => e.delta ?? '')
    .join('');
}

/** Full text of the terminal error event(s): the failure-line block (content) plus the short message. */
export function streamErrorText(events: AssistantMessageEvent[]): string {
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
