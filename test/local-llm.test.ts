// test/local-llm.test.ts
// Tests for the provider-agnostic local LLM caller with cloud fallback.
//
// callLocalLlm resolves which local provider to use from PROVIDER_MAP +
// available_models (Ollama OR LM Studio OR any future local provider),
// then falls back to free OpenRouter cloud models if no local provider is up.
//
// Network is fully mocked via globalThis.fetch.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { callLocalLlm, resolveLocalProvider, type LocalLlmDeps } from '../src/local-llm.js';
import type { Config, Cache } from '../src/types.js';
import { PROVIDER_MAP } from '../src/providers.js';

// ADR-0022: the cloud fallback obtains API keys ONLY through the injected
// async resolveApiKey (wired to pi's modelRegistry.getApiKeyForProvider in
// index.ts). The router never reads auth.json or cfg keys itself. The default
// here stands in for "pi resolved a key"; tests override it to pin the null
// and cfg-keys-ignored cases.

const originalFetch = globalThis.fetch;

// ── Helpers ───────────────────────────────────────────────────────────────

function ollamaChatResponse(content: string) {
  return {
    choices: [{ message: { content } }],
  };
}

function makeDeps(overrides: Partial<LocalLlmDeps> = {}): LocalLlmDeps {
  return {
    providers: PROVIDER_MAP,
    cache: { available_models: [] } as Cache,
    cfg: { model_groups: {}, model_metrics: {} } as Config,
    timeoutMs: 5000,
    resolveApiKey: async () => 'or-test-key',
    ...overrides,
  };
}

describe('resolveLocalProvider', () => {
  const ollamaModel = (id: string, capabilities?: Record<string, unknown>) => ({
    id,
    provider: 'ollama',
    cost_per_m: 0,
    ...(capabilities ? { capabilities } : {}),
  });
  const pick = (...models: ReturnType<typeof ollamaModel>[]) =>
    resolveLocalProvider(makeDeps({ cache: { available_models: models } as Cache }))?.modelId;

  // ADR-0025 C3: the choice is DERIVED from size, never from model names.
  // The matcher prompt is large, so the LARGEST model that still fits the
  // size budget wins: capable enough for semantic matching, small enough not
  // to blow the call timeout on a cold start.
  it('prefers the largest model within the matcher size budget', () => {
    expect(pick(ollamaModel('a:2b'), ollamaModel('b:9b'), ollamaModel('c:35b'))).toBe('b:9b');
  });

  it('falls back to the smallest over-budget model when every model is oversized', () => {
    expect(pick(ollamaModel('c:70b'), ollamaModel('d:35b'))).toBe('d:35b');
  });

  it('ranks size-unknown models after sized ones, then by name', () => {
    expect(pick(ollamaModel('a:latest'), ollamaModel('z:2b'))).toBe('z:2b');
    expect(pick(ollamaModel('y:latest'), ollamaModel('x:latest'))).toBe('x:latest');
  });

  it('prefers the size Ollama reported over the one in the id', () => {
    expect(pick(ollamaModel('tagless:latest', { parameterSizeB: 8 }), ollamaModel('a:2b'))).toBe('tagless:latest');
  });

  it('never picks an embedding-only or non-completion model', () => {
    expect(pick(ollamaModel('a:9b', { embedding: true }), ollamaModel('b:9b', { completion: false }), ollamaModel('z:2b'))).toBe('z:2b');
  });

  it('works with LM Studio instead of Ollama (provider-agnostic)', () => {
    const deps = makeDeps({
      cache: {
        available_models: [
          { id: 'qwen2.5-7b', provider: 'lm-studio', cost_per_m: 0 },
        ],
      },
    });
    const result = resolveLocalProvider(deps);
    expect(result).not.toBeNull();
    expect(result?.providerId).toBe('lm-studio');
    expect(result?.modelId).toBe('qwen2.5-7b');
  });

  it('returns null when no local provider has discovered models', () => {
    const deps = makeDeps({
      cache: {
        available_models: [
          { id: 'mistral-medium-3.5', provider: 'mistral', cost_per_m: 0 },
        ],
      },
    });
    expect(resolveLocalProvider(deps)).toBeNull();
  });

  it('returns null when available_models is empty', () => {
    expect(resolveLocalProvider(makeDeps())).toBeNull();
  });

  it('skips local providers with no baseUrl/api (cannot call them)', () => {
    // ollama in PROVIDER_MAP has no baseUrl/api (it's handled by extension);
    // but if discovered models exist for it we still return it because the
    // extension registers a callable endpoint. This test documents that we
    // only require the provider to be marked `local: true`.
    const deps = makeDeps({
      cache: {
        available_models: [{ id: 'gemma4:latest', provider: 'ollama', cost_per_m: 0 }],
      },
    });
    const result = resolveLocalProvider(deps);
    expect(result?.providerId).toBe('ollama');
  });
});

