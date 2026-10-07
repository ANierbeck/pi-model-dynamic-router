// test/budget-pacing.test.ts
// Task-type-balancing Phase 4 (docs/plans/2026-10-05-task-type-balancing.md):
// generic budget pacing. `providers.<p>.budget` (amount/unit/period/reset_day,
// default absent = OFF) makes the router compare its own usage_log counter
// against the LINEAR target for the period and DEMOTE a provider that runs
// ahead of pace — a rank penalty, never an exclusion: a paced provider stays
// available but ranks behind on-pace candidates. The counter is the Phase 5a
// usage_log (tokens include cacheRead), so cached context counts toward the
// pace. Works for capped subscriptions and pay-per-token spend limits alike
// (unit 'tokens' | 'usd'; usd is estimated from the router's blended
// $/1M effCost, the same figure the ranking uses).

import { describe, it, expect, beforeEach } from 'vitest';
import { Router } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.ts';
import {
  budgetWindowStart,
  linearPaceTarget,
  isAheadOfPace,
  pacedProviders,
  providerSpend,
  resetBudgetPacingMemo,
  type ProviderBudget,
} from '../src/budget-pacing.ts';
import type { Config, Cache, UsageLogEntry } from '../src/types.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────
// Two unknown-to-PROVIDER_MAP providers (default pay_per_token), two models
// with distinct gdpvals. Provider "paceful" holds the better model, so
// WITHOUT pacing it always ranks first; a budget on "paceful" that it has
// outrun must flip the order. Tests compute their usage levels from the
// module's own linearPaceTarget so they stay deterministic on any date.

const HOUR = 3600 * 1000;

const BUDGET: ProviderBudget = {
  amount: 1_000_000, // tokens
  unit: 'tokens',
  period: 'month',
  reset_day: 1,
};

function configWith(budget?: ProviderBudget): Config {
  return {
    model_groups: {
      tactical: { method: 'max_gdpval', min_gdpval: 0 },
    },
    gdpval_builtin: { 'model-one': 1900, 'model-two': 1600 },
    model_metrics: {
      'paceful/model-one': { cost_per_m: 10, gdpval: 1900, throughput_tps: 50, avg_latency_ms: 500 },
      'steadye/model-two': { cost_per_m: 10, gdpval: 1600, throughput_tps: 50, avg_latency_ms: 500 },
    },
    providers: {
      paceful: budget ? { billing: 'pay_per_token', budget } : { billing: 'pay_per_token' },
      steadye: { billing: 'pay_per_token' },
    },
  } as any as Config;
}

function cacheWith(log: UsageLogEntry[]): Cache {
  return {
    available_models: [
      { id: 'model-one', provider: 'paceful', cost_per_m: 10 },
      { id: 'model-two', provider: 'steadye', cost_per_m: 10 },
    ],
    usage_log: log,
  } as any as Cache;
}

function routerFor(cfg: Config, cache: Cache): Router {
  metricsModule.setConfig(cfg);
  metricsModule.setCache(cache);
  metricsModule.setModelRegistry({ find: () => undefined } as any);
  return new Router(cfg, cache, new Map());
}

/** Usage for `paceful` that is `factor`x the current linear target (>=1 token). */
function aheadOfTargetTokens(factor: number): UsageLogEntry {
  const target = linearPaceTarget(BUDGET, Date.now());
  return {
    ref: 'paceful/model-one',
    tokens: Math.max(1, Math.ceil(target * factor)),
    ts: Date.now() - HOUR,
  };
}

