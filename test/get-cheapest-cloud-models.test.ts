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

  // NOTE: the three curated-free-model tests that used to live here (testing
  // the hardcoded CURATED_FREE_MODELS list) have been REMOVED. That list was
  // a one-user workaround and has been replaced by the probe-based discovery
  // in src/classifier-fallback-probe.ts. Tests for the new behavior live in
  // test/classifier-fallback-probe.test.ts.
});
