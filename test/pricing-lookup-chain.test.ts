// test/pricing-lookup-chain.test.ts — Batch 2 of the mutation-survivor
// triage (docs/plans/2026-10-04-mutation-survivor-triage.md, Task 3; ledger:
// metrics.ts:900-1000). Closes the REAL-GAP survivors of the first nightly
// Stryker run in the pricing chain:
//
//   lookupPrice: registryCost (primary-vs-pricingAlias retry, non-number
//   costs, half-zero prices) → cfg.model_metrics cost (number AND 'unknown')
//   → orFallbackPrice (exact pricing-cache entry with the free-vs-unknown
//   distinction for {0,0}, same-model backfill skipping free-tier entries,
//   provider-level cost estimate).
//
// The chain's order is the contract: each stage must win over the ones
// after it, and each stage's special cases ('unknown' sentinels, {0,0}
// ambiguity, free-tier skip) must be preserved.

import { describe, it, expect, beforeAll } from 'vitest';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

// Registry fixtures: primary registration under an alias-carrying provider
// (mistral-zai carries pricingAlias: 'mistral'), the alias path, string
// costs, and a half-zero price.
const registry = {
  find: (provider: string, id: string) => {
    if (provider === 'mistral-zai' && id === 'alias-model') {
      return { id, provider, cost: { input: 1, output: 2 } };
    }
    if (provider === 'mistral' && id === 'alias-model-2') {
      return { id, provider, cost: { input: 3, output: 4 } };
    }
    if (provider === 'provx' && id === 'str-cost') {
      // Registered but unpriced — cost fields are strings, not numbers.
      return { id, provider, cost: { input: 'unknown', output: 'unknown' } };
    }
    if (provider === 'provx' && id === 'half-zero') {
      return { id, provider, cost: { input: 0, output: 5 } };
    }
    return undefined;
  },
};

const testConfig: Config = {
  model_groups: {},
  model_metrics: {
    'cfgx/costly': { gdpval: 100, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 3 },
    'cfgx/unknown-cost': { gdpval: 100, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 'unknown' },
    'provx/str-cost': { gdpval: 100, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 7 },
  },
  providers: {
    // cost_per_m doubles as the step-4 fallback for provx refs.
    provx: { billing: 'pay_per_token', cost_per_m: 9 },
    // NOTE: no free_models list anywhere — orFallbackPrice's
    // `?? []` default must hold without it.
  },
  gdpval_builtin: {},
} as any;

const cache: Cache = {
  available_models: [{ id: 'freebie', provider: 'openx', cost_per_m: 0 }],
  openrouter_pricing: {
    'cfgx/costly': { input: 8, output: 8 }, // must LOSE to model_metrics
    'openx/freebie': { input: 0, output: 0 }, // discovered free → {0,0}
    'openx/ghost': { input: 0, output: 0 }, // not discovered → 'unknown'
    'free/deep-model': { input: 0, output: 0 }, // free-tier backfill candidate — skipped
    'paid/Deep-Model': { input: 4, output: 4 }, // same-model backfill wins
  },
} as any;

beforeAll(() => {
  metricsModule.setConfig(testConfig);
  metricsModule.setCache(cache);
  metricsModule.setModelRegistry(registry as any);
});

describe('lookupPrice — registry stage (registryCost)', () => {
  it('a PRIMARY registration wins over the pricingAlias retry', () => {
    // mistral-zai carries pricingAlias 'mistral'; the model is registered
    // under mistral-zai itself. The alias retry must not overwrite a
    // primary hit with an alias miss.
    expect(metricsModule.lookupPrice('mistral-zai/alias-model')).toEqual({ input: 1, output: 2 });
  });

  it('the pricingAlias retry finds models registered under the alias provider', () => {
    expect(metricsModule.lookupPrice('mistral-zai/alias-model-2')).toEqual({ input: 3, output: 4 });
  });

  it('a registered model with NON-NUMBER cost falls through to the next stage', () => {
    // registryCost must reject string costs and let the fallback chain
    // speak — here model_metrics' 7, not the registry's 'unknown'.
    expect(metricsModule.lookupPrice('provx/str-cost')).toEqual({ input: 7, output: 7 });
  });

  it('a half-zero registry price is RETURNED — only {0,0} means free', () => {
    // {input: 0, output: 5} is a real price; treating it as free would
    // fall through to the provider estimate (9/9).
    expect(metricsModule.lookupPrice('provx/half-zero')).toEqual({ input: 0, output: 5 });
  });
});

describe('lookupPrice — model_metrics stage', () => {
  it('a configured cost_per_m wins over the pricing cache', () => {
    expect(metricsModule.lookupPrice('cfgx/costly')).toEqual({ input: 3, output: 3 });
  });

  it("cost_per_m: 'unknown' returns the unknown sentinel", () => {
    expect(metricsModule.lookupPrice('cfgx/unknown-cost')).toEqual({
      input: 'unknown',
      output: 'unknown',
    });
  });
});

describe('orFallbackPrice — pricing cache stage', () => {
  it('a {0,0} cache price for a DISCOVERED free model is genuinely free', () => {
    expect(metricsModule.lookupPrice('openx/freebie')).toEqual({ input: 0, output: 0 });
  });

  it("a {0,0} cache price for an UNDISCOVERED model resolves to 'unknown'", () => {
    // Not in available_models, not in any free_models list: the 0s are a
    // placeholder, not a promise — and the `?? []` default must hold even
    // without a configured free_models list.
    expect(metricsModule.lookupPrice('openx/ghost')).toEqual({
      input: 'unknown',
      output: 'unknown',
    });
  });

  it('same-model backfill: free-tier entries are SKIPPED, paid ones win', () => {
    // No exact entry, no registry, no metrics: the backfill must skip
    // free/deep-model {0,0} and find paid/Deep-Model via norm() matching.
    expect(metricsModule.lookupPrice('provx/deep-model')).toEqual({ input: 4, output: 4 });
  });

  it('no match anywhere → the provider-level cost estimate applies', () => {
    expect(metricsModule.lookupPrice('provx/whatever')).toEqual({ input: 9, output: 9 });
  });

  it('survives a null registry (registry stage is skipped, chain continues)', () => {
    metricsModule.setModelRegistry(null as any);
    try {
      expect(metricsModule.lookupPrice('cfgx/costly')).toEqual({ input: 3, output: 3 });
    } finally {
      metricsModule.setModelRegistry(registry as any);
    }
  });
});
