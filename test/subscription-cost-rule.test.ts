/**
 * ADR-0025 Phase B2: subscription cost ordering is a RULE, not per-model
 * sentinel data.
 *
 * A provider with `billing: "subscription"` and no usable registry price
 * (subscription bridges register every model at $0, so the registry cannot
 * give an order) costs `ε × listPrice`, where listPrice comes from the
 * existing same-model OpenRouter backfill; models without any list price get
 * one documented constant. The relative order among subscription models
 * therefore follows list price (the ADR-0023 "sonnet before opus" intent)
 * without naming a single model in shipped config or source.
 *
 * Fixture models are fake ids: nothing here is a real model (ADR-0025).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Router } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.ts';
import type { Config, Cache } from '../src/types.ts';

const MINI = 'fake-sub/quill-mini-2'; // list $2/$10
const MAX = 'fake-sub/quill-max-2'; // list $4/$20 — scores slightly LOWER (a tie-break on score would pick it first)
const OLD = 'fake-sub/quill-old-1'; // no catalog entry at all
const PAYG = 'paygco/mid-1'; // pay-per-token peer, cheap but real money
const REFS = [MAX, MINI, OLD, PAYG];

function makeCfg(): Config {
  return {
    best_quality_window: 0.05,
    model_groups: {
      strategic: { method: 'best', min_gdpval: 600, fallback_groups: [] },
    },
    providers: { 'fake-sub': { billing: 'subscription' }, paygco: { billing: 'pay_per_token' } },
    // Deliberately NO model_metrics sentinels (the point of the rule).
    model_metrics: {},
    gdpval_builtin: { 'quill-max-2': 1890, 'quill-mini-2': 1895, 'quill-old-1': 1000, 'mid-1': 1880 },
  } as any;
}

// Scan shape: the pricing cache carries same-model list prices keyed by the
// catalog's "<vendor>/<model>" id (what scan-runner stores for paid entries).
const PRICING: Cache['openrouter_pricing'] = {
  'vendorx/quill-mini-2': { input: 2, output: 10 },
  'vendorx/quill-max-2': { input: 4, output: 20 },
};

// The subscription bridge registers every model at cost 0; paygco is priced.
const REGISTRY = {
  find: (provider: string, id: string) => {
    if (provider === 'fake-sub') return { provider, id, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    if (provider === 'paygco' && id === 'mid-1') return { provider, id, cost: { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0 } };
    return undefined;
  },
};

let cfg: Config;
let cache: Cache;

beforeEach(() => {
  cfg = makeCfg();
  cache = {
    available_models: REFS.map((r) => ({ provider: r.split('/')[0], id: r.slice(r.indexOf('/') + 1) })),
    openrouter_pricing: PRICING,
  } as any;
  metricsModule.setConfig(cfg);
  metricsModule.setCache(cache);
  metricsModule.setModelRegistry(REGISTRY as any);
});

describe('subscription cost rule (no model_metrics sentinels)', () => {
  it('prices every subscription model above zero (free stays free, subscription is not free)', () => {
    for (const ref of [MINI, MAX, OLD]) {
      const c = metricsModule.effCost(ref);
      expect(typeof c, ref).toBe('number');
      expect(c as number, ref).toBeGreaterThan(0);
    }
  });

  it('orders subscription models by list price: cheaper list price < pricier', () => {
    const mini = metricsModule.effCost(MINI) as number;
    const max = metricsModule.effCost(MAX) as number;
    expect(mini).toBeLessThan(max);
  });

  it('keeps every subscription model cheaper than the cheapest real pay-per-token model', () => {
    const payg = metricsModule.effCost(PAYG) as number;
    for (const ref of [MINI, MAX, OLD]) {
      expect(metricsModule.effCost(ref) as number, ref).toBeLessThan(payg);
    }
  });

  it('prices a model with NO list price via the constant fallback and keeps it routable', () => {
    const old = metricsModule.effCost(OLD);
    expect(typeof old).toBe('number');
    expect(old as number).toBeGreaterThan(0);
    const res = new Router(cfg, cache, new Map()).resolve('strategic');
    expect(res?.candidates).toContain(OLD);
  });

  it('quality window picks the cheaper subscription sibling first (sonnet-before-opus shape)', () => {
    const router = new Router(cfg, cache, new Map());
    const sorted = router.sortBy([MAX, MINI], 'best');
    expect(sorted[0]).toBe(MINI);
    expect(sorted[1]).toBe(MAX);
  });

  it('quality window sorts subscription models before the pay-per-token peer', () => {
    const router = new Router(cfg, cache, new Map());
    const sorted = router.sortBy([PAYG, MAX, MINI], 'best');
    expect(sorted).toEqual([MINI, MAX, PAYG]);
  });

  it('a user-layer model_metrics value still wins over the rule', () => {
    const userCfg = makeCfg();
    userCfg.model_metrics = { [MINI]: { cost_per_m: 9e-6 } };
    metricsModule.setConfig(userCfg);
    metricsModule.setCache({ ...cache } as any);
    expect(metricsModule.effCost(MINI)).toBeCloseTo(9e-6 * 0.5, 12);
  });
});

describe('shipped router-config.json carries no model_metrics sentinels', () => {
  it('has no model_metrics entry (cost ordering is derived by the subscription rule)', () => {
    const shipped = JSON.parse(readFileSync(resolve(__dirname, '../router-config.json'), 'utf8'));
    expect(Object.keys(shipped.model_metrics ?? {})).toEqual([]);
  });
});
