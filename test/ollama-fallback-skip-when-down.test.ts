// test/ollama-fallback-skip-when-down.test.ts
// Regression test for a 2026-10-03 live finding: with the Ollama
// daemon intentionally shut down, every driveStream fallback cascade burned a
// live "Connection error" attempt per ollama/* candidate (6 attempts across
// the session) before reaching the next usable model — the availability
// probe (ollama-utils.isOllamaAvailable) already knew the daemon was down.
//
// The fix: driveStream skips ollama/* candidates when the availability probe
// says the daemon is down, instead of opening doomed streams.

import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';

import {
  drainStream,
  makeExtensionContext,
  parkStateFiles,
  routerStatePaths,
} from './helpers/extension-harness.ts';
import { writeNoOpScanCache, flushBackgroundScan } from './helpers/noop-scan-cache.ts';
import { doneEvent, testModelCost } from './helpers/stream-fixtures.ts';
import { bootProjectDir, teardownBoot } from './helpers/router-env.ts';

const { dynamicConfigPath, scanCachePath } = routerStatePaths();

vi.mock('../src/ollama-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ollama-utils.ts')>();
  return { ...actual, isOllamaAvailable: vi.fn() };
});

async function withIsolatedRouter(
  configOverride: Record<string, unknown>,
  fn: (defaultExport: any, tmpDir: string) => Promise<void>
) {
  const { tmpDir, cwdSpy } = bootProjectDir(configOverride, 'router-ollama-down-');

  const restoreState = parkStateFiles([dynamicConfigPath, scanCachePath]);

  writeNoOpScanCache(scanCachePath);

  try {
    vi.resetModules();
    const mod = await import('../index.ts');
    await fn(mod.default as any, tmpDir);
  } finally {
    teardownBoot({ cwdSpy, tmpDir, restoreState });
  }
}

// One ollama-local and one remote model in the group — the ollama ref is the
// FIRST candidate so the probe guard is what protects the cascade latency.
const localModel = {
  provider: 'ollama',
  id: 'local-model:latest',
  api: 'openai-completions',
  contextWindow: 1_000_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const remoteModel = {
  provider: 'healthy-provider',
  id: 'healthy-model',
  api: 'openai-completions',
  contextWindow: 1_000_000,
  cost: testModelCost(),
};

const context: any = { messages: [{ role: 'user', content: 'do the thing' }] };

describe('driveStream: ollama availability guard', () => {
  it('skips ollama/* candidates without a stream attempt when the daemon is down', async () => {
    const { isOllamaAvailable } = await import('../src/ollama-utils.ts');
    vi.mocked(isOllamaAvailable).mockResolvedValue(false);

    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        gdpval_builtin: { 'local-model:latest': 900, 'healthy-model': 900 },
      },
      async (defaultExport) => {
        const { ctx: pi, onHandlers } = makeExtensionContext();
        defaultExport(pi);

        const streamSimple = vi.fn((model: any) => {
          if (model.provider === 'ollama') {
            // The doomed real-world attempt: connection refused.
            return (async function* () {
              yield { type: 'error', error: { errorMessage: 'Connection error.' } };
            })();
          }
          return (async function* () {
            yield { type: 'text_delta', delta: 'served by the remote model' };
            yield doneEvent();
          })();
        });
        const modelRegistry = {
          getAvailable: () => [localModel, remoteModel],
          find: (provider: string, modelId: string) =>
            provider === 'ollama' && modelId === localModel.id
              ? localModel
              : provider === remoteModel.provider && modelId === remoteModel.id
                ? remoteModel
                : null,
          getApiKeyForProvider: async (provider: string) =>
            provider === 'healthy-provider' ? 'sk-test' : null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

        // The remote model served the turn…
        expect(
          events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta)
            .join('')
        ).toContain('served by the remote model');
        // …and the down daemon's models were never opened at all.
        const called = streamSimple.mock.calls.map((c: any[]) => c[0].id);
        expect(called).not.toContain('local-model:latest');
        expect(called).toContain('healthy-model');
      }
    );
  }, 30000);

  it('still tries ollama/* candidates when the daemon is up (guard must not over-block)', async () => {
    const { isOllamaAvailable } = await import('../src/ollama-utils.ts');
    vi.mocked(isOllamaAvailable).mockResolvedValue(true);

    await withIsolatedRouter(
      {
        free_models: [],
        providers: { openrouter: { free_models: [] } },
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        gdpval_builtin: { 'local-model:latest': 900, 'healthy-model': 900 },
      },
      async (defaultExport) => {
        const { ctx: pi, onHandlers } = makeExtensionContext();
        defaultExport(pi);

        const streamSimple = vi.fn((model: any) => {
          if (model.provider === 'ollama') {
            return (async function* () {
              yield { type: 'text_delta', delta: 'served by the local model' };
              yield doneEvent();
            })();
          }
          return (async function* () {
            yield { type: 'text_delta', delta: 'must not be reached' };
            yield doneEvent();
          })();
        });
        const modelRegistry = {
          getAvailable: () => [localModel, remoteModel],
          find: (provider: string, modelId: string) =>
            provider === 'ollama' && modelId === localModel.id
              ? localModel
              : provider === remoteModel.provider && modelId === remoteModel.id
                ? remoteModel
                : null,
          getApiKeyForProvider: async (provider: string) =>
            provider === 'healthy-provider' ? 'sk-test' : null,
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const groupModel = { provider: 'standard', id: 'standard' };
        const events = await drainStream(defaultExport.groupStream(groupModel, context, {}));

        expect(
          events
            .filter((e: any) => e.type === 'text_delta')
            .map((e: any) => e.delta)
            .join('')
        ).toContain('served by the local model');
        expect(streamSimple.mock.calls.map((c: any[]) => c[0].id)).toContain('local-model:latest');
      }
    );
  }, 30000);
});
