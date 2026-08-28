/**
 * Unit test: classifyPrompt caches LLM results (LRU + TTL) for repeated
 * identical prompts, avoiding a ~22s gemma4:12b call on every re-ask /
 * subagent fan-out / retry loop. Deterministic early-returns (HINT,
 * compaction, short-prompt momentum) bypass the cache and don't fill it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/ollama-utils', () => ({
  callOllama: vi.fn(async (_model: string, _prompt: string, _opts: any) =>
    JSON.stringify({ category: 'code_complex', reason: 'cached test', confidence: 0.9 })
  ),
}));

// Import AFTER the mock is registered.
import { classifyPrompt } from '../src/content-classifier.ts';
import * as ollamaUtils from '../src/ollama-utils.ts';

describe('classifyPrompt: LLM result caching (LRU + TTL)', () => {
  beforeEach(() => {
    vi.mocked(ollamaUtils.callOllama).mockClear();
  });

  it('returns the cached result on the second identical prompt without calling the LLM again', async () => {
    const prompt = 'Refactor the router module into smaller files and add tests';
    const opts = { allowStaticFallback: true } as any;

    const r1 = await classifyPrompt(prompt, opts);
    const r2 = await classifyPrompt(prompt, opts);

    // Same result both times.
    expect(r1.category).toBe('code_complex');
    expect(r2.category).toBe('code_complex');
    // Only ONE LLM call — the second was a cache hit.
    expect(vi.mocked(ollamaUtils.callOllama)).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache when conversation context is present (avoids stale hits across different contexts)', async () => {
    const prompt = 'Do the thing now please and make it good for the project';
    const optsWithContext = {
      allowStaticFallback: true,
      context: { previousUserMessage: 'previous', lastAssistantSnippet: 'snippet' },
    } as any;

    await classifyPrompt(prompt, optsWithContext);
    await classifyPrompt(prompt, optsWithContext);

    // Both calls reach the LLM — context-bearing prompts aren't cached.
    expect(vi.mocked(ollamaUtils.callOllama)).toHaveBeenCalledTimes(2);
  });

  it('does NOT call the LLM for HINT prompts (deterministic early-return bypasses cache)', async () => {
    const r = await classifyPrompt('HINT: use mistral-medium-3.5', {} as any);

    // HINT is detected deterministically — no LLM call.
    expect(vi.mocked(ollamaUtils.callOllama)).not.toHaveBeenCalled();
    expect((r as any).hintType).toBe('model');
    expect((r as any).hintTarget).toBe('mistral-medium-3.5');
  });
});
