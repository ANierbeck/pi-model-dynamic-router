// Regression tests for the sortByMinCostIfAllPriced unknown-cost fix
// (2026-09-26, live /router scan finding).
//
// BUG: a single model with 'unknown' effCost flipped the ENTIRE group to
// best-gdpval ordering — "cheapest first" became "strongest first". In
// production this put pi-claude/claude-sonnet-5 (gdpval 1603) on rank 1 of
// the trivial group, routing "what's in this file?"-style prompts to the
// most expensive subscription model, burning the Claude time limit.
//
// FIX: unknown-cost models sort to the END (sortByMinCost's existing
// convention); priced models keep their cost ordering; cost ties fall back
// to gdpval (higher first) among priced models.
//
// Also covers collectUnknownCostRefs — the scan-time diagnostic that logs
// WHICH refs are unpriced so the next /router scan surfaces them.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { Router } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

// Registry prices: sonnet $2/$10, gpt-4 $10/$30. ling-3.0:free and the
// unknown ref are deliberately NOT in the registry.
const registry = {
  find: (provider: string, id: string) => {
    if (provider === 'pi-claude' && id === 'claude-sonnet-5') {
      return { id: 'claude-sonnet-5', provider: 'pi-claude', cost: { input: 2.0, output: 10.0 } };
    }
    if (provider === 'openai' && id === 'gpt-4') {
      return { id: 'gpt-4', provider: 'openai', cost: { input: 10.0, output: 30.0 } };
    }
    return undefined;
  },
};

const testConfig: Config = {
  model_groups: {},
  model_metrics: {
    // gdpval fixtures only — cost_per_m deliberately UNSET so the models
    // resolve their cost via the chain (registry / :free / unknown).
    'pi-claude/claude-sonnet-5': { gdpval: 1603, throughput_tps: 100, avg_latency_ms: 1000 },
    'pi-claude/claude-opus-unknown': { gdpval: 2000, throughput_tps: 100, avg_latency_ms: 1000 },
    'openrouter/ling-3.0-flash-fin:free': { gdpval: 1092, throughput_tps: 100, avg_latency_ms: 1000 },
    'openrouter/glm-5.2:free': { gdpval: 1497, throughput_tps: 100, avg_latency_ms: 1000 },
    'openai/gpt-4': { gdpval: 980, throughput_tps: 15, avg_latency_ms: 150 },
    // Static trivial/simple-style local model for mixed pools.
    'ollama/gemma4:12b-mlx': { gdpval: 460, throughput_tps: 40, avg_latency_ms: 500 },
  },
  providers: {
    // pi-claude/openrouter/openai intentionally NOT configured — matching
    // the production state where only openrouter has a cfg entry.
  },
  gdpval_builtin: {},
} as any;

const cache: Cache = {
  available_models: [{ id: 'gemma4:12b-mlx', provider: 'ollama', cost_per_m: 0 }],
} as any;

beforeAll(() => {
  metricsModule.setConfig(testConfig);
  metricsModule.setCache(cache);
  metricsModule.setModelRegistry(registry as any);
});

describe('sortByMinCostIfAllPriced — unknown-cost handling (2026-09-26 fix)', () => {
  const router = new Router(testConfig, cache, new Map());

  it('a single unknown-cost model no longer flips the group to best-gdpval ordering', () => {
    // opus-unknown has the HIGHEST gdpval (2000) and unknown cost.
    // OLD behavior: [opus-unknown (gdpval sort), sonnet ($2), ling ($0)] —
    // the exact Sonnet-on-rank-1-of-trivial production misroute shape.
    const sorted = router.sortByMinCostIfAllPriced([
      'pi-claude/claude-sonnet-5',
      'pi-claude/claude-opus-unknown',
      'openrouter/ling-3.0-flash-fin:free',
    ]);
    // NEW: priced by cost first ($0 free, $2 payg), unknown at the END.
    expect(sorted).toEqual([
      'openrouter/ling-3.0-flash-fin:free',
      'pi-claude/claude-sonnet-5',
      'pi-claude/claude-opus-unknown',
    ]);
  });

  it('keeps sorting by cost when ALL models are priced (allPriced path unchanged)', () => {
    const sorted = router.sortByMinCostIfAllPriced([
      'openai/gpt-4', // $10
      'pi-claude/claude-sonnet-5', // $2
      'openrouter/ling-3.0-flash-fin:free', // $0
    ]);
    expect(sorted).toEqual([
      'openrouter/ling-3.0-flash-fin:free',
      'pi-claude/claude-sonnet-5',
      'openai/gpt-4',
    ]);
  });

  it('cost ties among priced models still fall back to higher gdpval', () => {
    // Both :free → $0 tie → glm-5.2 (1497) before ling (1092).
    const sorted = router.sortByMinCostIfAllPriced([
      'openrouter/ling-3.0-flash-fin:free',
      'openrouter/glm-5.2:free',
    ]);
    expect(sorted).toEqual(['openrouter/glm-5.2:free', 'openrouter/ling-3.0-flash-fin:free']);
  });

  it('local $0 models sort by cost alongside free models (both $0, gdpval tiebreak)', () => {
    const sorted = router.sortByMinCostIfAllPriced([
      'pi-claude/claude-sonnet-5',
      'ollama/gemma4:12b-mlx',
    ]);
    expect(sorted).toEqual(['ollama/gemma4:12b-mlx', 'pi-claude/claude-sonnet-5']);
  });
});

describe('collectUnknownCostRefs — scan-time diagnostic', () => {
  beforeEach(() => {
    // getM caches per ref; refs are unique per test so no reset needed.
  });

  it('returns only the refs whose effCost is unknown', () => {
    const unknown = metricsModule.collectUnknownCostRefs([
      'pi-claude/claude-sonnet-5', // priced $2 via registry
      'pi-claude/claude-opus-unknown', // unknown
      'openrouter/ling-3.0-flash-fin:free', // free $0
    ]);
    expect(unknown).toEqual(['pi-claude/claude-opus-unknown']);
  });

  it('returns an empty list when everything is priced', () => {
    const unknown = metricsModule.collectUnknownCostRefs([
      'pi-claude/claude-sonnet-5',
      'openrouter/ling-3.0-flash-fin:free',
    ]);
    expect(unknown).toEqual([]);
  });
});
