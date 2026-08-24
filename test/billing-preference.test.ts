// test/billing-preference.test.ts
// Tests for the per-group `billing_preference: "local_first"` override.
//
// BACKGROUND: `method: "tiered"` sorts by billing tier first
// (free → subscription → local → payg), so local Ollama models always
// ranked behind subscription cloud models (e.g. Mistral) even in scout,
// where local $0-Modelle conceptually belong on top. The override lets a
// group rank local models AHEAD of subscription (but still after truly-free).

import { describe, it, expect, beforeAll } from 'vitest';
import { Router } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

const testConfig: Config = {
  model_groups: {},
  model_metrics: {
    'mistral/mistral-medium-latest': { gdpval: 933, throughput_tps: 100, avg_latency_ms: 1000 },
    'ollama/gemma4:12b-mlx': { gdpval: 460, throughput_tps: 40, avg_latency_ms: 500 },
    'ollama/qwen3-8-27b': { gdpval: 580, throughput_tps: 35, avg_latency_ms: 600 },
    'openai/gpt-4': { gdpval: 980, throughput_tps: 15, avg_latency_ms: 150 },
  },
  providers: {
    mistral: { billing: 'subscription' },
    openai: { billing: 'payg' },
    // ollama is local via PROVIDER_MAP — no config needed
  },
  gdpval_builtin: {},
};

const cache: Cache = {
  available_models: [
    { id: 'mistral-medium-latest', provider: 'mistral', cost_per_m: 0 },
    { id: 'gemma4:12b-mlx', provider: 'ollama', cost_per_m: 0 },
    { id: 'qwen3-8-27b', provider: 'ollama', cost_per_m: 0 },
    { id: 'gpt-4', provider: 'openai', cost_per_m: 10 },
  ],
};

beforeAll(() => {
  metricsModule.setConfig(testConfig);
  metricsModule.setCache(cache);
});

describe('sortByBillingPreference — default ordering (free → subscription → local → payg)', () => {
  const router = new Router(testConfig, cache, new Map());

  it('ranks subscription (Mistral) ahead of local (Ollama) by default', () => {
    const sorted = router.sortByBillingPreference([
      'ollama/gemma4:12b-mlx',
      'mistral/mistral-medium-latest',
    ]);
    expect(sorted[0]).toBe('mistral/mistral-medium-latest');
    expect(sorted[1]).toBe('ollama/gemma4:12b-mlx');
  });

  it('ranks payg (OpenAI) last regardless of gdpval', () => {
    const sorted = router.sortByBillingPreference([
      'openai/gpt-4',
      'ollama/gemma4:12b-mlx',
      'mistral/mistral-medium-latest',
    ]);
    // subscription(1) < local(2) < payg(3)
    expect(sorted[0]).toBe('mistral/mistral-medium-latest');
    expect(sorted[1]).toBe('ollama/gemma4:12b-mlx');
    expect(sorted[2]).toBe('openai/gpt-4');
  });
});

describe('sortByBillingPreference — local_first override', () => {
  const router = new Router(testConfig, cache, new Map());

  it('ranks local (Ollama) AHEAD of subscription (Mistral) with local_first', () => {
    const sorted = router.sortByBillingPreference(
      [
        'mistral/mistral-medium-latest',
        'ollama/gemma4:12b-mlx',
      ],
      'local_first'
    );
    expect(sorted[0]).toBe('ollama/gemma4:12b-mlx');
    expect(sorted[1]).toBe('mistral/mistral-medium-latest');
  });

  it('still ranks payg (OpenAI) last with local_first', () => {
    const sorted = router.sortByBillingPreference(
      [
        'openai/gpt-4',
        'mistral/mistral-medium-latest',
        'ollama/gemma4:12b-mlx',
      ],
      'local_first'
    );
    // local(0.5) < subscription(1) < payg(3) — local first, payg still last
    expect(sorted[0]).toBe('ollama/gemma4:12b-mlx');
    expect(sorted[1]).toBe('mistral/mistral-medium-latest');
    expect(sorted[2]).toBe('openai/gpt-4');
  });

  it('within local tier, higher gdpval still wins (tiebreak preserved)', () => {
    const sorted = router.sortByBillingPreference(
      [
        'ollama/gemma4:12b-mlx',   // gdpval 460
        'ollama/qwen3-8-27b',      // gdpval 580
        'mistral/mistral-medium-latest',
      ],
      'local_first'
    );
    expect(sorted[0]).toBe('ollama/qwen3-8-27b'); // higher gdpval first within local
    expect(sorted[1]).toBe('ollama/gemma4:12b-mlx');
    expect(sorted[2]).toBe('mistral/mistral-medium-latest');
  });

  it('local_first is opt-in: default ordering unchanged when not passed', () => {
    const sorted = router.sortByBillingPreference([
      'ollama/gemma4:12b-mlx',
      'mistral/mistral-medium-latest',
    ]);
    // No override → default ordering (subscription before local)
    expect(sorted[0]).toBe('mistral/mistral-medium-latest');
    expect(sorted[1]).toBe('ollama/gemma4:12b-mlx');
  });
});
