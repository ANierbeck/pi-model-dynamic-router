/**
 * Regression tests for two overflow-detection gaps found after v1.4.0:
 *
 * 1. estimateContextTokens() only counted string message content. Messages
 *    whose content is an ARRAY of blocks (tool_result, tool_use, image —
 *    the shape Pi actually uses for tool turns) were counted as 0 tokens.
 *    After a long session under a 1M-context model, switching to a smaller
 *    group (e.g. 256K mistral-medium-3.5) undercounted the real token count
 *    so badly that the pre-flight context-window guard in driveStream never
 *    fired — every candidate was tried, streamed for minutes, and never
 *    produced usable output (observed: 7+ minutes of silence on
 *    mistral-medium-3.5 after a 1M-model session).
 *
 * 2. Even when a candidate IS tried, some providers (Mistral) reject an
 *    oversized prompt by returning an error/text response rather than
 *    simply hanging. consumeWithDetection now recognises overflow patterns
 *    in that response and reports `reason: 'context_overflow'` instead of a
 *    generic soft failure, so driveStream can emit Pi's native overflow
 *    signal immediately instead of grinding through the rest of the
 *    candidate list.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRouterStateLock, releaseRouterStateLock, writeNoOpScanCache, removeNoOpScanCache, flushBackgroundScan } from './helpers/router-state-lock.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dynamicConfigPath = path.join(repoRoot, 'router-config.dynamic.json');
const scanCachePath = path.join(repoRoot, '.cache', 'scan-cache.json');

async function drainStream(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

async function withIsolatedRouter(
  configOverride: Record<string, unknown>,
  fn: (defaultExport: any, tmpDir: string) => Promise<void>
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-overflow2-'));
  fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify(configOverride));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const dynBak = `${dynamicConfigPath}.overflow2-bak`;
  const cacheBak = `${scanCachePath}.overflow2-bak`;
  // Held until the finally block restores both shared files — see
  // router-state-lock.ts for why this must span the whole test.
  await acquireRouterStateLock();
  const hadDyn = fs.existsSync(dynamicConfigPath);
  const hadCache = fs.existsSync(scanCachePath);
  if (hadDyn) fs.renameSync(dynamicConfigPath, dynBak);
  if (hadCache) fs.renameSync(scanCachePath, cacheBak);

  writeNoOpScanCache(scanCachePath); // make unawaited session_start scan() a no-op (root cause of the "No available models" CI flake)

  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    await fn(mod.default as any, tmpDir);
  } finally {
    cwdSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (hadDyn) fs.renameSync(dynBak, dynamicConfigPath);
    removeNoOpScanCache(scanCachePath);

    if (hadCache) fs.renameSync(cacheBak, scanCachePath);
    releaseRouterStateLock();
  }
}

describe('estimateContextTokens: array message content', () => {
  it('counts tokens in array-shaped content (tool_result blocks), not just strings', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      },
      async (defaultExport) => {
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

        // Small context window — must be skipped because the tool_result
        // block alone is well over 8K tokens (~40K chars / 4).
        const smallCtxModel = {
          provider: 'small-ctx-provider',
          id: 'claude-sonnet-4-6',
          api: 'small-api',
          contextWindow: 8_000,
        };
        const modelRegistry = {
          getAvailable: () => [smallCtxModel],
          find: () => smallCtxModel,
          getApiKeyForProvider: async () => null,
          runtime: { streamSimple: () => (async function* () {})() },
        };
        const ctx: any = { modelRegistry, cwd: '/tmp', ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
      await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        // Array-shaped content, as Pi sends for tool turns. The old
        // estimateContextTokens() treated this as '' (0 tokens) because it
        // only handled `typeof content === 'string'`.
        const context: any = {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'tool_result', text: 'x'.repeat(160_000) }, // ~40K tokens
              ],
            },
          ],
        };

        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));
        const errEvent = events.find((e: any) => e.type === 'error') as any;
        expect(errEvent).toBeDefined();
        // Must be the overflow signal, proving the guard actually fired on
        // the array content instead of silently treating it as empty.
        expect(errEvent.error.errorMessage).toMatch(/prompt is too long/i);
      }
    );
  });
});

describe('driveStream: runtime overflow detection (provider-reported)', () => {
  it('a provider rejecting the prompt as too large short-circuits to the native overflow signal', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      },
      async (defaultExport) => {
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

        // Large advertised context window, so the pre-flight guard does NOT
        // skip it — the provider itself is the one rejecting the prompt,
        // exactly like Mistral does for an oversized conversation.
        const model = {
          provider: 'mistral',
          id: 'mistral-medium-3.5',
          api: 'mistral-conversations',
          contextWindow: 262_144,
        };
        const streamSimple = vi.fn(() => {
          return (async function* () {
            yield {
              type: 'text_delta',
              delta: 'Prompt contains 300000 tokens, too large for model with 262144 maximum context length',
            };
            yield { type: 'done' };
          })();
        });
        const modelRegistry = {
          getAvailable: () => [model],
          find: () => model,
          getApiKeyForProvider: async () => 'fake-key',
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: '/tmp', ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
      await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'hi' }] };

        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));
        const errEvent = events.find((e: any) => e.type === 'error') as any;
        expect(errEvent).toBeDefined();
        expect(errEvent.error.errorMessage).toMatch(/prompt is too long/i);
        // Only tried once — short-circuited instead of exhausting other
        // candidates or hanging.
        expect(streamSimple).toHaveBeenCalledTimes(1);
      }
    );
  });

  it('normal empty responses are unaffected (no false-positive overflow detection)', async () => {
    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      },
      async (defaultExport) => {
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

        const model = {
          provider: 'mistral',
          id: 'mistral-medium-3.5',
          api: 'mistral-conversations',
          contextWindow: 262_144,
        };
        const streamSimple = vi.fn(() => (async function* () {})());
        const modelRegistry = {
          getAvailable: () => [model],
          find: () => model,
          getApiKeyForProvider: async () => 'fake-key',
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: '/tmp', ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
      await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'hi' }] };

        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));
        const errEvent = events.find((e: any) => e.type === 'error') as any;
        expect(errEvent).toBeDefined();
        expect(errEvent.error.errorMessage).toBeUndefined();
      }
    );
  });

  it('does not false-positive on legitimate assistant prose about context windows (roborev job 203)', async () => {
    // This router's own domain is context windows/compaction, so a real
    // response can legitimately contain broad phrases like "context window"
    // or "maximum context length" without being a provider rejection. Only
    // highly-specific provider rejection phrasings should trip detection.
    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
      },
      async (defaultExport) => {
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

        const model = {
          provider: 'mistral',
          id: 'mistral-medium-3.5',
          api: 'mistral-conversations',
          contextWindow: 262_144,
        };
        const streamSimple = vi.fn(() => {
          return (async function* () {
            yield {
              type: 'text_delta',
              delta:
                'This router adds a context window guard: it estimates the ' +
                'maximum context length before dispatching, and falls back to ' +
                'compaction if the conversation is too large.',
            };
            yield { type: 'done' };
          })();
        });
        const modelRegistry = {
          getAvailable: () => [model],
          find: () => model,
          getApiKeyForProvider: async () => 'fake-key',
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: '/tmp', ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
      await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const context: any = { messages: [{ role: 'user', content: 'hi' }] };

        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));
        const errEvent = events.find((e: any) => e.type === 'error') as any;
        // No overflow (or any) error — the legitimate response must pass
        // through untouched.
        expect(errEvent).toBeUndefined();
        const textEvents = events.filter((e: any) => e.type === 'text_delta');
        expect(textEvents.length).toBeGreaterThan(0);
      }
    );
  });
});
