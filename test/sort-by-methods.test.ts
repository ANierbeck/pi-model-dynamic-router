// test/sort-by-methods.test.ts — Batch 1 of the mutation-survivor triage
// (docs/plans/2026-10-04-mutation-survivor-triage.md, ledger: routing.ts
// 600-760). Closes the REAL-GAP survivors found by the first nightly Stryker
// run (score 56.4%, report 2026-10-04/05):
//
//   1. sortBy's simple method branches (min_latency / max_throughput /
//      min_cost / min_cost_if_all_priced / max_gdpval) were NEVER driven
//      through the public sortBy dispatch — the sort bodies had
//      NoCoverage, the dispatch conditions survived.
//   2. The best_quality_window pool comparator (unknown-cost placement,
//      cost ties → least overkill) was only exercised on the
//      claude-bridge sunk-cost shape; mixed known/unknown pools and the
//      exact floor boundary were unasserted.
//   3. sortByBillingPreference's rank tables were masked by fixtures whose
//      cost tiebreaks produced the expected order anyway; the
//      subscription-tier limit-pressure preference (limitSecs) and the
//      unknown-cost ordering had NoCoverage.
//   4. The filterByBudget wrapper was never called with a populated
//      budget_cache; filterAvailable was never called with a limited ref.
//
// Fixtures deliberately ANTI-CORRELATE cost, gdpval and expected rank so
// ONLY the code under test can produce the asserted order — a masked
// fixture is exactly how the rank-table mutants survived the suite.

import { describe, it, expect, beforeAll } from 'vitest';
import { Router } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import { effCost } from '../src/metrics.js';
import type { Config, Cache, RateLimit } from '../src/types.js';

// Registry: only the unknown-cost fixtures resolve here (input 'unknown'
// is the documented sentinel for "provider lists the model but has no
// price"). Everything else must resolve via model_metrics.
const registry = {
  find: (provider: string, id: string) => {
    if (provider === 'poolx' && (id === 'unk-hi' || id === 'unk-lo' || id === 'unk-leader')) {
      return { id, provider: 'poolx', cost: { input: 'unknown', output: 'unknown' } };
    }
    if (provider === 'paygx' && (id === 'unk-bill' || id === 'unk-bill-2')) {
      return { id, provider: 'paygx', cost: { input: 'unknown', output: 'unknown' } };
    }
    return undefined;
  },
};

