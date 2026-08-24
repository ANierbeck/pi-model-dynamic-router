// test/ollama-context.test.ts
// Tests for src/ollama-context.ts — resolve Ollama num_ctx (context window)
// from the REAL capabilities the scan captured live from /api/show.
//
// Previously this tested a hardcoded Qwen/Gemma/Llama table that mirrored the
// gsd-pi extension — setup-specific, drifted from real Ollama values. The
// module now reads contextWindow from the scan's capabilities (live /api/show
// data) with a conservative 32768 fallback when /api/show yielded nothing.

import { describe, it, expect } from 'vitest';
import { getOllamaContext, buildOllamaProviderModels } from '../src/ollama-context.ts';

describe('getOllamaContext — reads from real capabilities', () => {
  it('uses the contextWindow from capabilities (live /api/show value)', () => {
    const c = getOllamaContext({ contextWindow: 262144 });
    expect(c.num_ctx).toBe(262144);
    expect(c.contextWindow).toBe(262144);
    expect(c.maxTokens).toBe(8192); // default when not reported
  });

  it('num_ctx mirrors contextWindow (Ollama uses it as the prompt window size)', () => {
    expect(getOllamaContext({ contextWindow: 131072 }).num_ctx).toBe(131072);
    expect(getOllamaContext({ contextWindow: 8192 }).num_ctx).toBe(8192);
  });

  it('falls back to conservative 32768 when capabilities.contextWindow is absent', () => {
    const c = getOllamaContext(undefined);
    expect(c.num_ctx).toBe(32768);
    expect(c.contextWindow).toBe(32768);
    expect(c.maxTokens).toBe(8192);
  });

  it('falls back to 32768 when capabilities exist but contextWindow is undefined', () => {
    const c = getOllamaContext({ reasoning: false });
    expect(c.num_ctx).toBe(32768);
  });

  it('uses maxTokens from capabilities when reported', () => {
    const c = getOllamaContext({ contextWindow: 1048576, maxTokens: 32768 });
    expect(c.maxTokens).toBe(32768);
  });
});

describe('buildOllamaProviderModels — for pi.registerProvider', () => {
  it('produces providerOptions.num_ctx per model from real capabilities', () => {
    const models = buildOllamaProviderModels([
      { id: 'qwen3.5:latest', capabilities: { contextWindow: 262144 } },
      { id: 'gemma4:12b-mlx', capabilities: { contextWindow: 131072 } },
    ]);
    expect(models[0].id).toBe('qwen3.5:latest');
    expect(models[0].providerOptions.num_ctx).toBe(262144);
    expect(models[0].contextWindow).toBe(262144);
    expect(models[1].providerOptions.num_ctx).toBe(131072);
  });

  it('falls back to 32768 for models without capabilities (/api/show failed)', () => {
    const models = buildOllamaProviderModels([
      { id: 'unknown-model:latest' }, // no capabilities field
    ]);
    expect(models[0].providerOptions.num_ctx).toBe(32768);
    expect(models[0].contextWindow).toBe(32768);
  });

  it('cost is zero (local inference)', () => {
    const models = buildOllamaProviderModels([{ id: 'x', capabilities: { contextWindow: 8192 } }]);
    expect(models[0].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('every model has providerOptions with num_ctx > 0', () => {
    const models = buildOllamaProviderModels([
      { id: 'a', capabilities: { contextWindow: 262144 } },
      { id: 'b', capabilities: { contextWindow: 8192 } },
      { id: 'c' }, // fallback
    ]);
    for (const m of models) {
      expect(m.providerOptions).toBeDefined();
      expect(m.providerOptions.num_ctx).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThan(0);
    }
  });
});
