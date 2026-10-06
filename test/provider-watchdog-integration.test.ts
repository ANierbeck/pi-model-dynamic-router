// test/provider-watchdog-integration.test.ts
// ADR-0016 wiring: the classifier and driveStream feed local timeouts to the
// watchdog, and skip the local provider while it is marked wedged.

import { describe, it, beforeEach, expect, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyPrompt } from '../src/content-classifier.js';
import * as ollamaUtils from '../src/ollama-utils';
import { isProviderWedged } from '../src/provider-watchdog.ts';
import type { Cache } from '../src/types.ts';
import { writeNoOpScanCache, removeNoOpScanCache, flushBackgroundScan } from './helpers/noop-scan-cache.ts';

vi.mock('../src/ollama-utils', () => ({
  callOllama: vi.fn(),
  isOllamaAvailable: vi.fn(async () => true),
  isOllamaProbablyDown: vi.fn(() => false),
}));

const callOllama = vi.mocked(ollamaUtils.callOllama);
const timeout = async (): Promise<string> => {
  throw new Error('The operation was aborted due to timeout');
};

describe('classifier feeds the local-provider watchdog', () => {
  beforeEach(() => {
    callOllama.mockReset();
  });

  it('skips Ollama entirely once primary and fallback both timed out', async () => {
    const cache: Cache = {};
    callOllama.mockImplementation(timeout);
    await classifyPrompt('watchdog classifier: first prompt about a refactor', {
      cache,
      model: 'primary-model',
      fallbackModel: 'fallback-model',
      allowStaticFallback: true,
    });
    expect(callOllama).toHaveBeenCalledTimes(2);
    expect(isProviderWedged(cache, 'ollama')).toBe(true);

    callOllama.mockClear();
    await classifyPrompt('watchdog classifier: second prompt about a refactor', {
      cache,
      model: 'primary-model',
      fallbackModel: 'fallback-model',
      allowStaticFallback: true,
    });
    expect(callOllama).not.toHaveBeenCalled();
  });

  it('one classifier timeout is recorded as breaker evidence but does not trip it', async () => {
    const cache: Cache = {};
    // The fallback fails with a non-timeout error, which is not evidence.
    callOllama.mockImplementationOnce(timeout).mockRejectedValueOnce(new Error('model not found'));
    await classifyPrompt('watchdog classifier: single slow model', {
      cache,
      model: 'primary-model',
      fallbackModel: 'fallback-model',
      allowStaticFallback: true,
    });
    expect(callOllama).toHaveBeenCalledTimes(2);
    expect(isProviderWedged(cache, 'ollama')).toBe(false);
    expect(Object.keys(cache.provider_breaker?.ollama?.evidence ?? {})).toEqual(['ollama/primary-model']);
  });

  it('two distinct classifier timeouts trip the breaker under provider_breaker', async () => {
    const cache: Cache = {};
    callOllama.mockImplementation(timeout);
    await classifyPrompt('watchdog classifier: two slow models', {
      cache,
      model: 'primary-model',
      fallbackModel: 'fallback-model',
      allowStaticFallback: true,
    });
    expect(isProviderWedged(cache, 'ollama')).toBe(true);
    expect(cache.provider_breaker?.ollama?.open_until).toBeGreaterThan(Date.now());
    expect(cache.provider_breaker?.ollama?.trip_count).toBe(1);
  });

  it('a successful local classification clears the evidence', async () => {
    const cache: Cache = {};
    callOllama.mockImplementationOnce(timeout).mockResolvedValueOnce(
      JSON.stringify({ category: 'code_simple', reason: 'x', confidence: 0.9 })
    );
    await classifyPrompt('watchdog classifier: primary slow, fallback fine', {
      cache,
      model: 'primary-model',
      fallbackModel: 'fallback-model',
    });
    expect(isProviderWedged(cache, 'ollama')).toBe(false);
    // The timeout left evidence; the fallback's success removed the whole entry.
    expect(cache.provider_breaker?.ollama).toBeUndefined();
  });
});

describe('driveStream feeds the local-provider watchdog', () => {
  it('after two local timeouts, skips the remaining local candidates and narrates the fix', async () => {
    const stateDir = process.env.PI_ROUTER_STATE_DIR!;
    const scanCachePath = path.join(stateDir, '.cache', 'scan-cache.json');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-watchdog-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({
        free_models: [],
        empty_response_timeout_ms: 100,
        reasoning_empty_response_timeout_ms: 100,
        model_groups: { standard: { fallback_groups: [], min_gdpval: 0 } },
        gdpval_builtin: { 'local-a': 1000, 'local-b': 990, 'local-c': 980, 'cloud-ok': 900 },
      })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
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

      const mk = (provider: string, id: string, price = 0) => ({
        provider, id, api: 'openai-completions', contextWindow: 1_000_000,
        cost: { input: price, output: price, cacheRead: 0, cacheWrite: 0 },
      });
      const models = [mk('ollama', 'local-a'), mk('ollama', 'local-b'), mk('ollama', 'local-c'), mk('healthy-provider', 'cloud-ok', 0.1)];
      const streamSimple = vi.fn((model: any) => {
        if (model.provider === 'ollama') {
          // Wedged daemon: accepts the request, never produces a token.
          return (async function* () {
            await new Promise((r) => setTimeout(r, 2_000));
          })();
        }
        return (async function* () {
          yield { type: 'text_delta', delta: 'cloud answered' };
          yield { type: 'done' };
        })();
      });
      const modelRegistry = {
        getAvailable: () => models,
        find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id) ?? null,
        getApiKeyForProvider: async () => 'k',
        runtime: { streamSimple },
      };
      const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };
      await onHandlers['session_start']?.({}, ctx);
      await flushBackgroundScan();

      const events: AssistantMessageEvent[] = [];
      for await (const ev of defaultExport.groupStream(
        { provider: 'standard', id: 'standard' },
        { messages: [{ role: 'user', content: 'do the thing' }] },
        {}
      )) events.push(ev);

      const text = events.filter((e: any) => e.type === 'text_delta').map((e: any) => e.delta).join('');
      expect(text).toContain('cloud answered');
      expect(text).toContain('ollama looks wedged');
      const called = streamSimple.mock.calls.map((c: any[]) => c[0].id);
      expect(called).toContain('local-a');
      expect(called).toContain('local-b');
      expect(called).not.toContain('local-c');
      // First open: the first ladder step, and wording that does not claim a model count.
      expect(text).toContain('Skipping ollama models for 2 min.');

      // Half-open re-probe fails shortly after the 2 min cooldown: ONE timeout
      // re-opens at the 5 min step, and the narration must say so.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 3 * 60_000);
      const reopenEvents: AssistantMessageEvent[] = [];
      for await (const ev of defaultExport.groupStream(
        { provider: 'standard', id: 'standard' },
        { messages: [{ role: 'user', content: 'do the thing again' }] },
        {}
      )) reopenEvents.push(ev);
      const reopenText = reopenEvents.filter((e: any) => e.type === 'text_delta').map((e: any) => e.delta).join('');
      expect(reopenText).toContain('cloud answered');
      expect(reopenText).toContain('Skipping ollama models for 5 min.');
      expect(reopenText).not.toContain('2 min');
    } finally {
      vi.useRealTimers();
      cwdSpy.mockRestore();
      removeNoOpScanCache(scanCachePath);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