const testConfig: Config = {
  model_groups: {},
  model_metrics: {
    // ── Section 1: simple sortBy methods. Latency/throughput/gdpval/cost
    // are spread across DIFFERENT models so each method's ordering can
    // only come from the metric it actually sorts by.
    'cloudx/lat-heavy': { gdpval: 700, throughput_tps: 20, avg_latency_ms: 900, cost_per_m: 3 },
    'cloudx/lat-light': { gdpval: 500, throughput_tps: 50, avg_latency_ms: 200, cost_per_m: 1 },
    'cloudx/lat-center': { gdpval: 600, throughput_tps: 80, avg_latency_ms: 500, cost_per_m: 2 },

    // ── Section 2: best_quality_window pool (window 0.05, top 1000).
    // Anti-correlated: cheapest pool members have mid scores, the score
    // leader is the most expensive, unknowns are score-strong.
    'poolx/top': { gdpval: 1000, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 1.0 },
    'poolx/unk-hi': { gdpval: 990, throughput_tps: 100, avg_latency_ms: 1000 },
    'poolx/unk-lo': { gdpval: 980, throughput_tps: 100, avg_latency_ms: 1000 },
    'poolx/cheap-tie': { gdpval: 970, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 0.2 },
    'poolx/over-tie': { gdpval: 965, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 0.2 },
    'poolx/mid': { gdpval: 800, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 0.01 },

    // unknown-cost score leader: registry lists it, but with no price.
    'poolx/unk-leader': { gdpval: 1000, throughput_tps: 100, avg_latency_ms: 1000 },
    'poolx/known-second': { gdpval: 990, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 0.5 },

    // ── Section 2b: window OFF + tied top scores (cost must NOT reorder),
    // and the exact-floor boundary test (w=0.5 → FP-exact floor).
    'tiew/tie-a': { gdpval: 1000, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 2.0 },
    'tiew/tie-b': { gdpval: 1000, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 0.5 },
    'tiew/low': { gdpval: 900, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 0.01 },
    'wedg/wtop': { gdpval: 1000, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 1.0 },
    'wedg/wedge': { gdpval: 500, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 0.001 },

    // ── Section 3: billing preference. All four tiers present, costs
    // TIED (0 except payg 0.001 — the minimum a payg model can cost
    // without collapsing to free tier), gdpval ANTI-correlated with rank:
    // the cost tiebreak orders local→sub→free (gdpval desc), so only the
    // rank table can produce the asserted order.
    'openrouter/nocost-a:free': { gdpval: 100, throughput_tps: 100, avg_latency_ms: 1000 },
    // Real cost (0.05 → effCost 0.025 after the 0.5 subscription discount):
    // deliberately ABOVE the payg fixture's 0.001 — when a rank-table
    // mutation ties subscription with payg, the cost tiebreak must put
    // PAYG first (observable RED), not coincidentally rescue the order.
    'mistral/planx-one': { gdpval: 200, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 0.05 },
    'ollama/daemonx-one': { gdpval: 300, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 0 },
    'openai/coinx-one': { gdpval: 400, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 0.001 },

    // subscription pair for the limitSecs preference (equal cost, equal
    // tier — ONLY limit pressure can discriminate; gdpval favors the
    // high-pressure model to make a gdpval tiebreak visible as RED).
    'mistral/planx-calm': { gdpval: 900, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 0 },
    'mistral/planx-busy': { gdpval: 950, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 0 },

    // free pair for the "limitSecs applies ONLY to subscription tier"
    // contract (gdpval favors the high-pressure model).
    'openrouter/nocost-busy:free': { gdpval: 950, throughput_tps: 100, avg_latency_ms: 1000 },

    // ── Section 3b: unknown costs through the billing sort.
    'paygx/unk-bill': { gdpval: 2000, throughput_tps: 100, avg_latency_ms: 1000 },
    'paygx/unk-bill-2': { gdpval: 1500, throughput_tps: 100, avg_latency_ms: 1000 },
    'paygx/known-bill': { gdpval: 100, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 5 },

    // ── Section 4/5 fixtures.
    'mistral/sub-a': { gdpval: 100, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 0 },
    'mistral/sub-b': { gdpval: 110, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 0 },
    'openai/payg-ok': { gdpval: 120, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 1 },
    'ollama/local-ok': { gdpval: 130, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 0 },
    'openai/limited-one': { gdpval: 140, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 1 },
    'openai/healthy-two': { gdpval: 150, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 1 },
  },
  providers: {
    mistral: { billing: 'subscription' },
    openai: { billing: 'pay_per_token' },
    // ollama → local tier via PROVIDER_MAP; :free refs → tier 0 via the tag.
  },
  // calculateScore (scoreOf) reads gdpval from gdpval_builtin via lookupGdp.
  gdpval_builtin: {
    'top': 1000, 'unk-leader': 1000, 'known-second': 990, 'unk-hi': 990, 'unk-lo': 980, 'cheap-tie': 970, 'over-tie': 965, 'mid': 800,
    'tie-a': 1000, 'tie-b': 1000, 'low': 900,
    'wtop': 1000, 'wedge': 500,
    'sub-a': 100, 'sub-b': 110,
  },
} as any;

const cache: Cache = { available_models: [] } as any;

beforeAll(() => {
  metricsModule.setConfig(testConfig);
  metricsModule.setCache(cache);
  metricsModule.setModelRegistry(registry as any);
});

// Section 1 ─────────────────────────────────────────────────────────────────

