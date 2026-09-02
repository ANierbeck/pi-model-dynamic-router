// test/get-cheapest-cloud-models.test.ts
// Tests for DiscoveryManager.getCheapestCloudModels() — the dynamic
// cheapest-model discovery that replaces the hardcoded free_models list in
// the classifier cloud fallback. Works for any provider the user has keys
// for (OpenRouter, Mistral, Requesty, etc.) without requiring a
// hand-maintained free_models array.

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { DiscoveryManager } from '../src/discovery.js';
import * as metrics from '../src/metrics.js';
import type { Config, Cache } from '../src/types.ts';

// lookupPrice reads from metrics module state (setConfig/setCache), so we
// must seed it before each test.
function seedMetrics(cfg: Config, cache: Cache) {
  metrics.setConfig(cfg);
  metrics.setCache(cache);
}

const baseCfg: Config = {
  providers: {
    openrouter: {
      keys: [{ key: 'test-key' }],
      free_models: ['openrouter/mistral/mistral-small-3-2'],
    },
    mistral: {
      keys: [{ key: 'test-key' }],
    },
  },
  model_groups: {},
  model_metrics: {},
};

describe('DiscoveryManager.getCheapestCloudModels', () => {
  beforeEach(() => {
    seedMetrics(baseCfg, {});
  });

  afterEach(() => {
    // Reset metrics module state to avoid cross-test contamination
    metrics.setConfig({ model_groups: {}, model_metrics: {}, providers: {} });
    metrics.setCache({});
  });

  it('returns models from cache.available_models sorted by output price ascending', () => {
    const cache: Cache = {
      available_models: [
        { id: 'mistral-medium-3-5', provider: 'mistral', cost_per_m: 0 },
        { id: 'codestral-latest', provider: 'mistral', cost_per_m: 0 },
        { id: 'qwen3-4b:free', provider: 'openrouter', cost_per_m: 0 },
      ],
      openrouter_pricing: {
        'openrouter/mistral/mistral-small-3-2': { input: 0.2, output: 2.0 },
        'openrouter/qwen/qwen3-4b:free': { input: 0, output: 0 },
      },
    };
    // Add pricing for the mistral models via model_metrics
    const cfg: Config = {
      ...baseCfg,
      model_metrics: {
        'mistral/codestral-latest': { cost_per_m: 0.99, gdpval: 0 },
        'mistral/mistral-medium-3-5': { cost_per_m: 8.25, gdpval: 0 },
      },
    };
    seedMetrics(cfg, cache);

    const dm = new DiscoveryManager(cfg, cache);
    const result = dm.getCheapestCloudModels();

    // codestral ($0.99/M) < mistral-small ($2/M) < mistral-medium ($8.25/M, filtered out by $5 threshold)
    expect(result).toContain('mistral/codestral-latest');
    expect(result).toContain('openrouter/mistral/mistral-small-3-2');
    expect(result).not.toContain('mistral/mistral-medium-3-5'); // > $5/M threshold
    // codestral (0.99) should come before mistral-small (2.0)
    expect(result.indexOf('mistral/codestral-latest')).toBeLessThan(
      result.indexOf('openrouter/mistral/mistral-small-3-2')
    );
  });

  it('excludes local providers (ollama, lm-studio)', () => {
    const cache: Cache = {
      available_models: [
        { id: 'gemma4:12b-mlx', provider: 'ollama', cost_per_m: 0 },
        { id: 'codestral-latest', provider: 'mistral', cost_per_m: 0 },
      ],
    };
    const cfg: Config = {
      ...baseCfg,
      model_metrics: {
        'mistral/codestral-latest': { cost_per_m: 0.99, gdpval: 0 },
      },
    };
    seedMetrics(cfg, cache);

    const dm = new DiscoveryManager(cfg, cache);
    const result = dm.getCheapestCloudModels();

    expect(result).not.toContain('ollama/gemma4:12b-mlx');
    expect(result).toContain('mistral/codestral-latest');
  });

  it('includes free_models from config even when not in cache.available_models', () => {
    const cache: Cache = {
      openrouter_pricing: {
        'openrouter/mistral/mistral-small-3-2': { input: 0.2, output: 2.0 },
      },
    };
    const cfg: Config = {
      ...baseCfg,
      model_metrics: {},
    };
    seedMetrics(cfg, cache);

    const dm = new DiscoveryManager(cfg, cache);
    const result = dm.getCheapestCloudModels();

    // free_models entry with pricing from openrouter_pricing
    expect(result).toContain('openrouter/mistral/mistral-small-3-2');
  });

  it('filters out models with unknown pricing', () => {
    const cache: Cache = {
      available_models: [
        { id: 'unknown-model', provider: 'mistral', cost_per_m: 0 },
      ],
      // No pricing info at all for this model
    };
    seedMetrics(baseCfg, cache);

    const dm = new DiscoveryManager(baseCfg, cache);
    const result = dm.getCheapestCloudModels();

    expect(result).not.toContain('mistral/unknown-model');
  });

  it('returns empty array when no cloud models have known pricing', () => {
    const cache: Cache = {
      available_models: [
        { id: 'gemma4:12b-mlx', provider: 'ollama', cost_per_m: 0 },
      ],
    };
    seedMetrics(baseCfg, cache);

    const dm = new DiscoveryManager(baseCfg, cache);
    const result = dm.getCheapestCloudModels();

    expect(result).toEqual([]);
  });

  it('respects maxPricePerM threshold', () => {
    const cache: Cache = {
      available_models: [
        { id: 'codestral-latest', provider: 'mistral', cost_per_m: 0 },
        { id: 'mistral-medium-3-5', provider: 'mistral', cost_per_m: 0 },
      ],
    };
    const cfg: Config = {
      ...baseCfg,
      model_metrics: {
        'mistral/codestral-latest': { cost_per_m: 0.99, gdpval: 0 },
        'mistral/mistral-medium-3-5': { cost_per_m: 8.25, gdpval: 0 },
      },
    };
    seedMetrics(cfg, cache);

    const dm = new DiscoveryManager(cfg, cache);
    // With default $5/M threshold, codestral ($0.99) passes, mistral-medium ($8.25) doesn't
    const result = dm.getCheapestCloudModels(5, 10);
    expect(result).toContain('mistral/codestral-latest');
    expect(result).not.toContain('mistral/mistral-medium-3-5');

    // With $10/M threshold, both pass
    const result2 = dm.getCheapestCloudModels(10, 10);
    expect(result2).toContain('mistral/codestral-latest');
    expect(result2).toContain('mistral/mistral-medium-3-5');
  });

  it('limits results to maxResults', () => {
    const cache: Cache = {
      available_models: [
        { id: 'codestral-latest', provider: 'mistral', cost_per_m: 0 },
        { id: 'mistral-medium-3-5', provider: 'mistral', cost_per_m: 0 },
        { id: 'devstral-latest', provider: 'mistral', cost_per_m: 0 },
      ],
    };
    const cfg: Config = {
      ...baseCfg,
      model_metrics: {
        'mistral/codestral-latest': { cost_per_m: 0.99, gdpval: 0 },
        'mistral/mistral-medium-3-5': { cost_per_m: 2.0, gdpval: 0 },
        'mistral/devstral-latest': { cost_per_m: 1.5, gdpval: 0 },
      },
    };
    seedMetrics(cfg, cache);

    const dm = new DiscoveryManager(cfg, cache);
    const result = dm.getCheapestCloudModels(5, 2);
    expect(result).toHaveLength(2);
    // Sorted by price: codestral (0.99) < devstral (1.5) < mistral-medium (2.0)
    expect(result[0]).toBe('mistral/codestral-latest');
    expect(result[1]).toBe('mistral/devstral-latest');
  });

  it('works when no providers have keys (returns empty, no crash)', () => {
    const cache: Cache = {};
    const cfg: Config = {
      model_groups: {},
      model_metrics: {},
      providers: {
        openrouter: {
          // No keys, no free_models
        },
      },
    };
    seedMetrics(cfg, cache);

    const dm = new DiscoveryManager(cfg, cache);
    const result = dm.getCheapestCloudModels();
    expect(result).toEqual([]);
  });

  it('prepends curated genuinely-free Mistral models before placeholder-$0 models', () => {
    // Regression: all 46 mistral-zai models carry cost_per_m: 0 as a hardcoded
    // placeholder (the scan never fetches real Mistral pricing). getCheapestCloudModels
    // sorts by lookupPrice, so all 46 appear to cost $0/M. Ties are broken
    // alphabetically — zai-glm-5-2 wins (last among the tied models), even though
    // mistral-small-latest is genuinely FREE on Mistral's API and would be a far
    // better classifier choice.
    //
    // The fix: curated free models are prepended to the result, so
    // mistral-small-latest appears before any placeholder-$0 model.
    const cache: Cache = {
      available_models: [
        // placeholder-$0 models (scan never fetched real pricing)
        { id: 'zai-glm-5-2', provider: 'mistral-zai', cost_per_m: 0 },
        { id: 'mistral-medium-latest', provider: 'mistral-zai', cost_per_m: 0 },
        { id: 'mistral-small-latest', provider: 'mistral-zai', cost_per_m: 0 },
        { id: 'mistral-small-latest', provider: 'mistral', cost_per_m: 0 },
        // magistral-small-latest is also in CURATED_FREE_MODELS and must be present
        // in available_models to be included in results (note: "magistral" with i)
        { id: 'magistral-small-latest', provider: 'mistral-zai', cost_per_m: 0 },
      ],
      // No openrouter_pricing data for any of these
    };

    // Give zai-glm-5-2 a price via model_metrics. This mirrors reality: the
    // scan has a placeholder $0 cost for mistral-zai models via the
    // provider-level cost_per_m fallback in lookupPrice, so zai-glm-5-2 DOES
    // appear in pricedResults (with output=$0). Without pricing data, pricedResults
    // would be empty and zai-glm-5-2 would not appear at all — which is the
    // bug this test is checking the fix for.
    const cfgWithPrice: Config = {
      ...baseCfg,
      model_metrics: {
        // provider-level fallback gives zai-glm-5-2 a $0 price (placeholder)
        'mistral-zai/zai-glm-5-2': { cost_per_m: 0, gdpval: 0 },
        // mistral-medium-latest also gets a placeholder $0 price
        'mistral-zai/mistral-medium-latest': { cost_per_m: 0, gdpval: 0 },
      },
    };
    seedMetrics(cfgWithPrice, cache);

    const dm = new DiscoveryManager(cfgWithPrice, cache);
    // maxResults=6 to see placeholders after all 3 matching curated models
    const result = dm.getCheapestCloudModels(5, 6);

    // curated models must be first (mistral-zai variants first — user's preferred prefix)
    expect(result[0]).toBe('mistral-zai/mistral-small-latest');
    expect(result[1]).toBe('mistral/mistral-small-latest');
    expect(result[2]).toBe('mistral-zai/magistral-small-latest');
    // zai-glm-5-2 (placeholder-$0, alphabetically last among the 46 tied models)
    // must come AFTER the curated entries (at index >= 3)
    expect(result.indexOf('mistral-zai/zai-glm-5-2')).toBeGreaterThanOrEqual(3);
    // mistral-medium-latest (placeholder-$0) also comes after curated entries
    expect(result.indexOf('mistral-zai/mistral-medium-latest')).toBeGreaterThanOrEqual(3);
  });

  it('only includes curated models that are in available_models (notinvented entries)', () => {
    // If a curated model is not in the scan cache, it should NOT appear in results
    const cache: Cache = {
      available_models: [
        // only mistral-small-latest (mistral-zai) is in the cache
        { id: 'mistral-small-latest', provider: 'mistral-zai', cost_per_m: 0 },
        // magistral-small-latest is NOT in the cache
      ],
    };
    seedMetrics(baseCfg, cache);

    const dm = new DiscoveryManager(baseCfg, cache);
    const result = dm.getCheapestCloudModels();

    // mistral-zai/mistral-small-latest: in cache → included
    expect(result).toContain('mistral-zai/mistral-small-latest');
    // magistral-small-latest: NOT in cache → excluded (even though it's in CURATED_FREE_MODELS)
    expect(result).not.toContain('mistral-zai/magistral-small-latest');
    // mistral/mistral-small-latest: NOT in cache (only mistral-zai variant) → excluded
    expect(result).not.toContain('mistral/mistral-small-latest');
  });

  it('de-duplicates: curated model that also appears in priced results appears only once', () => {
    // Edge case: if a curated model somehow also has real pricing (e.g. future where
    // we add per-model pricing for mistral-small), it should appear once, not twice.
    const cache: Cache = {
      available_models: [
        { id: 'mistral-small-latest', provider: 'mistral-zai', cost_per_m: 0 },
        { id: 'zai-glm-5-2', provider: 'mistral-zai', cost_per_m: 0 },
      ],
      // mistral-small-latest has real pricing (hypothetical future state)
      openrouter_pricing: {
        'mistral-zai/mistral-small-latest': { input: 0, output: 0 },
      },
    };
    seedMetrics(baseCfg, cache);

    const dm = new DiscoveryManager(baseCfg, cache);
    const result = dm.getCheapestCloudModels();

    // mistral-small-latest should appear exactly once (curated de-dup takes precedence)
    const occurrences = result.filter((r) => r === 'mistral-zai/mistral-small-latest');
    expect(occurrences).toHaveLength(1);
  });
});
