// test/capabilities.test.ts
// Tests for src/capabilities.ts — the single source of truth for normalizing
// real model capabilities from heterogeneous provider /v1/models responses.

import { describe, it, expect } from 'vitest';
import { extractCapabilities } from '../src/capabilities.ts';

describe('extractCapabilities — Mistral shape (mistral + mistral-zai)', () => {
  it('extracts vision:false + reasoning:true + contextWindow for a non-vision model', () => {
    const c = extractCapabilities('mistral', {
      id: 'glm-5-2',
      capabilities: { vision: false, reasoning: true },
      max_context_length: 1048576,
    });
    expect(c?.vision).toBe(false);
    expect(c?.reasoning).toBe(true);
    expect(c?.contextWindow).toBe(1048576);
  });

  it('extracts vision:true for a vision-capable model', () => {
    const c = extractCapabilities('mistral', {
      id: 'pixtral-12b',
      capabilities: { vision: true, reasoning: false },
      max_context_length: 131072,
    });
    expect(c?.vision).toBe(true);
    expect(c?.reasoning).toBe(false);
  });

  it('mistral-zai shares the Mistral shape (same endpoint)', () => {
    const c = extractCapabilities('mistral-zai', {
      capabilities: { vision: false, reasoning: true },
      max_context_length: 1048576,
    });
    expect(c?.vision).toBe(false);
    expect(c?.contextWindow).toBe(1048576);
  });

  it('omits contextWindow when the provider did not report it', () => {
    const c = extractCapabilities('mistral', { capabilities: { vision: false, reasoning: false } });
    expect(c?.contextWindow).toBeUndefined();
  });
});

describe('extractCapabilities — OpenRouter shape', () => {
  it('extracts vision from architecture.input_modalities and reasoning from reasoning object', () => {
    const c = extractCapabilities('openrouter', {
      id: '~z-ai/glm-latest',
      architecture: { input_modalities: ['text'] },
      reasoning: { mandatory: true, default_enabled: true },
      context_length: 1048576,
    });
    expect(c?.vision).toBe(false);
    expect(c?.reasoning).toBe(true);
    expect(c?.contextWindow).toBe(1048576);
  });

  it('detects vision when input_modalities includes image', () => {
    const c = extractCapabilities('openrouter', {
      architecture: { input_modalities: ['text', 'image'] },
      reasoning: { mandatory: false, default_enabled: false },
      context_length: 131072,
    });
    expect(c?.vision).toBe(true);
    expect(c?.reasoning).toBe(false);
  });
});

describe('extractCapabilities — Ollama /api/show shape (preferred)', () => {
  it('extracts context length from model_info.*.context_length + capabilities array', () => {
    const c = extractCapabilities('ollama', {
      capabilities: ['completion', 'vision', 'tools', 'thinking'],
      model_info: { 'qwen3_5.context_length': 262144 },
    });
    expect(c?.vision).toBe(true);
    expect(c?.reasoning).toBe(true);
    expect(c?.contextWindow).toBe(262144);
  });

  it('detects vision from capabilities array (no families needed)', () => {
    const c = extractCapabilities('ollama', {
      capabilities: ['completion', 'vision'],
      model_info: { 'gemma.context_length': 131072 },
    });
    expect(c?.vision).toBe(true);
    expect(c?.contextWindow).toBe(131072);
  });

  it('reasoning true when capabilities include thinking', () => {
    const c = extractCapabilities('ollama', {
      capabilities: ['completion', 'thinking'],
    });
    expect(c?.reasoning).toBe(true);
    expect(c?.vision).toBe(false);
  });

  it('no vision, no reasoning when capabilities lack them', () => {
    const c = extractCapabilities('ollama', {
      capabilities: ['completion'],
      model_info: { 'llama.context_length': 8192 },
    });
    expect(c?.vision).toBe(false);
    expect(c?.reasoning).toBe(false);
    expect(c?.contextWindow).toBe(8192);
  });

  it('falls back to /api/tags details.families when capabilities array absent', () => {
    // /api/show unavailable — only /api/tags data (details.families).
    const c = extractCapabilities('ollama', { details: { families: ['clip', 'llama'] } });
    expect(c?.vision).toBe(true);
  });

  it('omits contextWindow when model_info has no context_length key', () => {
    const c = extractCapabilities('ollama', {
      capabilities: ['completion'],
      model_info: { 'llama.some_other_field': 42 },
    });
    expect(c?.contextWindow).toBeUndefined();
  });
});

describe('extractCapabilities — unknown provider', () => {
  it('returns undefined for a provider with no registered extractor', () => {
    expect(extractCapabilities('totally-unknown', { id: 'x' })).toBeUndefined();
  });
});
