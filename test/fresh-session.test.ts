// Task-type balancing step 5c (docs/plans/2026-11-19-fresh-session-suggestion.md):
// the pure trigger heuristic for suggesting (never forcing) a fresh session.
// Red-first per AGENTS.md §4: written against the unfixed implementation.

import { describe, expect, it } from 'vitest';
import { FRESH_DEFAULTS, decideFreshStart } from '../src/fresh-session.ts';
import type { ContextBudgetConfig } from '../src/types.ts';

const budget = (over: Partial<ContextBudgetConfig> = {}): ContextBudgetConfig | undefined =>
  ({
    enabled: true,
    soft_tokens: 100_000,
    hard_tokens: 200_000,
    cache_ttl_s: 300,
    ...over,
  }) as ContextBudgetConfig;

const input = (over: Record<string, unknown> = {}) => ({
  budget: budget(),
  freshEnabled: true,
  cold: true,
  contextTokens: 150_000,
  contextWindow: 200_000,
  idleSeconds: 4 * 60,
  stepsSinceSessionStart: 40,
  compactionsThisSession: 2, // 5b already compacted twice this session
  ...over,
});

describe('fresh-session suggestion', () => {
  it('suggests when compaction is not sticking (cold, large, compacted twice)', () => {
    const d = decideFreshStart(input());
    expect(d).toMatchObject({ suggest: true, reason: expect.stringMatching(/compaction is not sticking/) });
  });

  it('suggests when the cache went cold from idling and the context share is high', () => {
    const d = decideFreshStart(input({ cold: false, idleSeconds: 20 * 60 }));
    expect(d.suggest).toBe(true);
    expect(d.suggest && d.reason).toMatch(/cache went cold from idling/);
  });

  it('suggests on a plain cold cache with a large context even without compactions', () => {
    const d = decideFreshStart(input({ compactionsThisSession: 0, idleSeconds: 10 }));
    expect(d).toMatchObject({ suggest: true, reason: expect.stringMatching(/cache cold and context large/) });
  });

  it('never suggests while the cache serves hits on a small context', () => {
    const d = decideFreshStart(
      input({ cold: false, idleSeconds: 10, contextTokens: 20_000, compactionsThisSession: 0 })
    );
    expect(d).toEqual({ suggest: false });
  });

  it('respects the context share gate before suggesting', () => {
    const d = decideFreshStart(input({ contextWindow: 1_000_000 })); // 15 % share
    expect(d.suggest).toBe(false);
  });

  it('respects after_turns (default) before suggesting', () => {
    expect(decideFreshStart(input({ stepsSinceSessionStart: 3 })).suggest).toBe(false);
  });

  it('is off when the feature is disabled — the shipped default', () => {
    expect(decideFreshStart(input({ freshEnabled: false })).suggest).toBe(false);
    expect(decideFreshStart(input({ budget: undefined })).suggest).toBe(false);
  });

  it('exposes the shipped defaults', () => {
    expect(FRESH_DEFAULTS.min_ctx_share).toBe(0.6);
    expect(FRESH_DEFAULTS.after_turns).toBe(10);
    expect(FRESH_DEFAULTS.cold_idle_s).toBe(15 * 60);
  });
});