beforeEach(() => {
  resetBudgetPacingMemo();
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('budgetWindowStart / linearPaceTarget', () => {
  it('reset_day 1: the window starts at the first of the current month, 00:00 local', () => {
    const now = new Date(2026, 9, 7, 15, 30).getTime(); // 2026-10-07
    expect(new Date(budgetWindowStart(now, 1)).getMonth()).toBe(9);
    expect(new Date(budgetWindowStart(now, 1)).getDate()).toBe(1);
    expect(new Date(budgetWindowStart(now, 1)).getHours()).toBe(0);
  });

  it('reset_day later than today: the window started in the PREVIOUS month', () => {
    const now = new Date(2026, 9, 7, 15, 30).getTime();
    const start = new Date(budgetWindowStart(now, 15));
    expect(start.getMonth()).toBe(8); // September
    expect(start.getDate()).toBe(15);
  });

  it('reset_day beyond a month\'s length is clamped to that month\'s last day', () => {
    const now = new Date(2026, 2, 31).getTime(); // March, 31 days
    expect(new Date(budgetWindowStart(now, 31)).getDate()).toBe(31);
    const feb = new Date(2026, 1, 20).getTime(); // February 2026, 28 days
    const start = new Date(budgetWindowStart(feb, 31));
    expect(start.getMonth()).toBe(0); // January 31
    expect(start.getDate()).toBe(31);
  });

  it('the linear target grows from 0 at the window start to the full amount at its end', () => {
    const now = new Date(2026, 9, 16, 12, 0).getTime(); // window 2026-10-01 → 2026-11-01
    const target = linearPaceTarget(BUDGET, now);
    expect(target).toBeGreaterThan(0);
    expect(target).toBeLessThan(BUDGET.amount);
    // Half the window elapsed (Oct 16 12:00 ≈ day 15.5 of 31) → ~half the amount.
    expect(target / BUDGET.amount).toBeGreaterThan(0.45);
    expect(target / BUDGET.amount).toBeLessThan(0.55);
    // Exactly at the window start the linear target is 0 — anything spent is ahead.
    const windowStart = budgetWindowStart(now, BUDGET.reset_day);
    expect(linearPaceTarget(BUDGET, windowStart)).toBe(0);
  });

  it('isAheadOfPace: strictly more than the target is ahead, the target itself is not', () => {
    const now = new Date(2026, 9, 16).getTime();
    const target = linearPaceTarget(BUDGET, now);
    expect(isAheadOfPace(BUDGET, target + 1, now)).toBe(true);
    expect(isAheadOfPace(BUDGET, target, now)).toBe(false);
  });
});

describe('pacedProviders — validation and window', () => {
  it('an invalid budget is ignored (fail-open, provider stays unpaced)', () => {
    const log = [aheadOfTargetTokens(10)];
    const variants: Array<Partial<ProviderBudget>> = [
      { amount: 0 },
      { amount: -5 },
      { amount: Number.NaN },
      { unit: 'euros' as never },
      { period: 'week' as never },
      { reset_day: 0 },
      { reset_day: 45 },
      { reset_day: 1.5 },
    ];
    for (const v of variants) {
      const cfg = configWith({ ...BUDGET, ...v });
      expect(pacedProviders(cfg, log, Date.now()).size, JSON.stringify(v)).toBe(0);
    }
  });

  it('usage from BEFORE the current window does not count (reset_day rolls the counter)', () => {
    const cfg = configWith(BUDGET);
    const old = { ...aheadOfTargetTokens(50), ts: Date.now() - 40 * 24 * HOUR };
    expect(pacedProviders(cfg, [old], Date.now()).size).toBe(0);
    // Same spend inside the window does.
    expect(pacedProviders(cfg, [aheadOfTargetTokens(50)], Date.now())).toContain('paceful');
  });

  it('only the configured provider is paced; other providers are untouched', () => {
    const cfg = configWith(BUDGET);
    const log = [
      aheadOfTargetTokens(50),
      { ref: 'steadye/model-two', tokens: 10_000_000, ts: Date.now() - HOUR },
    ];
    expect(pacedProviders(cfg, log, Date.now())).toEqual(new Set(['paceful']));
  });

  it('usd spend: unpriceable refs contribute $0 (never block the provider), priced ones sum', () => {
    const usd: ProviderBudget = { amount: 1, unit: 'usd', period: 'month', reset_day: 1 };
    const log = [
      { ref: 'paceful/unpriced-model', tokens: 5_000_000, ts: Date.now() - HOUR }, // effCost unknown
      { ref: 'paceful/model-one', tokens: 1_000_000, ts: Date.now() - HOUR }, // $10 at cost_per_m 10
    ];
    const cfg = configWith(usd);
    metricsModule.setConfig(cfg); // effCost reads the module-level config
    expect(providerSpend(usd, 'paceful', log, Date.now())).toBe(10);
    expect(pacedProviders(cfg, log, Date.now())).toEqual(new Set(['paceful']));
  });

  it('the memo reuses the result within its TTL (same cfg + log)', () => {
    const cfg = configWith(BUDGET);
    const log = [aheadOfTargetTokens(50)];
    const first = pacedProviders(cfg, log, Date.now());
    const second = pacedProviders(cfg, log, Date.now());
    expect(second).toBe(first); // same Set object — memoized, not recomputed
    // A different cfg or log is recomputed, never served stale.
    expect(pacedProviders(configWith(BUDGET), log, Date.now())).not.toBe(first);
    expect(pacedProviders(cfg, [...log], Date.now())).not.toBe(first);
  });
});

// ── Routing observable: demotion, not exclusion ──────────────────────────────

describe('Router.resolve demotes a provider ahead of pace', () => {
  it('ahead of pace: the paced provider ranks BEHIND the on-pace peer but stays a candidate', () => {
    const cfg = configWith(BUDGET);
    const cache = cacheWith([aheadOfTargetTokens(10)]);
    const router = routerFor(cfg, cache);
    const res = router.resolve('tactical')!;
    // Without pacing model-one (gdpval 1900) always ranks first.
    expect(res.candidates).toEqual(['steadye/model-two', 'paceful/model-one']);
    expect(res.selected).toBe('steadye/model-two');
  });

  it('on pace (half the linear target): the ranking is unchanged', () => {
    const cfg = configWith(BUDGET);
    const cache = cacheWith([aheadOfTargetTokens(0.5)]);
    const router = routerFor(cfg, cache);
    expect(router.resolve('tactical')!.candidates).toEqual([
      'paceful/model-one',
      'steadye/model-two',
    ]);
  });

  it('absent budget = no pacing (default OFF pinned): even massive usage never demotes', () => {
    const cfg = configWith(undefined);
    const cache = cacheWith([{ ref: 'paceful/model-one', tokens: 10_000_000_000, ts: Date.now() - HOUR }]);
    const router = routerFor(cfg, cache);
    expect(router.resolve('tactical')!.candidates).toEqual([
      'paceful/model-one',
      'steadye/model-two',
    ]);
  });

  it('the counter counts cacheRead (Phase 5a accounting feeds pacing)', () => {
    const cfg = configWith(BUDGET);
    const target = linearPaceTarget(BUDGET, Date.now());
    // The step's fresh input+output stays far below the target — only the
    // cached context (which usage_log.tokens includes, per 5a) pushes the
    // provider ahead of pace. cacheRead not counted = on-pace = RED intent.
    const cacheRead = Math.ceil(target * 10);
    const cache = cacheWith([
      { ref: 'paceful/model-one', tokens: cacheRead + 100, cacheRead, ts: Date.now() - HOUR },
    ]);
    const router = routerFor(cfg, cache);
    expect(router.resolve('tactical')!.candidates).toEqual(['steadye/model-two', 'paceful/model-one']);
  });

  it('unit usd: spend is estimated from effCost and demotes the same way', () => {
    // cost_per_m 10 → every logged token costs $10/1M. Budget: $1 per month.
    const budget: ProviderBudget = { amount: 1, unit: 'usd', period: 'month', reset_day: 1 };
    const cfg = configWith(budget);
    const target = linearPaceTarget(budget, Date.now()); // USD target for now
    // Tokens that cost 10x the USD target (>= $0.000001 → at least 1 token).
    const tokens = Math.max(1, Math.ceil((target * 10) * 1_000_000 / 10));
    const cache = cacheWith([{ ref: 'paceful/model-one', tokens, ts: Date.now() - HOUR }]);
    const router = routerFor(cfg, cache);
    expect(router.resolve('tactical')!.candidates).toEqual(['steadye/model-two', 'paceful/model-one']);
  });

  it('usage before the window start leaves the ranking unchanged (reset_day rolled)', () => {
    const cfg = configWith(BUDGET);
    const old = { ...aheadOfTargetTokens(50), ts: Date.now() - 40 * 24 * HOUR };
    const router = routerFor(cfg, cacheWith([old]));
    expect(router.resolve('tactical')!.candidates).toEqual([
      'paceful/model-one',
      'steadye/model-two',
    ]);
  });
});
