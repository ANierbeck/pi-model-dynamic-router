import { describe, it, expect } from 'vitest';
import { extractCapabilities } from '../src/capabilities.ts';

/**
 * Regression test for the OpenRouter capability gap (2026-09-20).
 *
 * Symptom: `bulk_reader` and `code_writer` groups (which filter on
 * `min_context_length`) showed only Mistral models in /router — OpenRouter
 * models like `z-ai/glm-5.2:free` were absent despite ranking top in
 * scout/fallback/operational.
 *
 * Root cause: the OpenRouter scan loop in index.ts pushed entries as
 * `{ id, provider: 'openrouter', cost_per_m }` WITHOUT calling
 * `extractCapabilities('openrouter', m)`, so every OpenRouter model landed
 * in cache.available_models with `capabilities: {}` (no contextWindow).
 * `lookupContextWindow` reads `capabilities.contextWindow` → undefined →
 * the strict null-fails `min_context_length` gate dropped every OpenRouter
 * model. Mistral models WERE enriched (their scan path calls
 * extractCapabilities), so they survived and the groups showed only Mistral.
 *
 * This test proves the capability extractor itself works for OpenRouter's
 * /v1/models response shape — the fix is to actually call it during scan
 * (covered by the index.ts edit; this test guards the extractor contract
 * the scan depends on).
 */
describe('OpenRouter capability extraction (regression: bulk_reader/code_writer null-fails)', () => {
  it('extracts context_length from a standard OpenRouter /v1/models entry', () => {
    const raw = {
      id: 'z-ai/glm-5.2:free',
      architecture: { input_modalities: ['text'] },
      context_length: 131072,
      pricing: { prompt: '0', completion: '0' },
    };
    const caps = extractCapabilities('openrouter', raw);
    expect(caps).toBeDefined();
    expect(caps!.contextWindow).toBe(131072);
  });

  it('extracts context_length even when input_modalities include image (vision)', () => {
    const raw = {
      id: 'openai/gpt-4o:free',
      architecture: { input_modalities: ['text', 'image'] },
      context_length: 64000,
      pricing: { prompt: '0', completion: '0' },
    };
    const caps = extractCapabilities('openrouter', raw);
    expect(caps).toBeDefined();
    expect(caps!.contextWindow).toBe(64000);
    expect(caps!.vision).toBe(true);
  });

  it('returns undefined contextWindow when context_length is missing', () => {
    // Null-fails contract: unknown context window must NOT pass min_context_length.
    const raw = {
      id: 'some/model-no-ctx',
      architecture: { input_modalities: ['text'] },
      // no context_length field
      pricing: { prompt: '0', completion: '0' },
    };
    const caps = extractCapabilities('openrouter', raw);
    expect(caps).toBeDefined();
    expect(caps!.contextWindow).toBeUndefined();
  });

  it('returns undefined when context_length is not a number', () => {
    const raw = {
      id: 'some/model-bad-ctx',
      architecture: { input_modalities: ['text'] },
      context_length: '131072', // string, not number
      pricing: { prompt: '0', completion: '0' },
    };
    const caps = extractCapabilities('openrouter', raw);
    expect(caps).toBeDefined();
    expect(caps!.contextWindow).toBeUndefined();
  });

  it('returns undefined for an unknown provider (caller falls back to defaults)', () => {
    const raw = { id: 'x', context_length: 131072 };
    const caps = extractCapabilities('unknown-provider', raw);
    expect(caps).toBeUndefined();
  });
});
