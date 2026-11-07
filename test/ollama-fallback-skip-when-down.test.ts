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
import { walkStubWorld } from './helpers/walk-stub-ctx.ts';

const { dynamicConfigPath, scanCachePath } = routerStatePaths();

vi.mock('../src/ollama-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ollama-utils.ts')>();
  // isOllamaProbablyDown feeds the walk's LOOKAHEAD guard (the "trying X …"
  // suffix must not name a candidate the walk would skip); pinned true so
  // the guard is deterministic. The existing tests below never read it.
  return { ...actual, isOllamaAvailable: vi.fn(), isOllamaProbablyDown: vi.fn(() => true) };
});

// The walk-level lookahead tests below drive the orchestrator directly;
// without this the narrations' routerLog calls would append to the real
// project log (the full-stack tests above boot a tmp project instead).
vi.mock('../src/logger.ts', async (orig) => {
  const actual = await orig<typeof import('../src/logger.ts')>();
  return {
    ...actual,
    appendRawLog: vi.fn(),
    routerLog: vi.fn(),
    warnLog: vi.fn(),
    errorLog: vi.fn(),
  };
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

  it('names the availability probe as the skip reason in the aggregate', async () => {
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

        // The remote candidate fails too, so the turn ends in the aggregate
        // failure block — where the skipped local candidate's reason shows.
        const streamSimple = vi.fn(() =>
          Promise.resolve(
            (async function* () {
              yield { type: 'error', error: { errorMessage: '500 upstream down' } };
            })()
          )
        );
        const modelRegistry = {
          getAvailable: () => [localModel, remoteModel],
          find: (provider: string, modelId: string) =>
            provider === localModel.provider && modelId === localModel.id
              ? localModel
              : provider === remoteModel.provider && modelId === remoteModel.id
                ? remoteModel
                : null,
          getApiKeyForProvider: async () => 'sk-test',
          runtime: { streamSimple },
        };
        const ctx: any = { modelRegistry, cwd: os.tmpdir(), ui: { setFooter: vi.fn() } };
        await onHandlers['session_start']?.({}, ctx);
        await flushBackgroundScan();

        const events = await drainStream(
          defaultExport.groupStream({ provider: 'standard', id: 'standard' }, context, {})
        );
        const errText = events
          .filter((e: any) => e.type === 'error')
          .map((e: any) =>
            Array.isArray(e.error?.content)
              ? e.error.content.map((c: any) => String(c?.text ?? '')).join('')
              : ''
          )
          .join('\n');

        expect(errText).toContain('skipped, ollama daemon unavailable (availability probe)');
        expect(streamSimple.mock.calls.map((c: any[]) => c[0].id)).not.toContain(
          'local-model:latest'
        );
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

// ─────────────────────────────────────────────────────────────────────────────
// Mutation slice 2 batch 4 (docs/mutation-data/slice2-triage/pre.md cluster D):
// the LOOKAHEAD guards of the "trying X …" narration suffix. The suffix names
// the next candidate the walk will REALLY attempt, so it must apply the walk's
// own pre-flight predicates — a breaker-open provider or a down ollama daemon
// must not be announced (live finding 2026-10-03). Walk-level harness: the
// candidate order is part of the fixture (the full-stack pool sorts cost-0
// ollama models to the front, which is exactly the order this must NOT have).
// These tests live HERE because the ollamaMockFiles ratchet forbids a new
// file that mocks ollama-utils, and the lookahead guard needs the daemon
// probe pinned to "down".

describe('narration lookahead: the suffix names a ref the walk will REALLY try', () => {
  it('skips a breaker-open provider and a down ollama daemon', async () => {
    // The full-stack tests above share this file's mock instances; pin the
    // probe state instead of inheriting whatever the last test left behind.
    const ollamaUtils: any = await import('../src/ollama-utils.ts');
    ollamaUtils.isOllamaAvailable.mockReset().mockReturnValue(false);
    ollamaUtils.isOllamaProbablyDown.mockReset().mockReturnValue(true);
    const w = walkStubWorld({
      results: {
        '*': { ok: false, reason: 'empty_response' },
        'c/two': { ok: true },
      },
      breakerOpen: ['wedge-provider/wedge'],
    });
    const { text } = await w.run(['a/one', 'wedge-provider/wedge', 'ollama/nemo:latest', 'c/two']);

    // The suffix names the ref that can actually serve next …
    expect(text).toMatch(/a\/one —[^]*?trying c\/two …/);
    // … not the wedged provider, not the dead daemon.
    expect(text).not.toContain('trying wedge-provider/wedge');
    expect(text).not.toContain('trying ollama/nemo');
    // And the walk attempted exactly the two attemptable refs.
    expect(w.attempts.map((a) => a.ref)).toEqual(['a/one', 'c/two']);
  });
});
