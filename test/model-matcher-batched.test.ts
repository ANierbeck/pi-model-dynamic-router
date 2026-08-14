// test/model-matcher-batched.test.ts
// Tests for batched LLM matching + plausibility pre-filtering.
//
// These address the real-world failure where a single 400+ model prompt causes
// gemma2:2b to emit malformed JSON. The fix: pre-filter to plausible candidates
// (significant-token overlap with a gdpval slug) + process in batches.

import { describe, it, expect, vi } from 'vitest';
import {
  plausibleMatchCandidates,
  matchModelsWithLLMBatched,
  type GdpvalEntry,
  type LlmCaller,
} from '../src/model-matcher.js';

const GDPVAL: GdpvalEntry[] = [
  { slug: 'glm-5-2', label: 'GLM 5.2', score: 1506.11 },
  { slug: 'mistral-medium-3-5', label: 'Mistral Medium 3.5', score: 924.55 },
  { slug: 'claude-sonnet-5', label: 'Claude Sonnet 5', score: 1603 },
  { slug: 'gpt-5-5', label: 'GPT 5.5', score: 1485.48 },
];

describe('plausibleMatchCandidates', () => {
  it('keeps models with significant token overlap (glm, mistral, claude, gpt)', () => {
    const ids = [
      'mistral-zai/zai-glm-5-2', // model name 'zai-glm-5-2' has 'glm'
      'mistral/mistral-medium-2505', // model name has 'mistral','medium'
      'claude/claude-sonnet-5-20250929', // has 'claude','sonnet'
      'openai/gpt-5-4-mini', // has 'gpt'
    ];
    const result = plausibleMatchCandidates(ids, GDPVAL);
    expect(result).toEqual(ids);
  });

  it('drops models with NO significant token overlap in the model NAME (ignoring provider prefix)', () => {
    // 'mistral/voxtral-mini-2602' → model name 'voxtral-mini-2602' → tokens
    // 'voxtral','mini' — none in gdpval slugs → dropped.
    // 'mistral/ministral-3b' → 'ministral' ≠ 'mistral' → dropped.
    // Note: 'mistral/mistral-ocr-2512' → 'mistral' IS in slugs → kept (the LLM
    // will then decide it doesn't match 'mistral-medium-3-5'); the filter is
    // intentionally loose — it only removes models with ZERO overlap.
    const ids = [
      'mistral-zai/zai-glm-5-2', // plausible (glm)
      'mistral/voxtral-mini-2602', // dropped (voxtral, mini not in slugs)
      'mistral/ministral-3b', // dropped (ministral ≠ mistral)
      'ollama/qwen3.5', // dropped (qwen not in gdpval)
    ];
    const result = plausibleMatchCandidates(ids, GDPVAL);
    expect(result).toEqual(['mistral-zai/zai-glm-5-2']);
  });

  it('requires tokens of length >= 3 (drops short tokens like "5", "2", "v4")', () => {
    // "v4", "5", "2" are not significant; only "glm"/"mistral" etc. count.
    const ids = ['x/v4-5-2', 'y/glm-5-2'];
    const result = plausibleMatchCandidates(ids, GDPVAL);
    expect(result).toEqual(['y/glm-5-2']);
  });

  it('returns empty when no gdpval entries have significant tokens', () => {
    const result = plausibleMatchCandidates(['a/glm-5-2'], []);
    expect(result).toEqual([]);
  });

  it('handles a large list efficiently (the 425-model case)', () => {
    // 'mistral/model-N' → model name 'model-N' → token 'model' which is NOT
    // in any gdpval slug, so all 423 generic ones are filtered out.
    const big = Array.from({ length: 425 }, (_, i) => `mistral/model-${i}`);
    big[0] = 'mistral-zai/zai-glm-5-2'; // plausible (glm)
    big[10] = 'mistral/mistral-medium-2505'; // plausible (mistral, medium)
    const result = plausibleMatchCandidates(big, GDPVAL);
    expect(result.length).toBe(2);
    expect(result).toContain('mistral-zai/zai-glm-5-2');
    expect(result).toContain('mistral/mistral-medium-2505');
  });
});

