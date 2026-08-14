// test/exclude.test.ts
// Tests for the global model exclusion rules (personalized support list).

import { describe, it, expect } from 'vitest';
import { isExcluded, applyExcludes, type ExcludeContext } from '../src/exclude.js';
import type { Config, Cache } from '../src/types.js';
import { PROVIDER_MAP } from '../src/providers.js';

function ctx(rules: any, cfgOverrides: Partial<Config> = {}, cacheOverrides: Partial<Cache> = {}): ExcludeContext {
  const cfg: Config = {
    providers: {
      openrouter: {
        billing: 'pay_per_token',
        free_models: [
          'openrouter/qwen/qwen3-4b:free',
          'openrouter/openai/gpt-4o-mini:free',
        ],
      },
    },
    model_groups: {},
    model_metrics: {},
    ...cfgOverrides,
  };
  const cache: Cache = {
    available_models: [
      { id: 'anthropic/claude-opus-5', provider: 'openrouter', cost_per_m: 5 },
      { id: 'qwen/qwen3-4b:free', provider: 'openrouter', cost_per_m: 0 },
    ],
    ...cacheOverrides,
  };
  return { rules, cfg, cache };
}

describe('isExcluded — provider exclusion', () => {
  it('excludes all models from a listed provider', () => {
    const c = ctx({ providers: ['openrouter'] });
    expect(isExcluded('openrouter/anthropic/claude-opus-5', c)).toBe(true);
    expect(isExcluded('openrouter/qwen/qwen3-4b:free', c)).toBe(true);
  });

  it('does not exclude models from other providers', () => {
    const c = ctx({ providers: ['openrouter'] });
    expect(isExcluded('mistral/mistral-medium-3.5', c)).toBe(false);
    expect(isExcluded('ollama/gemma4:latest', c)).toBe(false);
  });

  it('supports glob patterns on provider names', () => {
    const c = ctx({ providers: ['openrouter*'] });
    expect(isExcluded('openrouter/anthropic/claude-opus-5', c)).toBe(true);
  });
});

describe('isExcluded — model pattern exclusion', () => {
  it('exacts match a full ref', () => {
    const c = ctx({ models: ['claude-bridge/claude-fable-5'] });
    expect(isExcluded('claude-bridge/claude-fable-5', c)).toBe(true);
    expect(isExcluded('claude-bridge/claude-opus-5', c)).toBe(false);
  });

  it('supports wildcard prefix/suffix', () => {
    const c = ctx({ models: ['*fable*'] });
    expect(isExcluded('claude-bridge/claude-fable-5', c)).toBe(true);
    expect(isExcluded('openrouter/anthropic/claude-fable-5', c)).toBe(true);
    expect(isExcluded('claude-bridge/claude-opus-5', c)).toBe(false);
  });

  it('supports full-provider wildcard', () => {
    const c = ctx({ models: ['openrouter/*'] });
    expect(isExcluded('openrouter/anthropic/claude-opus-5', c)).toBe(true);
    expect(isExcluded('openrouter/qwen/qwen3-4b:free', c)).toBe(true);
    expect(isExcluded('mistral/glm-5-2', c)).toBe(false);
  });

  it('is case-insensitive', () => {
    const c = ctx({ models: ['*FABLE*'] });
    expect(isExcluded('claude-bridge/claude-fable-5', c)).toBe(true);
  });
});

describe('isExcluded — paid_models_from (keep free tier, drop paid)', () => {
  it('excludes paid OpenRouter models but keeps free ones', () => {
    const c = ctx({ paid_models_from: ['openrouter'] });
    // Paid model (no :free, cost > 0)
    expect(isExcluded('openrouter/anthropic/claude-opus-5', c)).toBe(true);
    // Free model (has :free in ref)
    expect(isExcluded('openrouter/qwen/qwen3-4b:free', c)).toBe(false);
    // Free model (in free_models list, no :free in ref)
    expect(isExcluded('openrouter/openai/gpt-4o-mini:free', c)).toBe(false);
  });

  it('does not affect other providers', () => {
    const c = ctx({ paid_models_from: ['openrouter'] });
    expect(isExcluded('mistral/mistral-medium-3.5', c)).toBe(false);
  });

  it('keeps a discovered model with cost_per_m=0 even without :free tag', () => {
    const c = ctx(
      { paid_models_from: ['openrouter'] },
      {},
      {
        available_models: [
          { id: 'some-free-model', provider: 'openrouter', cost_per_m: 0 },
          { id: 'some-paid-model', provider: 'openrouter', cost_per_m: 3.5 },
        ],
      }
    );
    expect(isExcluded('openrouter/some-free-model', c)).toBe(false);
    expect(isExcluded('openrouter/some-paid-model', c)).toBe(true);
  });
});

describe('isExcluded — combined rules', () => {
  it('applies provider + model + paid rules together', () => {
    const c = ctx({
      providers: ['chutes'],
      models: ['*fable*'],
      paid_models_from: ['openrouter'],
    });
    expect(isExcluded('chutes/zai-org/GLM-5-TEE', c)).toBe(true); // provider
    expect(isExcluded('claude-bridge/claude-fable-5', c)).toBe(true); // model pattern
    expect(isExcluded('openrouter/anthropic/claude-opus-5', c)).toBe(true); // paid OR
    expect(isExcluded('openrouter/qwen/qwen3-4b:free', c)).toBe(false); // free OR kept
    expect(isExcluded('mistral/glm-5-2', c)).toBe(false); // unrelated
  });
});

describe('isExcluded — empty rules', () => {
  it('excludes nothing when rules are empty', () => {
    const c = ctx({});
    expect(isExcluded('openrouter/anthropic/claude-opus-5', c)).toBe(false);
    expect(isExcluded('anything/else', c)).toBe(false);
  });

  it('excludes nothing when rules are undefined', () => {
    const c = ctx(undefined);
    expect(isExcluded('anything', c)).toBe(false);
  });
});

describe('applyExcludes', () => {
  it('splits refs into kept and excluded', () => {
    const c = ctx({ models: ['*fable*'], paid_models_from: ['openrouter'] });
    const refs = [
      'claude-bridge/claude-fable-5',
      'claude-bridge/claude-opus-5',
      'openrouter/anthropic/claude-opus-5',
      'openrouter/qwen/qwen3-4b:free',
      'mistral/glm-5-2',
    ];
    const result = applyExcludes(refs, c);
    expect(result.excluded).toEqual([
      'claude-bridge/claude-fable-5',
      'openrouter/anthropic/claude-opus-5',
    ]);
    expect(result.kept).toEqual([
      'claude-bridge/claude-opus-5',
      'openrouter/qwen/qwen3-4b:free',
      'mistral/glm-5-2',
    ]);
  });
});