describe('callLocalLlm', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('calls the local provider endpoint when a local model is available', async () => {
    const deps = makeDeps({
      cache: {
        available_models: [
          { id: 'gemma4:latest', provider: 'ollama', cost_per_m: 0 },
        ],
      },
    });
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ollamaChatResponse('{"result":"ok"}'),
    });

    const result = await callLocalLlm('classify this', deps);
    expect(result).toBe('{"result":"ok"}');
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    // Must POST (not GET)
    const callArgs = (globalThis.fetch as any).mock.calls[0];
    expect(callArgs[1]?.method).toBe('POST');
  });

  it('uses OpenAI chat/completions format for the local call', async () => {
    const deps = makeDeps({
      cache: {
        available_models: [
          { id: 'gemma4:latest', provider: 'ollama', cost_per_m: 0 },
        ],
      },
    });
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ollamaChatResponse('ok'),
    });

    await callLocalLlm('hello', deps);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: 'user', content: 'hello' },
    ]);
    expect(body.model).toBe('gemma4:latest');
    expect(body.stream).toBe(false);
  });

  it('falls back to free cloud models when no local provider is available', async () => {
    const deps = makeDeps({
      cfg: {
        model_groups: {},
        model_metrics: {},
        providers: {
          openrouter: {
            billing: 'pay_per_token',
            keys: [{ key: 'or-test-key' }],
            free_models: ['openrouter/google/gemma-3-12b-it:free'],
          },
        },
      } as Config,
      cache: { available_models: [] } as Cache,
    });
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ollamaChatResponse('cloud-result'),
    });

    const result = await callLocalLlm('test prompt', deps);
    expect(result).toBe('cloud-result');
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain('openrouter.ai');
    const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer or-test-key');
  });

  it('falls back to cloud when the local provider HTTP call fails', async () => {
    const deps = makeDeps({
      cfg: {
        model_groups: {},
        model_metrics: {},
        providers: {
          openrouter: {
            billing: 'pay_per_token',
            keys: [{ key: 'or-test-key' }],
            free_models: ['openrouter/google/gemma-3-12b-it:free'],
          },
        },
      } as Config,
      cache: {
        available_models: [
          { id: 'gemma4:latest', provider: 'ollama', cost_per_m: 0 },
        ],
      },
    });
    (globalThis.fetch as any)
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' }) // local fails
      .mockResolvedValueOnce({ ok: true, json: async () => ollamaChatResponse('cloud-fallback') }); // cloud ok

    const result = await callLocalLlm('test', deps);
    expect(result).toBe('cloud-fallback');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('tries multiple free cloud models in order until one succeeds', async () => {
    const deps = makeDeps({
      cfg: {
        model_groups: {},
        model_metrics: {},
        providers: {
          openrouter: {
            billing: 'pay_per_token',
            keys: [{ key: 'or-test-key' }],
            free_models: [
              'openrouter/openai/gpt-4o-mini:free',
              'openrouter/google/gemma-3-12b-it:free',
            ],
          },
        },
      } as Config,
      cache: { available_models: [] } as Cache,
    });
    (globalThis.fetch as any)
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
      .mockResolvedValueOnce({ ok: true, json: async () => ollamaChatResponse('second-model-wins') });

    const result = await callLocalLlm('test', deps);
    expect(result).toBe('second-model-wins');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('throws a clear error when both local and all cloud models fail', async () => {
    const deps = makeDeps({
      cfg: {
        model_groups: {},
        model_metrics: {},
        providers: {
          openrouter: {
            billing: 'pay_per_token',
            keys: [{ key: 'or-test-key' }],
            free_models: ['openrouter/openai/gpt-4o-mini:free'],
          },
        },
      } as Config,
      cache: { available_models: [] } as Cache,
    });
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    });

    await expect(callLocalLlm('test', deps)).rejects.toThrow(/no LLM available/i);
  });

  it('throws when no local provider AND no cloud models are configured', async () => {
    const deps = makeDeps(); // empty everything
    await expect(callLocalLlm('test', deps)).rejects.toThrow(/no LLM available/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('passes the prompt through as the user message, not system', async () => {
    const deps = makeDeps({
      cache: {
        available_models: [
          { id: 'gemma4:latest', provider: 'ollama', cost_per_m: 0 },
        ],
      },
    });
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ollamaChatResponse('ok'),
    });
    await callLocalLlm('MATCH THESE MODELS', deps);
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'MATCH THESE MODELS' });
  });
});

// ── pi-resolved keys (ADR-0022) ───────────────────────────────────────
// The cloud fallback gets its API key exclusively from the injected async
// resolveApiKey (pi's getApiKeyForProvider in production). cfg keys are
// never consulted; a provider whose key pi cannot resolve is skipped.
describe('callLocalLlm: pi-resolved key handling (ADR-0022)', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('uses the pi-resolved key as the bearer token for the cloud fallback', async () => {
    const deps = makeDeps({
      resolveApiKey: async () => 'pi-resolved-key',
      cfg: {
        model_groups: {},
        model_metrics: {},
        providers: {
          openrouter: {
            billing: 'pay_per_token',
            // cfg keys are DEAD under ADR-0022 — garbage here proves they
            // are never consulted.
            keys: [{ key: '__auth_json__:openrouter-prod' }],
            free_models: ['openrouter/google/gemma-3-12b-it:free'],
          },
        },
      } as Config,
      cache: { available_models: [] } as Cache, // no local provider → cloud fallback fires
    });
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ollamaChatResponse('cloud-result'),
    });

    const result = await callLocalLlm('test prompt', deps);
    expect(result).toBe('cloud-result');
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer pi-resolved-key');
  });

  it('skips the free provider when pi cannot resolve a key', async () => {
    const deps = makeDeps({
      resolveApiKey: async () => null,
      cfg: {
        model_groups: {},
        model_metrics: {},
        providers: {
          openrouter: {
            billing: 'pay_per_token',
            free_models: ['openrouter/google/gemma-3-12b-it:free'],
          },
        },
      } as Config,
      cache: { available_models: [] } as Cache,
    });

    // No usable local provider and no key-resolvable free cloud model →
    // the clear error, and NO network call with a garbage bearer.
    await expect(callLocalLlm('test', deps)).rejects.toThrow(/no LLM available/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
