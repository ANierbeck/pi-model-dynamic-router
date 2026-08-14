// test/model-matcher-llm.test.ts
// Tests for the LLM orchestration layer of model matching.
//
// matchModelsWithLLM tries, in order:
//   1. the provided callLlm()  (local Ollama/LM-Studio, injected for tests)
//   2. (cloud fallback is handled by the caller wiring; here we test the
//      contract: if callLlm throws, we propagate a "no matches" result and
//      list which models remain unscored)
//
// The orchestrator is given an injectable callLlm so no network is needed.

import { describe, it, expect, vi } from 'vitest';
import { matchModelsWithLLM, type GdpvalEntry, type LlmCaller } from '../src/model-matcher.js';

const GDPVAL: GdpvalEntry[] = [
  { slug: 'glm-5-2', label: 'GLM 5.2', score: 1511.72 },
  { slug: 'gpt-5-5', label: 'GPT 5.5', score: 1485.48 },
  { slug: 'mistral-medium-3-5', label: 'Mistral Medium 3.5', score: 924.55 },
];

describe('matchModelsWithLLM', () => {
  it('returns parsed matches when the LLM responds with valid JSON', async () => {
    const callLlm: LlmCaller = vi.fn().mockResolvedValue(
      JSON.stringify({ 'zai-glm-5-2': 'glm-5-2', 'mistral/glm-5-2': 'glm-5-2' })
    );
    const result = await matchModelsWithLLM({
      modelIds: ['zai-glm-5-2', 'mistral/glm-5-2'],
      gdpvalEntries: GDPVAL,
      callLlm,
    });
    expect(result.matches).toEqual({
      'zai-glm-5-2': 'glm-5-2',
      'mistral/glm-5-2': 'glm-5-2',
    });
    expect(result.unmatched).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(callLlm).toHaveBeenCalledOnce();
  });

  it('records unmatched models when the LLM omits them from the response', async () => {
    const callLlm: LlmCaller = vi.fn().mockResolvedValue(
      JSON.stringify({ 'zai-glm-5-2': 'glm-5-2' }) // mistral/glm-5-2 missing
    );
    const result = await matchModelsWithLLM({
      modelIds: ['zai-glm-5-2', 'mistral/glm-5-2'],
      gdpvalEntries: GDPVAL,
      callLlm,
    });
    expect(result.matches['zai-glm-5-2']).toBe('glm-5-2');
    expect(result.matches['mistral/glm-5-2']).toBeUndefined();
    expect(result.unmatched).toEqual(['mistral/glm-5-2']);
  });

  it('rejects hallucinated slugs not present in gdpvalEntries', async () => {
    const callLlm: LlmCaller = vi.fn().mockResolvedValue(
      JSON.stringify({
        'zai-glm-5-2': 'glm-5-2',
        'shady': 'totally-fabricated',
      })
    );
    const result = await matchModelsWithLLM({
      modelIds: ['zai-glm-5-2', 'shady'],
      gdpvalEntries: GDPVAL,
      callLlm,
    });
    expect(result.matches['zai-glm-5-2']).toBe('glm-5-2');
    expect(result.matches['shady']).toBeUndefined();
    expect(result.unmatched).toEqual(['shady']);
  });

  it('returns empty matches + all models unmatched when callLlm throws (fail-open)', async () => {
    const callLlm: LlmCaller = vi.fn().mockRejectedValue(new Error('Ollama not running'));
    const result = await matchModelsWithLLM({
      modelIds: ['zai-glm-5-2', 'mistral/glm-5-2'],
      gdpvalEntries: GDPVAL,
      callLlm,
    });
    expect(result.matches).toEqual({});
    expect(result.unmatched).toEqual(['zai-glm-5-2', 'mistral/glm-5-2']);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Ollama not running');
  });

  it('returns empty matches when callLlm returns garbage (fail-open, no throw)', async () => {
    const callLlm: LlmCaller = vi.fn().mockResolvedValue('this is not json at all');
    const result = await matchModelsWithLLM({
      modelIds: ['zai-glm-5-2'],
      gdpvalEntries: GDPVAL,
      callLlm,
    });
    expect(result.matches).toEqual({});
    expect(result.unmatched).toEqual(['zai-glm-5-2']);
    expect(result.error).toBeUndefined(); // parse failure is not an exception
  });

  it('strips markdown fences the LLM may wrap around JSON', async () => {
    const callLlm: LlmCaller = vi.fn().mockResolvedValue(
      '```json\n{"zai-glm-5-2": "glm-5-2"}\n```'
    );
    const result = await matchModelsWithLLM({
      modelIds: ['zai-glm-5-2'],
      gdpvalEntries: GDPVAL,
      callLlm,
    });
    expect(result.matches).toEqual({ 'zai-glm-5-2': 'glm-5-2' });
  });

  it('makes only ONE callLlm call regardless of model count (batching)', async () => {
    const callLlm: LlmCaller = vi.fn().mockResolvedValue('{}');
    await matchModelsWithLLM({
      modelIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      gdpvalEntries: GDPVAL,
      callLlm,
    });
    expect(callLlm).toHaveBeenCalledOnce();
  });

  it('handles an empty modelIds list without calling the LLM', async () => {
    const callLlm: LlmCaller = vi.fn();
    const result = await matchModelsWithLLM({
      modelIds: [],
      gdpvalEntries: GDPVAL,
      callLlm,
    });
    expect(callLlm).not.toHaveBeenCalled();
    expect(result.matches).toEqual({});
    expect(result.unmatched).toEqual([]);
  });

  it('handles empty gdpvalEntries gracefully (no valid slugs → all unmatched)', async () => {
    const callLlm: LlmCaller = vi.fn().mockResolvedValue(
      JSON.stringify({ 'zai-glm-5-2': 'glm-5-2' })
    );
    const result = await matchModelsWithLLM({
      modelIds: ['zai-glm-5-2'],
      gdpvalEntries: [],
      callLlm,
    });
    // The LLM returned a slug, but there are no valid slugs → rejected
    expect(result.matches).toEqual({});
    expect(result.unmatched).toEqual(['zai-glm-5-2']);
  });
});
