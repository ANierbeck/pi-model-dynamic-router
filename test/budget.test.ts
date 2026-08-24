// test/budget.test.ts
// Tests for the unified budget-availability check (src/budget.ts).
//
// Pins the SINGLE source of truth for "does this model still have budget".
// Previously hasModelBudget (index.ts) and filterByBudget (routing.ts)
// implemented the same rule twice. Both now delegate to hasBudget() here.

import { describe, it, expect } from 'vitest';
import { hasBudget, filterByBudget } from '../src/budget.ts';
import type { Config, Cache } from '../src/types.ts';

const providers: Config['providers'] = {
  mistral: { billing: 'subscription' },
  openrouter: { billing: 'pay_per_token' },
  // ollama is local via PROVIDER_MAP — no config needed
};

describe('hasBudget — local providers', () => {
  it('always returns true for ollama (local compute)', () => {
    expect(hasBudget('ollama/gemma4:12b-mlx', providers, {})).toBe(true);
    expect(hasBudget('ollama/qwen3.8:27b-mlx', providers, {})).toBe(true);
  });

  it('always returns true for lm-studio (local compute)', () => {
    expect(hasBudget('lm-studio/some-model', providers, {})).toBe(true);
  });
});

describe('hasBudget — pay-per-token providers', () => {
  it('always returns true (limited by money, not tokens)', () => {
    expect(hasBudget('openrouter/anthropic/claude-opus-5', providers, {})).toBe(true);
    expect(hasBudget('openrouter/qwen/qwen3-4b:free', providers, {})).toBe(true);
  });
});

describe('hasBudget — subscription providers', () => {
  it('returns true when no cached budget info (assume available — conservative)', () => {
    expect(hasBudget('mistral/mistral-medium-latest', providers, {})).toBe(true);
    expect(hasBudget('mistral/mistral-medium-latest', providers, undefined)).toBe(true);
  });

  it('returns true when remaining_tokens > 0', () => {
    const budget_cache = {
      mistral: { remaining_tokens: 50000, window_reset: Date.now() + 3600_000 },
    };
    expect(hasBudget('mistral/mistral-medium-latest', providers, budget_cache)).toBe(true);
  });

  it('returns false when remaining_tokens is 0', () => {
    const budget_cache = {
      mistral: { remaining_tokens: 0, window_reset: Date.now() + 3600_000 },
    };
    expect(hasBudget('mistral/mistral-medium-latest', providers, budget_cache)).toBe(false);
  });

  it('returns true when the window has reset (assume available until refreshed)', () => {
    const budget_cache = {
      mistral: { remaining_tokens: 0, window_reset: Date.now() - 1000 }, // past
    };
    expect(hasBudget('mistral/mistral-medium-latest', providers, budget_cache)).toBe(true);
  });

  it('returns false when remaining_tokens undefined and window not reset', () => {
    const budget_cache = {
      mistral: { window_reset: Date.now() + 3600_000 }, // no remaining_tokens
    };
    // remaining_tokens ?? 0 → 0 → no budget
    expect(hasBudget('mistral/mistral-medium-latest', providers, budget_cache)).toBe(false);
  });
});

describe('filterByBudget — convenience over hasBudget', () => {
  const budget_cache = {
    mistral: { remaining_tokens: 0, window_reset: Date.now() + 3600_000 },
  };

  it('keeps local + payg models, drops exhausted subscription models', () => {
    const refs = [
      'ollama/gemma4:12b-mlx',        // local → keep
      'openrouter/some-model',         // payg → keep
      'mistral/mistral-medium-latest', // subscription, 0 tokens → drop
    ];
    const kept = filterByBudget(refs, { providers, budget_cache });
    expect(kept).toContain('ollama/gemma4:12b-mlx');
    expect(kept).toContain('openrouter/some-model');
    expect(kept).not.toContain('mistral/mistral-medium-latest');
  });
});