describe('sortBy — method dispatch (simple sort methods)', () => {
  const router = new Router(testConfig, cache, new Map());
  const POOL = ['cloudx/lat-heavy', 'cloudx/lat-light', 'cloudx/lat-center'];

  it('min_latency: ascending avg_latency_ms', () => {
    expect(router.sortBy([...POOL], 'min_latency')).toEqual([
      'cloudx/lat-light',
      'cloudx/lat-center',
      'cloudx/lat-heavy',
    ]);
  });

  it('max_throughput: descending throughput_tps', () => {
    expect(router.sortBy([...POOL], 'max_throughput')).toEqual([
      'cloudx/lat-center',
      'cloudx/lat-light',
      'cloudx/lat-heavy',
    ]);
  });

  it('max_gdpval: descending gdpval', () => {
    expect(router.sortBy([...POOL], 'max_gdpval')).toEqual([
      'cloudx/lat-heavy',
      'cloudx/lat-center',
      'cloudx/lat-light',
    ]);
  });

  it('min_cost: delegates to sortByMinCost (ascending cost)', () => {
    expect(router.sortBy([...POOL], 'min_cost')).toEqual([
      'cloudx/lat-light',
      'cloudx/lat-center',
      'cloudx/lat-heavy',
    ]);
  });

  it('min_cost_if_all_priced: delegates when every ref is priced', () => {
    expect(router.sortBy([...POOL], 'min_cost_if_all_priced')).toEqual([
      'cloudx/lat-light',
      'cloudx/lat-center',
      'cloudx/lat-heavy',
    ]);
  });

  it("billing_preference: dispatches to sortByBillingPreference (free before payg)", () => {
    const refs = ['openai/coinx-one', 'openrouter/nocost-a:free'];
    expect(router.sortBy(refs, 'billing_preference')).toEqual([
      'openrouter/nocost-a:free',
      'openai/coinx-one',
    ]);
  });

  it('roundrobin and unrecognized methods preserve input order', () => {
    // Input deliberately NOT in score order: if these fell into the best
    // branch, the score sort would reorder them.
    const refs = ['cloudx/lat-light', 'cloudx/lat-heavy', 'cloudx/lat-center'];
    expect(router.sortBy([...refs], 'roundrobin')).toEqual(refs);
    expect(router.sortBy([...refs], 'no-such-method')).toEqual(refs);
  });
});

// Section 2 ─────────────────────────────────────────────────────────────────

describe('sortBy best — quality-window pool comparator (mixed costs)', () => {
  // Window 5% around top (1000) → floor ≈ 950: everything but mid is in the
  // pool. Within the pool: ascending effCost; cost ties → LOWER gdpval
  // first (least overkill); unknown cost at the END of the pool, ordered
  // by ascending gdpval; the rest (mid) strictly after the pool.
  const router = new Router({ ...testConfig, best_quality_window: 0.05 }, cache, new Map());
  const POOL = [
    'poolx/top',
    'poolx/unk-hi',
    'poolx/unk-lo',
    'poolx/cheap-tie',
    'poolx/over-tie',
    'poolx/mid',
  ];

  it('fixtures: unknown-cost refs really resolve to unknown', () => {
    expect(effCost('poolx/unk-hi')).toBe('unknown');
    expect(effCost('poolx/unk-lo')).toBe('unknown');
  });

  it('pool order: cost asc, ties → least overkill, unknowns at pool end', () => {
    expect(router.sortBy([...POOL], 'best')).toEqual([
      'poolx/over-tie', // 0.2, gdpval 965 — tie with cheap-tie, lower score first
      'poolx/cheap-tie', // 0.2, gdpval 970
      'poolx/top', // 1.0 — score leader, most expensive, mid-pool
      'poolx/unk-lo', // unknown cost → pool end, gdpval asc
      'poolx/unk-hi', // unknown cost → pool end
      'poolx/mid', // outside the window — cheap but strictly after the pool
    ]);
  });
});

