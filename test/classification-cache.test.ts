/**
 * Unit test: classifyPrompt caches LLM results (LRU + TTL) for repeated
 * identical prompts, avoiding a ~22s gemma4:12b call on every re-ask /
 * subagent fan-out / retry loop. Deterministic early-returns (HINT,
 * compaction, short-prompt momentum) bypass the cache and don't fill it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/ollama-utils.ts', async () =>
  (await import('./helpers/ollama-mock.ts')).ollamaMockModule({
    category: 'code_complex',
    reason: 'cached test',
  })
);

vi.mock('../src/logger.ts', async (orig) => {
  const actual = await orig<typeof import('../src/logger.ts')>();
  return { ...actual, warnLog: vi.fn() };
});

// Import AFTER the mock is registered.
import { classifyPrompt } from '../src/content-classifier.ts';
import * as ollamaUtils from '../src/ollama-utils.ts';
import { localModelCache } from './helpers/local-model-cache.ts';
import * as logger from '../src/logger.ts';
import { staleCorrectionMessage, unknownCategoryMessage } from '../src/hint-corrections.ts';

describe('classifyPrompt: LLM result caching (LRU + TTL)', () => {
  beforeEach(() => {
    vi.mocked(ollamaUtils.callOllama).mockClear();
  });

  it('returns the cached result on the second identical prompt without calling the LLM again', async () => {
    const prompt = 'Refactor the router module into smaller files and add tests';
    const opts = { allowStaticFallback: true, cache: localModelCache() } as any;

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
      cache: localModelCache(),
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

const CONTENT = 'Design a rollout plan for the new cache layer';
const HINTED = `HINT: category planning ${CONTENT}`;
const OTHER = 'Summarise the quarterly risk register for the board';
const THIRD = 'Draft a migration note for the parser refactor today';
const LONG_AGO = '2020-01-01T00:00:00.000Z';

describe('classifyPrompt: HINT category form', () => {
  beforeEach(() => {
    vi.mocked(ollamaUtils.callOllama).mockClear();
  });

  it('applies the named category for this turn without calling the classifier', async () => {
    const r = await classifyPrompt(HINTED, { cache: localModelCache() } as any);
    expect(r.category).toBe('planning');
    expect(r.reason).toMatch(/HINT/);
    expect(vi.mocked(ollamaUtils.callOllama)).not.toHaveBeenCalled();
  });

  it('saves the content as a correction in cache.hint_corrections and persists the cache', async () => {
    const cache = localModelCache();
    const persistCache = vi.fn();
    await classifyPrompt(HINTED, { cache, persistCache } as any);
    const entry = (cache as any).hint_corrections[CONTENT];
    expect(entry).toMatchObject({ hintType: 'category', target: 'planning' });
    expect(typeof entry.savedAt).toBe('string');
    expect(persistCache).toHaveBeenCalledTimes(1);
  });

  it('a later identical prompt without HINT gets the saved category, with no classifier call', async () => {
    const cache = localModelCache();
    await classifyPrompt(HINTED, { cache } as any);
    vi.mocked(ollamaUtils.callOllama).mockClear();

    const r = await classifyPrompt(CONTENT, { cache } as any);
    expect(r.category).toBe('planning');
    expect(r.reason).toMatch(/Saved HINT correction/);
    expect(vi.mocked(ollamaUtils.callOllama)).not.toHaveBeenCalled();
  });

  it('a short content (under five words) is applied but never stored', async () => {
    const cache = localModelCache();
    const persistCache = vi.fn();
    const r = await classifyPrompt('HINT: category simple keep going', {
      cache,
      persistCache,
    } as any);
    expect(r.category).toBe('simple');
    expect((cache as any).hint_corrections ?? {}).toEqual({});
    expect(persistCache).not.toHaveBeenCalled();
    expect((cache as any).hint_corrections ?? {}).toEqual({});
    expect(r.reason).toMatch(/not saved/);
  });

  it('a stored name that is no longer a category is not applied: the classifier runs and the warning names it', async () => {
    const cache = localModelCache();
    (cache as any).hint_corrections = {
      [CONTENT]: { hintType: 'category', target: 'roadmap', savedAt: LONG_AGO },
    };
    const r = await classifyPrompt(CONTENT, { cache, allowStaticFallback: true } as any);
    expect(vi.mocked(ollamaUtils.callOllama)).toHaveBeenCalledTimes(1);
    expect(r.category).toBe('code_complex');
    expect(vi.mocked(logger.warnLog)).toHaveBeenCalledWith(staleCorrectionMessage('roadmap'));
    expect((cache as any).hint_corrections).toEqual({});
  });

  it('an unknown category name is rejected with the valid names, and the turn is classified normally', async () => {
    const cache = localModelCache();
    const persistCache = vi.fn();
    const r = await classifyPrompt(`HINT: category roadmap ${OTHER}`, {
      cache,
      persistCache,
      allowStaticFallback: true,
    } as any);
    expect(vi.mocked(ollamaUtils.callOllama)).toHaveBeenCalledTimes(1);
    expect(r.category).toBe('code_complex');
    expect(persistCache).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warnLog)).toHaveBeenCalledWith(unknownCategoryMessage('roadmap'));
  });
});

describe("saved corrections never override the router's own decisions", () => {
  it('a compaction request is not answered from a saved correction for the same text', async () => {
    const cache = localModelCache() as any;
    cache.hint_corrections = {
      [CONTENT]: { hintType: 'category', target: 'planning', savedAt: LONG_AGO },
    };
    const r = await classifyPrompt(CONTENT, {
      cache,
      allowStaticFallback: true,
      context: { isCompaction: true },
    } as any);
    expect(r.reason).not.toMatch(/Saved HINT correction/);
  });

  it('an unknown category name sends the content to the classifier, never the HINT head', async () => {
    vi.mocked(ollamaUtils.callOllama).mockClear();
    await classifyPrompt(`HINT: category roadmap ${THIRD}`, {
      cache: localModelCache(),
      allowStaticFallback: true,
    } as any);
    const sent = JSON.stringify(vi.mocked(ollamaUtils.callOllama).mock.calls);
    expect(sent).toContain(THIRD);
    expect(sent).not.toContain('HINT: category');
  });
});