describe('matchModelsWithLLMBatched', () => {
  it('processes a single batch under the batch size without batching', async () => {
    const callLlm: LlmCaller = vi.fn().mockResolvedValue(
      JSON.stringify({ 'zai-glm-5-2': 'glm-5-2' })
    );
    const result = await matchModelsWithLLMBatched({
      modelIds: ['zai-glm-5-2'],
      gdpvalEntries: GDPVAL,
      callLlm,
    });
    expect(result.matches).toEqual({ 'zai-glm-5-2': 'glm-5-2' });
    expect(result.unmatched).toEqual([]);
    expect(callLlm).toHaveBeenCalledOnce();
  });

  it('pre-filters implausible models BEFORE calling the LLM', async () => {
    const callLlm: LlmCaller = vi.fn().mockResolvedValue(
      JSON.stringify({ 'zai-glm-5-2': 'glm-5-2' })
    );
    const result = await matchModelsWithLLMBatched({
      modelIds: ['zai-glm-5-2', 'mistral/voxtral-mini-2602', 'mistral/ministral-3b'],
      gdpvalEntries: GDPVAL,
      callLlm,
    });
    // Only the plausible model went to the LLM.
    expect(callLlm).toHaveBeenCalledOnce();
    expect(result.matches).toEqual({ 'zai-glm-5-2': 'glm-5-2' });
    // Implausible models are NOT reported as unmatched (silently dropped).
    expect(result.unmatched).toEqual([]);
  });

  it('splits a large list into multiple batches', async () => {
    // 10 plausible models, batch size 4 → 3 batches (4, 4, 2).
    const plausible = Array.from({ length: 10 }, (_, i) => `x/glm-${i}`);
    const callLlm: LlmCaller = vi.fn().mockImplementation(async (prompt: string) => {
      // Echo back matches for whatever was in the prompt.
      const ids = [...prompt.matchAll(/- (x\/glm-\d+)/g)].map((m) => m[1]);
      const obj: Record<string, string> = {};
      for (const id of ids) obj[id] = 'glm-5-2';
      return JSON.stringify(obj);
    });

    const result = await matchModelsWithLLMBatched({
      modelIds: plausible,
      gdpvalEntries: GDPVAL,
      callLlm,
      batchSize: 4,
    });
    expect(callLlm).toHaveBeenCalledTimes(3);
    expect(Object.keys(result.matches).length).toBe(10);
    expect(result.unmatched).toEqual([]);
  });

  it('continues processing other batches when one batch throws', async () => {
    const plausible = ['x/glm-0', 'x/glm-1', 'x/glm-2', 'x/glm-3'];
    let callCount = 0;
    const callLlm: LlmCaller = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('batch 1 failed'); // first batch throws
      // subsequent batches succeed
      return JSON.stringify({ 'x/glm-2': 'glm-5-2', 'x/glm-3': 'glm-5-2' });
    });

    const result = await matchModelsWithLLMBatched({
      modelIds: plausible,
      gdpvalEntries: GDPVAL,
      callLlm,
      batchSize: 2, // → 2 batches
    });
    expect(callLlm).toHaveBeenCalledTimes(2);
    // Batch 1 (glm-0, glm-1) failed → unmatched. Batch 2 (glm-2, glm-3) succeeded.
    expect(result.matches).toEqual({ 'x/glm-2': 'glm-5-2', 'x/glm-3': 'glm-5-2' });
    expect(result.unmatched).toEqual(['x/glm-0', 'x/glm-1']);
    expect(result.error).toContain('batch 1 failed');
  });

  it('returns empty matches + no unmatched when ALL models are implausible', async () => {
    const callLlm: LlmCaller = vi.fn();
    const result = await matchModelsWithLLMBatched({
      modelIds: ['mistral/voxtral-mini', 'mistral/ministral-3b'],
      gdpvalEntries: GDPVAL,
      callLlm,
    });
    expect(callLlm).not.toHaveBeenCalled();
    expect(result.matches).toEqual({});
    expect(result.unmatched).toEqual([]);
  });

  it('rejects hallucinated slugs (hallucination guard still active per batch)', async () => {
    const callLlm: LlmCaller = vi.fn().mockResolvedValue(
      JSON.stringify({ 'zai-glm-5-2': 'totally-fabricated-slug' })
    );
    const result = await matchModelsWithLLMBatched({
      modelIds: ['zai-glm-5-2'],
      gdpvalEntries: GDPVAL,
      callLlm,
    });
    expect(result.matches).toEqual({});
    expect(result.unmatched).toEqual(['zai-glm-5-2']);
  });

  it('handles empty input without calling the LLM', async () => {
    const callLlm: LlmCaller = vi.fn();
    const result = await matchModelsWithLLMBatched({
      modelIds: [],
      gdpvalEntries: GDPVAL,
      callLlm,
    });
    expect(callLlm).not.toHaveBeenCalled();
    expect(result.matches).toEqual({});
    expect(result.unmatched).toEqual([]);
  });
});