describe('sortBy best — window OFF means NO cost-based reordering', () => {
  it('tied top scores keep input order; the cheaper tie does NOT jump ahead', () => {
    const router = new Router({ ...testConfig }, cache, new Map()); // no best_quality_window
    const refs = ['tiew/tie-a', 'tiew/tie-b', 'tiew/low'];
    expect(router.sortBy([...refs], 'best')).toEqual(refs);
  });
});

describe('sortBy best — unknown cost goes to the END of the pool, even for the score leader', () => {
  it('an unknown-cost model with the HIGHEST score still sorts behind known-cost pool members', () => {
    // Discriminator for the pool comparator's costA-unknown branch: the
    // unknown model leads the score sort, so only the explicit
    // "unknown → pool end" rule can move it behind the known model —
    // a comparator that no-ops on (unknown, known) pairs leaves it first.
    const router = new Router({ ...testConfig, best_quality_window: 0.05 }, cache, new Map());
    expect(router.sortBy(['poolx/unk-leader', 'poolx/known-second'], 'best')).toEqual([
      'poolx/known-second',
      'poolx/unk-leader',
    ]);
  });
});

describe('sortBy best — pool boundary is INCLUSIVE (>= floor)', () => {
  it('a candidate EXACTLY at the floor stays in the pool and wins on cost', () => {
    // w = 0.5 → floor = 1000 * 0.5 = 500, FP-exact. wedge scores EXACTLY
    // 500 and is by far the cheapest — it must be FIRST (in the pool), not
    // demoted behind wtop.
    const router = new Router({ ...testConfig, best_quality_window: 0.5 }, cache, new Map());
    expect(router.sortBy(['wedg/wtop', 'wedg/wedge'], 'best')).toEqual([
      'wedg/wedge',
      'wedg/wtop',
    ]);
  });
});

// Section 3 ─────────────────────────────────────────────────────────────────

describe('sortByBillingPreference — rank tables decide when costs tie', () => {
  const router = new Router(testConfig, cache, new Map());
  // Cost ties (0/0/0/0.001) + gdpval anti-correlated with rank: the cost
  // tiebreak alone yields local→sub→free→payg, so only the RANK TABLE can
  // produce each preference's asserted order.
  const SHUFFLED = ['ollama/daemonx-one', 'openai/coinx-one', 'openrouter/nocost-a:free', 'mistral/planx-one'];

  it('default: free → subscription → local → payg', () => {
    expect(router.sortByBillingPreference([...SHUFFLED])).toEqual([
      'openrouter/nocost-a:free',
      'mistral/planx-one',
      'ollama/daemonx-one',
      'openai/coinx-one',
    ]);
  });

  it('strict_local: local → free → subscription → payg', () => {
    expect(router.sortByBillingPreference([...SHUFFLED], 'strict_local')).toEqual([
      'ollama/daemonx-one',
      'openrouter/nocost-a:free',
      'mistral/planx-one',
      'openai/coinx-one',
    ]);
  });

  it('local_first: local ranks ahead of subscription but behind free', () => {
    // free (rank 0) < local (rank 0.5) < subscription (rank 1): local_first
    // differs from default ONLY in pulling local ahead of subscription.
    expect(router.sortByBillingPreference([...SHUFFLED], 'local_first')).toEqual([
      'openrouter/nocost-a:free',
      'ollama/daemonx-one',
      'mistral/planx-one',
      'openai/coinx-one',
    ]);
  });

  it('cloud_first: local ALWAYS last, behind payg', () => {
    expect(router.sortByBillingPreference([...SHUFFLED], 'cloud_first')).toEqual([
      'openrouter/nocost-a:free',
      'mistral/planx-one',
      'openai/coinx-one',
      'ollama/daemonx-one',
    ]);
  });

  it('local_before_payg: free → subscription → local → payg', () => {
    expect(router.sortByBillingPreference([...SHUFFLED], 'local_before_payg')).toEqual([
      'openrouter/nocost-a:free',
      'mistral/planx-one',
      'ollama/daemonx-one',
      'openai/coinx-one',
    ]);
  });
});

