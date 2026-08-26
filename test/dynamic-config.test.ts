// test/dynamic-config.test.ts
//
// Unit tests for src/dynamic-config.ts — the pure computational core of
// generateDynamicConfig(), extracted in C1 specifically so this logic could
// be tested without spinning up the full Pi extension. It shipped without
// direct tests (only exercised indirectly via index.ts integration tests),
// so this file closes that gap.
//
// This file REPLACES a pre-existing test/dynamic-config.test.ts (added by an
// earlier roborev-findings pass) that never imported src/dynamic-config.ts
// at all — it mocked metrics.ts and re-implemented the sort/filter logic
// inline inside each test, asserting the reimplementation against itself.
// That gave zero regression coverage for the real exported functions below
// despite superficially looking like tests for "dynamic config generation".

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildStaticFreeModelsLookup,
  buildModelsWithMetadata,
  filterModelsForGroup,
  sortModelsForGroup,
  collectGroupModels,
  computeFallbackGroups,
  type ModelWithMetadata,
} from '../src/dynamic-config.ts';
import { setConfig, setCache, setGdpval, setModelMap, setMetrics, calculateScore } from '../src/metrics.ts';
import type { Config, Group } from '../src/types.ts';

const baseCfg: Config = {
  model_groups: {},
  model_metrics: {},
  providers: {
    payg: { billing: 'pay_per_token' },
    sub: { billing: 'subscription' },
  },
};

beforeEach(() => {
  setConfig(baseCfg);
  setGdpval({});
  setCache({});
  setModelMap({}, []);
  setMetrics({}); // getM() caches per-ref; without this, refs reused across tests return stale metrics
});

describe('buildStaticFreeModelsLookup', () => {
  it('collects and normalizes provider free_models, keyed both prefixed and bare', () => {
    const cfg: Config = {
      ...baseCfg,
      providers: {
        openrouter: { free_models: ['openrouter/model-a', 'model-b'] },
      },
    };
    const { staticFreeModels, staticFreeModelsLookup } = buildStaticFreeModelsLookup(cfg);

    expect(staticFreeModels).toEqual(['openrouter/model-a', 'openrouter/model-b']);
    expect(staticFreeModelsLookup.has('openrouter/model-a')).toBe(true);
    expect(staticFreeModelsLookup.has('model-a')).toBe(true);
    expect(staticFreeModelsLookup.has('openrouter/model-b')).toBe(true);
    expect(staticFreeModelsLookup.has('model-b')).toBe(true);
  });

  it('returns empty sets when no providers declare free_models', () => {
    const { staticFreeModels, staticFreeModelsLookup } = buildStaticFreeModelsLookup(baseCfg);
    expect(staticFreeModels).toEqual([]);
    expect(staticFreeModelsLookup.size).toBe(0);
  });
});

