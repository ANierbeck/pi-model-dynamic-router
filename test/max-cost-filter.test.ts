// test/max-cost-filter.test.ts
// Tests for the max_cost filter in resolveGroup.
//
// Bug: max_cost: 0 filtered out ALL Mistral models because effCost() returns
// 0.000020 (fallback) for models without OpenRouter pricing. This meant the
// `trivial` and `simple` groups had NO working models when OpenRouter free
// models were overloaded — causing "All candidates failed" errors.
//
// Fix: Models with unknown cost are now INCLUDED if their provider is not
// pay_per_token (i.e. subscription or local). For pay_per_token providers,
// unknown cost means we genuinely don't know the price → exclude to be safe.

import { describe, it, expect, beforeEach } from 'vitest';
import { Router } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.ts';
import type { Config, Cache } from '../src/types.ts';

function makeRouter(cfg: Config, cache: Cache): Router {
  metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
  metricsModule.setCache(cache);
  metricsModule.setGdpval(cache.gdpval_scores ?? {});
  metricsModule.setModelMap({}, []);
  return new Router(cfg, cache, new Map());
}

const BASE_CACHE: Cache = {
  available_models: [
    // OpenRouter free model (has pricing = 0)
    { id: 'qwen3-4b:free', provider: 'openrouter', cost_per_m: 0 },
    // OpenRouter paid model (has pricing > 0)
    { id: 'nemotron-ultra:free', provider: 'openrouter', cost_per_m: 0 },
    // Mistral model (no OpenRouter pricing → effCost returns fallback)
    { id: 'devstral-2512', provider: 'mistral', cost_per_m: 0 },
    { id: 'mistral-medium-2604', provider: 'mistral', cost_per_m: 0 },
    // Ollama local model
    { id: 'qwen3.5', provider: 'ollama', cost_per_m: 0 },
  ],
  gdpval_scores: {
    'devstral': 585,
    'mistral-medium-3-5': 933,
    'qwen3-4b': 400,
    'nemotron-ultra': 1162,
    'qwen3.5': 400,
  },
  model_score_cache: {
    'mistral/devstral-2512': 'devstral',
    'mistral/mistral-medium-2604': 'mistral-medium-3-5',
    'openrouter/qwen3-4b:free': 'qwen3-4b',
    'openrouter/nemotron-ultra:free': 'nemotron-ultra',
  },
  openrouter_pricing: {},
  usage_log: [],
  benchmarks: {},
  budget_cache: {},
  gdpval_scraped: true,
  lastScanTimestamp: Date.now(),
  models_cached: '',
} as any;

describe('max_cost filter with unknown-cost models', () => {
  let router: Router;

  beforeEach(() => {
    const cfg: Config = {
      model_groups: {
        trivial: {
          description: 'Trivial - free only',
          method: 'min_cost_if_all_priced',
          max_cost: 0,
          min_gdpval: 0,
          fallback_groups: ['scout'],
        },
        scout: {
          description: 'Any model',
          method: 'tiered',
          min_gdpval: 0,
          fallback_groups: [],
        },
      },
      providers: {
        openrouter: { billing: 'pay_per_token' },
        mistral: { billing: 'pay_per_token' },
      },
    } as any;
    router = makeRouter(cfg, BASE_CACHE);
  });

  it('trivial group (max_cost: 0) includes ollama and openrouter free models', () => {
    const top = router.getTopModels('trivial', 10);
    const refs = top.map((m) => m.ref);
    // Ollama models are local → cost 0 → included
    expect(refs.some((r) => r.startsWith('ollama/'))).toBe(true);
    // OpenRouter free models have cost 0 → included
    expect(refs.some((r) => r.includes(':free'))).toBe(true);
  });

  it('trivial group (max_cost: 0) includes mistral models with cost_per_m: 0', () => {
    const top = router.getTopModels('trivial', 10);
    const refs = top.map((m) => m.ref);
    // Mistral models have cost_per_m: 0 in cache → effCost returns 0 → included
    // This was the bug: effCost returned 0.000020 (fallback) for cost_per_m: 0
    expect(refs.some((r) => r.startsWith('mistral/'))).toBe(true);
  });

  it('scout group (no max_cost) includes all models', () => {
    const top = router.getTopModels('scout', 10);
    const refs = top.map((m) => m.ref);
    // Mistral models should be in scout (no max_cost filter)
    expect(refs.some((r) => r.startsWith('mistral/'))).toBe(true);
  });
});