describe('sortByBillingPreference — subscription-tier limit-pressure preference', () => {
  it('within subscription, lower rate-limit pressure wins BEFORE gdpval', () => {
    // Same tier, same cost; gdpval favors the high-pressure model — only
    // the limitSecs comparison can produce the asserted order.
    const limits = new Map<string, RateLimit>([
      ['mistral/planx-busy', { cooldown_until: Date.now() + 500_000, backoff_ms: 0, hits: 0 } as RateLimit],
    ]);
    const router = new Router(testConfig, cache, limits);
    expect(
      router.sortByBillingPreference(['mistral/planx-busy', 'mistral/planx-calm'], 'local_before_payg'),
    ).toEqual(['mistral/planx-calm', 'mistral/planx-busy']);
  });

  it('limit pressure does NOT order non-subscription tiers (gdpval does)', () => {
    // Two FREE models, equal cost, different limit pressure. gdpval favors
    // the high-pressure one — if limitSecs leaked outside tier 1, the
    // low-pressure model would jump ahead.
    const limits = new Map<string, RateLimit>([
      ['openrouter/nocost-busy:free', { cooldown_until: Date.now() + 500_000, backoff_ms: 0, hits: 0 } as RateLimit],
    ]);
    const router = new Router(testConfig, cache, limits);
    expect(
      router.sortByBillingPreference(['openrouter/nocost-busy:free', 'openrouter/nocost-a:free']),
    ).toEqual(['openrouter/nocost-busy:free', 'openrouter/nocost-a:free']);
  });
});

describe('sortByBillingPreference — unknown-cost ordering', () => {
  const router = new Router(testConfig, cache, new Map());

  it('fixtures: the billing unknowns really resolve to unknown', () => {
    expect(effCost('paygx/unk-bill')).toBe('unknown');
    expect(effCost('paygx/unk-bill-2')).toBe('unknown');
  });

  it('unknown cost goes to the END; both-unknown falls to the gdpval tiebreak', () => {
    // Input order anti-correlated: the both-unknown pair must be gdpval
    // DESC (2000 before 1500), and the costly known model stays FIRST
    // despite having the lowest gdpval.
    expect(
      router.sortByBillingPreference(['paygx/unk-bill-2', 'paygx/unk-bill', 'paygx/known-bill']),
    ).toEqual(['paygx/known-bill', 'paygx/unk-bill', 'paygx/unk-bill-2']);
  });
});

// Section 4 ─────────────────────────────────────────────────────────────────

describe('filterByBudget — wrapper with a populated budget cache', () => {
  it('drops subscription refs of a spent provider; payg and local stay', () => {
    const spentCache: Cache = {
      available_models: [],
      budget_cache: {
        mistral: { remaining_tokens: 0, window_reset: Date.now() + 3_600_000 },
      },
    } as any;
    const router = new Router(testConfig, spentCache, new Map());
    const refs = ['mistral/sub-a', 'mistral/sub-b', 'openai/payg-ok', 'ollama/local-ok'];
    expect(router.filterByBudget(refs)).toEqual(['openai/payg-ok', 'ollama/local-ok']);
  });

  it('without a budget cache the wrapper passes everything through', () => {
    const router = new Router(testConfig, { available_models: [] } as any, new Map());
    const refs = ['mistral/sub-a', 'mistral/sub-b'];
    expect(router.filterByBudget(refs)).toEqual(refs);
  });
});

// Section 5 ─────────────────────────────────────────────────────────────────

describe('filterAvailable — rate-limited refs are dropped', () => {
  it('keeps healthy refs and drops the limited one', () => {
    const limits = new Map<string, RateLimit>([
      ['openai/limited-one', { cooldown_until: Date.now() + 300_000, backoff_ms: 0, hits: 0 } as RateLimit],
    ]);
    const router = new Router(testConfig, cache, limits);
    const refs = ['openai/limited-one', 'openai/healthy-two', 'ollama/local-ok'];
    expect(router.filterAvailable(refs)).toEqual(['openai/healthy-two', 'ollama/local-ok']);
  });
});
