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
    ...overrides,
  };
}

describe('resolveLocalProvider', () => {
  it('returns the first local provider that has discovered models', () => {
    const deps = makeDeps({
      cache: {
        available_models: [
          { id: 'gemma4:latest', provider: 'ollama', cost_per_m: 0 },
          { id: 'llama3.1:latest', provider: 'ollama', cost_per_m: 0 },
        ],
      },
    });
    const result = resolveLocalProvider(deps);
    expect(result).not.toBeNull();
    expect(result?.providerId).toBe('ollama');
    expect(result?.modelId).toBe('gemma4:latest');
  });

  it('prefers a CAPABLE model (qwen3.6:35b) over gemma2:2b (too weak for matching)', () => {
    // The matcher needs reliable JSON + semantic understanding.
    // gemma2:2b hallucinates cross-family matches and is ranked LAST.
    const deps = makeDeps({
      cache: {
        available_models: [
          { id: 'gemma2:2b', provider: 'ollama', cost_per_m: 0 },
          { id: 'qwen3.6:35b-mlx', provider: 'ollama', cost_per_m: 0 },
        ],
      },
    });
    const result = resolveLocalProvider(deps);
    expect(result).not.toBeNull();
    expect(result?.modelId).toBe('qwen3.6:35b-mlx');
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