describe('buildModelsWithMetadata', () => {
  it('drops models with no GDPval score unless explicitly statically configured', () => {
    setGdpval({ 'known-model': 500 });
    const cfg = { ...baseCfg, model_metrics: { 'payg/known-model': {}, 'payg/unknown-model': {} } };
    setConfig(cfg);

    const result = buildModelsWithMetadata(
      ['payg/known-model', 'payg/unknown-model'],
      cfg,
      new Set(),
      new Set(['payg/unknown-model']) // hand-curated allow-list keeps it despite gdpval 0
    );

    const refs = result.map((m) => m.ref);
    expect(refs).toContain('payg/known-model');
    expect(refs).toContain('payg/unknown-model'); // kept: static allow-list
  });

  it('drops an unscored, non-static model entirely', () => {
    setGdpval({});
    const cfg = baseCfg;
    const result = buildModelsWithMetadata(['payg/unscored'], cfg, new Set(), new Set());
    expect(result).toEqual([]);
  });

  it('flags isFreeModel via the static free-models lookup', () => {
    setGdpval({ m: 100 });
    const result = buildModelsWithMetadata(
      ['payg/m'],
      { ...baseCfg, model_metrics: { 'payg/m': { cost_per_m: 5 } } },
      new Set(['payg/m']),
      new Set()
    );
    expect(result[0].isFreeModel).toBe(true);
  });

  it('flags isFreeModel via the :free suffix', () => {
    setGdpval({ 'm:free': 100 });
    const result = buildModelsWithMetadata(
      ['payg/m:free'],
      { ...baseCfg, model_metrics: { 'payg/m:free': { cost_per_m: 5 } } },
      new Set(),
      new Set()
    );
    expect(result[0].isFreeModel).toBe(true);
  });

  it('flags isFreeModel via a zero effective cost on a token-based provider', () => {
    setGdpval({ m: 100 });
    const cfg = { ...baseCfg, model_metrics: { 'payg/m': { cost_per_m: 0 } } };
    setConfig(cfg); // effCost()/lookupPrice() read metrics.ts's internal cfg, not the parameter
    // getM() only trusts a 0 cost_per_m for a pay_per_token provider if the
    // model is also listed in cache.available_models with cost_per_m: 0 —
    // otherwise it treats 0 as "not yet priced" and reports 'unknown'.
    setCache({ available_models: [{ provider: 'payg', id: 'm', cost_per_m: 0 } as any] });
    const result = buildModelsWithMetadata(['payg/m'], cfg, new Set(), new Set());
    expect(result[0].isFreeModel).toBe(true);
    expect(result[0].cost).toBe(0);
  });

  it('does not flag a paid model as free', () => {
    setGdpval({ m: 100 });
    const cfg = { ...baseCfg, model_metrics: { 'payg/m': { cost_per_m: 5 } } };
    setConfig(cfg);
    const result = buildModelsWithMetadata(['payg/m'], cfg, new Set(), new Set());
    expect(result[0].isFreeModel).toBe(false);
    expect(result[0].cost).toBe(5);
  });
});

describe('filterModelsForGroup', () => {
  const models: ModelWithMetadata[] = [
    { ref: 'payg/cheap', gdpval: 300, cost: 1, price: { input: 1, output: 1 }, isFreeModel: false },
    { ref: 'payg/expensive', gdpval: 800, cost: 20, price: { input: 20, output: 20 }, isFreeModel: false },
    { ref: 'payg/free', gdpval: 400, cost: 0, price: { input: 0, output: 0 }, isFreeModel: true },
    { ref: 'sub/subscribed', gdpval: 900, cost: 'unknown', price: null, isFreeModel: false },
  ];

  it('applies min_gdpval as a floor', () => {
    const g: Group = { method: 'best', min_gdpval: 500 };
    const filtered = filterModelsForGroup(models, g, baseCfg);
    expect(filtered.map((m) => m.ref).sort()).toEqual(['payg/expensive', 'sub/subscribed']);
  });

  it('applies max_cost_per_m: keeps free token-based, keeps subscription, drops over-budget paid', () => {
    const g: Group = { method: 'best', max_cost_per_m: 5 };
    const filtered = filterModelsForGroup(models, g, baseCfg);
    const refs = filtered.map((m) => m.ref).sort();
    expect(refs).toEqual(['payg/cheap', 'payg/free', 'sub/subscribed']);
    expect(refs).not.toContain('payg/expensive');
  });

  it('applies max_cost=0: only genuinely free token-based models survive', () => {
    const g: Group = { method: 'best', max_cost: 0 };
    const filtered = filterModelsForGroup(models, g, baseCfg);
    expect(filtered.map((m) => m.ref)).toEqual(['payg/free']);
  });

  it('applies max_cost>0: free passes, paid under budget passes, paid over budget drops', () => {
    // Unlike max_cost_per_m, max_cost has NO subscription/non-token-based
    // bypass in the original code (preserved as-is by the C1 extraction) —
    // a subscription model with an unknown cost is genuinely dropped here,
    // not passed through. This looks like an inconsistency but is existing,
    // intentional-by-omission behavior, not something this refactor changed.
    const g: Group = { method: 'best', max_cost: 2 };
    const filtered = filterModelsForGroup(models, g, baseCfg);
    const refs = filtered.map((m) => m.ref).sort();
    expect(refs).toEqual(['payg/cheap', 'payg/free']);
  });

  it('drops paid models with unknown price under max_cost_per_m', () => {
    const unknownPriceModel: ModelWithMetadata = {
      ref: 'payg/mystery',
      gdpval: 500,
      cost: 'unknown',
      price: { input: 'unknown', output: 'unknown' },
      isFreeModel: false,
    };
    const g: Group = { method: 'best', max_cost_per_m: 100 };
    const filtered = filterModelsForGroup([unknownPriceModel], g, baseCfg);
    expect(filtered).toEqual([]);
  });
});

