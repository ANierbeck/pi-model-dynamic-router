// test/unified-free-definition.test.ts
// Pins the SINGLE source of truth for "is this model free?".
//
// Previously billingTier (metrics.ts, only cost_per_m===0) and isFreeModel
// (exclude.ts, free_models list + :free + cost_per_m===0) disagreed: an
// OpenRouter :free model listed in free_models but discovered with
// cost_per_m>0 was "free" to exclude.ts but "payg" to billingTier. Now both
// go through isFreeModelRef, so fmtModel, sortByBillingPreference, and
// paid_models_from exclusion can never disagree.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  billingTier,
  isFreeModel,
  isFreeModelRef,
  setConfig,
  setCache,
} from '../src/metrics.js';
import { isExcluded } from '../src/exclude.js';
import type { Config, Cache } from '../src/types.js';

beforeEach(() => {
  setConfig({ model_groups: {}, model_metrics: {} });
  setCache({});
});

describe('isFreeModelRef — pure helper (the single source)', () => {
  const providers: Config['providers'] = {
    openrouter: {
      billing: 'pay_per_token',
      free_models: [
        'openrouter/qwen/qwen3-4b:free',
        'openrouter/openai/gpt-4o-mini:free',
      ],
    },
  };
  const available_models = [
    { id: 'qwen/qwen3-4b:free', provider: 'openrouter', cost_per_m: 0 },
    { id: 'some-paid-model', provider: 'openrouter', cost_per_m: 3.5 },
    { id: 'some-free-model', provider: 'openrouter', cost_per_m: 0 },
  ];

  it('recognizes the :free tag', () => {
    expect(isFreeModelRef('openrouter/qwen/qwen3-4b:free', providers, available_models)).toBe(true);
  });

  it('recognizes the free_models config list (full ref form)', () => {
    expect(isFreeModelRef('openrouter/qwen/qwen3-4b:free', providers, [])).toBe(true);
  });

  it('recognizes discovered cost_per_m === 0 (no :free tag, not in list)', () => {
    expect(isFreeModelRef('openrouter/some-free-model', providers, available_models)).toBe(true);
  });

  it('returns false for a paid model', () => {
    expect(isFreeModelRef('openrouter/some-paid-model', providers, available_models)).toBe(false);
  });

  it('returns true for local providers (ollama is $0)', () => {
    expect(isFreeModelRef('ollama/gemma4:12b-mlx', providers, [])).toBe(true);
  });
});

describe('billingTier and isFreeModelRef agree (no divergence)', () => {
  // The bug: an OpenRouter :free model was "free" to exclude.ts but "payg"
  // (tier 3) to billingTier, because billingTier only checked cost_per_m===0
  // and ignored the free_models list. Now billingTier checks all three.
  it('a :free model is tier 0 (free) even if discovered cost_per_m is unknown', () => {
    const providers: Config['providers'] = {
      openrouter: { billing: 'pay_per_token', free_models: ['openrouter/free-x:free'] },
    };
    setConfig({ providers, model_groups: {}, model_metrics: {} });
    setCache({ available_models: [] }); // no discovered cost info

    expect(billingTier('openrouter/free-x:free')).toBe(0);
  });

  it('a model in free_models (non-:free form) is tier 0', () => {
    const providers: Config['providers'] = {
      openrouter: { billing: 'pay_per_token', free_models: ['openrouter/meta/llama-3.3-70b'] },
    };
    setConfig({ providers, model_groups: {}, model_metrics: {} });
    setCache({ available_models: [] });

    expect(billingTier('openrouter/meta/llama-3.3-70b')).toBe(0);
  });

  it('a discovered cost_per_m===0 model is tier 0', () => {
    setConfig({ providers: {}, model_groups: {}, model_metrics: {} });
    setCache({
      available_models: [
        { id: 'free-by-cost', provider: 'openrouter', cost_per_m: 0 },
      ],
    });
    expect(billingTier('openrouter/free-by-cost')).toBe(0);
  });

  it('a paid openrouter model is tier 3 (payg)', () => {
    setConfig({ providers: {}, model_groups: {}, model_metrics: {} });
    setCache({
      available_models: [
        { id: 'paid-model', provider: 'openrouter', cost_per_m: 5 },
      ],
    });
    expect(billingTier('openrouter/paid-model')).toBe(3);
  });

  it('isFreeModel (modul-state convenience) matches isFreeModelRef (pure)', () => {
    const providers: Config['providers'] = {
      openrouter: { billing: 'pay_per_token', free_models: ['openrouter/free-x:free'] },
    };
    setConfig({ providers, model_groups: {}, model_metrics: {} });
    setCache({ available_models: [] });

    const ref = 'openrouter/free-x:free';
    expect(isFreeModel(ref)).toBe(isFreeModelRef(ref, providers, []));
    expect(isFreeModel(ref)).toBe(true);
  });
});

describe('exclude.ts paid_models_from uses the same free definition', () => {
  // The original divergence site: exclude.ts had its own isFreeModel; now it
  // delegates to isFreeModelRef. A :free model must NOT be excluded.
  it('does not exclude a :free model from a paid_models_from provider', () => {
    const cfg: Config = {
      providers: {
        openrouter: {
          billing: 'pay_per_token',
          free_models: ['openrouter/qwen/qwen3-4b:free'],
        },
      },
      model_groups: {},
      model_metrics: {},
    };
    const cache: Cache = { available_models: [] };
    expect(isExcluded('openrouter/qwen/qwen3-4b:free', { rules: { paid_models_from: ['openrouter'] }, cfg, cache })).toBe(false);
  });

  it('excludes a paid model from a paid_models_from provider', () => {
    const cfg: Config = {
      providers: { openrouter: { billing: 'pay_per_token' } },
      model_groups: {},
      model_metrics: {},
    };
    const cache: Cache = {
      available_models: [
        { id: 'paid-model', provider: 'openrouter', cost_per_m: 5 },
      ],
    };
    expect(isExcluded('openrouter/paid-model', { rules: { paid_models_from: ['openrouter'] }, cfg, cache })).toBe(true);
  });
});
