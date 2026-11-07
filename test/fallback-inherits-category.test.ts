/**
 * Task-type-balancing Phase 2: a classification that comes out as the
 * 'continue' category ("could not tell" — typically a long continuation like
 * "ok, then please carry on with the remaining items") inherits the previous
 * turn's category instead of dropping to the continue→standard default (D6).
 * Mirrors the low-confidence and short-prompt momentum inheritance.
 */
import { describe, it, beforeEach, expect, vi } from 'vitest';
import {
  classifyPrompt,
  getGroupForCategory,
  getClassificationCounts,
  resetClassificationCounts,
} from '../src/content-classifier.ts';
import * as ollamaUtils from '../src/ollama-utils.ts';
import { localModelCache } from './helpers/local-model-cache.ts';

vi.mock('../src/ollama-utils.ts', () => ({
  callOllama: vi.fn(),
  isOllamaAvailable: vi.fn(async () => true),
}));

// More than CONTINUATION_MAX_WORDS so short-prompt momentum does not fire:
// only the LLM-said-'fallback' path is under test.
// Unique per call: identical context-free prompts hit the classification cache.
let promptSeq = 0;
const continuation = () =>
  `okay then please carry on with whatever remains of that list from before #${++promptSeq}`;

function llmSays(category: string, confidence = 0.9): void {
  vi.mocked(ollamaUtils.callOllama).mockResolvedValue(
    JSON.stringify({ category, reason: 'mocked', confidence })
  );
}

describe('fallback classification inherits the previous category (Phase 2)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(ollamaUtils.isOllamaAvailable).mockResolvedValue(true);
    resetClassificationCounts();
  });

  it('design turn, then a confident LLM "continue" → routes to the design group, not standard', async () => {
    llmSays('continue');
    const result = await classifyPrompt(continuation(), {
      cache: localModelCache(),
      context: { lastCategory: 'design' },
    });
    expect('category' in result && result.category).toBe('design');
    expect(getGroupForCategory((result as { category: string }).category)).toBe(
      getGroupForCategory('design')
    );
    expect(getGroupForCategory('design')).not.toBe(getGroupForCategory('continue'));
    expect(result.reason).toContain('inherit');
  });

  it('counts the inherited category, not the raw fallback', async () => {
    llmSays('continue');
    await classifyPrompt(continuation(), {
      cache: localModelCache(),
      context: { lastCategory: 'design' },
    });
    const counts = getClassificationCounts();
    expect(counts.byCategory.design).toBe(1);
    expect(counts.byCategory.continue).toBeUndefined();
  });

  it('inherits on the static path too (LLM unavailable, static classifier says fallback)', async () => {
    vi.mocked(ollamaUtils.callOllama).mockRejectedValue(new Error('down'));
    const result = await classifyPrompt(continuation(), {
      cache: localModelCache(),
      allowStaticFallback: true,
      context: { lastCategory: 'planning' },
    });
    expect('category' in result && result.category).toBe('planning');
  });

  it('inherits when the classifier is unavailable and static fallback is disabled', async () => {
    vi.mocked(ollamaUtils.callOllama).mockRejectedValue(new Error('down'));
    const result = await classifyPrompt(continuation(), {
      cache: localModelCache(),
      context: { lastCategory: 'design' },
    });
    expect('category' in result && result.category).toBe('design');
  });

  it('without a previous category, continue stays continue and maps to the default group', async () => {
    llmSays('continue');
    const result = await classifyPrompt(continuation(), { cache: localModelCache(), context: {} });
    expect('category' in result && result.category).toBe('continue');
    expect(getGroupForCategory('continue')).toBe('standard');
  });

  it('a concrete (non-fallback) classification is never replaced by the previous category', async () => {
    llmSays('simple');
    const result = await classifyPrompt(continuation(), {
      cache: localModelCache(),
      context: { lastCategory: 'design' },
    });
    expect('category' in result && result.category).toBe('simple');
  });

  // docs/plans/2026-10-26-continue-keeps-model.md: the orchestrator keeps the
  // previous MODEL (not only the category) on a continue turn, so it must be
  // able to tell an inherited result from a genuinely classified one.
  it('marks an inherited result, so the router can keep the previous model', async () => {
    llmSays('continue');
    const result = await classifyPrompt(continuation(), {
      cache: localModelCache(),
      context: { lastCategory: 'design' },
    });
    expect(result).toMatchObject({ category: 'design', inheritedFromContinue: true });
  });

  it('does not mark a concrete classification, nor a continue without a predecessor', async () => {
    llmSays('simple');
    const concrete = await classifyPrompt(continuation(), {
      cache: localModelCache(),
      context: { lastCategory: 'design' },
    });
    expect(concrete).not.toHaveProperty('inheritedFromContinue');

    llmSays('continue');
    const orphan = await classifyPrompt(continuation(), { cache: localModelCache() });
    expect(orphan).not.toHaveProperty('inheritedFromContinue');
  });

  it('a HINT turn is never overridden by inheritance', async () => {
    const result = await classifyPrompt('HINT: planning please carry on with the list', {
      context: { lastCategory: 'design' },
    });
    expect('hintType' in result).toBe(true);
    expect('category' in result).toBe(false);
  });

  it('a compaction turn is never overridden by inheritance', async () => {
    const result = await classifyPrompt(continuation(), {
      cache: localModelCache(),
      context: { lastCategory: 'design', isCompaction: true },
    });
    expect('category' in result && result.category).toBe('code_complex');
    expect(result.reason).toContain('Compaction');
  });
});