describe('sortModelsForGroup', () => {
  const cfg = baseCfg;
  const score = (ref: string) => calculateScore(ref, 'standard', cfg);

  it('method best/max_gdpval: sorts by calculateScore descending', () => {
    setGdpval({ low: 100, high: 900 });
    const models: ModelWithMetadata[] = [
      { ref: 'payg/low', gdpval: 100, cost: 1, price: null, isFreeModel: false },
      { ref: 'payg/high', gdpval: 900, cost: 1, price: null, isFreeModel: false },
    ];
    const sorted = sortModelsForGroup(models, { method: 'best' }, 'standard', cfg, calculateScore);
    expect(sorted.map((m) => m.ref)).toEqual(['payg/high', 'payg/low']);
  });

  it('method min_cost: free models always rank before paid, then by ascending cost', () => {
    const models: ModelWithMetadata[] = [
      { ref: 'payg/pricey', gdpval: 500, cost: 10, price: null, isFreeModel: false },
      { ref: 'payg/free', gdpval: 500, cost: 0, price: null, isFreeModel: true },
      { ref: 'payg/cheap', gdpval: 500, cost: 2, price: null, isFreeModel: false },
    ];
    const sorted = sortModelsForGroup(models, { method: 'min_cost' }, 'standard', cfg, calculateScore);
    expect(sorted.map((m) => m.ref)).toEqual(['payg/free', 'payg/cheap', 'payg/pricey']);
  });

  it('method min_cost: unknown-cost models sort after known-cost models', () => {
    const models: ModelWithMetadata[] = [
      { ref: 'payg/mystery', gdpval: 500, cost: 'unknown', price: null, isFreeModel: false },
      { ref: 'payg/known', gdpval: 500, cost: 5, price: null, isFreeModel: false },
    ];
    const sorted = sortModelsForGroup(models, { method: 'min_cost' }, 'standard', cfg, calculateScore);
    expect(sorted.map((m) => m.ref)).toEqual(['payg/known', 'payg/mystery']);
  });

  it('method tiered: sorts by gdpval first, free-bias second, cost third', () => {
    const models: ModelWithMetadata[] = [
      { ref: 'payg/low-gdp', gdpval: 100, cost: 1, price: null, isFreeModel: false },
      { ref: 'payg/high-gdp-paid', gdpval: 800, cost: 5, price: null, isFreeModel: false },
      { ref: 'payg/high-gdp-free', gdpval: 800, cost: 0, price: null, isFreeModel: true },
    ];
    const sorted = sortModelsForGroup(models, { method: 'tiered' }, 'standard', cfg, calculateScore);
    // Both gdpval-800 entries must precede the gdpval-100 entry, and among
    // ties the free one wins.
    expect(sorted[0].ref).toBe('payg/high-gdp-free');
    expect(sorted[2].ref).toBe('payg/low-gdp');
  });

  it('unrecognized method leaves the input order unchanged', () => {
    const models: ModelWithMetadata[] = [
      { ref: 'payg/a', gdpval: 100, cost: 1, price: null, isFreeModel: false },
      { ref: 'payg/b', gdpval: 900, cost: 1, price: null, isFreeModel: false },
    ];
    const sorted = sortModelsForGroup(models, { method: 'dynamic' }, 'standard', cfg, calculateScore);
    expect(sorted.map((m) => m.ref)).toEqual(['payg/a', 'payg/b']);
  });
});

describe('collectGroupModels', () => {
  it('includes hand-curated static models that pass the gates, then dedups dynamic candidates by token signature', () => {
    setGdpval({ 'pinned-model': 600 });
    const g: Group = { method: 'best', models: ['payg/pinned-model'] };
    const dynamicCandidate: ModelWithMetadata = {
      // Date-suffixed variant of the same base model — modelSig() strips the
      // date suffix, so this collides with "pinned-model"'s signature.
      ref: 'payg/pinned-model-20250601',
      gdpval: 600,
      cost: 1,
      price: null,
      isFreeModel: false,
    };
    const unrelated: ModelWithMetadata = {
      ref: 'payg/other-model',
      gdpval: 500,
      cost: 1,
      price: null,
      isFreeModel: false,
    };
    const result = collectGroupModels(g, [], [dynamicCandidate, unrelated], baseCfg, new Set());
    expect(result).toContain('payg/pinned-model');
    expect(result).toContain('payg/other-model');
    // The dynamic duplicate of the already-included static model is dropped.
    expect(result).not.toContain('payg/pinned-model-20250601');
  });

  it('drops a static model with no resolvable GDPval score', () => {
    setGdpval({});
    const g: Group = { method: 'best', models: ['payg/unscored-static'] };
    const result = collectGroupModels(g, [], [], baseCfg, new Set());
    expect(result).toEqual([]);
  });

  it('drops a static model below the group min_gdpval floor', () => {
    setGdpval({ 'low-score-model': 100 });
    const g: Group = { method: 'best', models: ['payg/low-score-model'], min_gdpval: 500 };
    const result = collectGroupModels(g, [], [], baseCfg, new Set());
    expect(result).toEqual([]);
  });

  it('drops a static paid model over max_cost, but keeps a static free one', () => {
    setGdpval({ pricey: 600, free: 600 });
    const cfg = { ...baseCfg, model_metrics: { 'payg/pricey': { cost_per_m: 50 } } };
    const g: Group = { method: 'best', models: ['payg/pricey', 'payg/free'], max_cost: 0 };
    const result = collectGroupModels(g, [], [], cfg, new Set(['payg/free']));
    expect(result).toEqual(['payg/free']);
  });

  it('returns an empty array when no static or dynamic candidates qualify', () => {
    const g: Group = { method: 'best' };
    expect(collectGroupModels(g, [], [], baseCfg, new Set())).toEqual([]);
  });
});

describe('computeFallbackGroups', () => {
  it('orders fallback groups nearest-higher-quality first, then lower, and skips dynamic groups', () => {
    const groups: Record<string, Group> = {
      dynamic: { method: 'dynamic' },
      free: { method: 'tiered', max_cost: 0 },
      mid: { method: 'tiered', min_gdpval: 400 },
      top: { method: 'best', min_gdpval: 800 },
    };
    computeFallbackGroups(groups);

    // Quality order (ascending): free (0) < mid (400) < top (800).
    // 'mid' should escalate to 'top' before degrading to 'free'.
    expect(groups.mid.fallback_groups).toEqual(['top', 'free']);
    // 'free' (lowest) has nothing below it, only escalation upward.
    expect(groups.free.fallback_groups).toEqual(['mid', 'top']);
    // 'top' (highest) has nothing above it, only degradation downward.
    expect(groups.top.fallback_groups).toEqual(['mid', 'free']);
    // The dynamic group is never assigned fallback_groups by this function.
    expect(groups.dynamic.fallback_groups).toBeUndefined();
  });

  it('a group with no min_gdpval/max_cost defaults to the highest quality tier (750)', () => {
    const groups: Record<string, Group> = {
      unconstrained: { method: 'best' },
      free: { method: 'tiered', max_cost: 0 },
    };
    computeFallbackGroups(groups);
    expect(groups.unconstrained.fallback_groups).toEqual(['free']);
    expect(groups.free.fallback_groups).toEqual(['unconstrained']);
  });
});
