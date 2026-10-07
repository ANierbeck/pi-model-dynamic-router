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

// ── Review fixes M2/M3 (2026-10-07 full-range review of Phase B) ─────────────

describe('subscription rule uniformity', () => {
  const TWIN_CFG = 'fake-sub/quill-twin-x'; // cfg-declared subscription provider
  const TWIN_MAP = 'chutes/quill-twin-x'; // subscription ONLY via PROVIDER_MAP

  it('applies the same rule cost to PROVIDER_MAP-only and cfg-declared subscription providers (no 2x skew)', () => {
    // Both twins carry the same $2 list price; the rule cost must be
    // eps x list for BOTH. The old code applied SUB_DISCOUNT only when
    // billing came from cfg.providers, halving one twin and not the other.
    const withTwins = makeCfg();
    metricsModule.setConfig(withTwins);
    const pricing = { ...PRICING, 'vendorx/quill-twin-x': { input: 2, output: 10 } };
    metricsModule.setCache({ ...cache, openrouter_pricing: pricing } as any);
    const registry = {
      find: (provider: string, id: string) =>
        (provider === 'fake-sub' || provider === 'chutes') && id === 'quill-twin-x'
          ? { provider, id, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
          : REGISTRY.find(provider, id),
    };
    metricsModule.setModelRegistry(registry as any);

    const fromCfg = metricsModule.effCost(TWIN_CFG);
    const fromMap = metricsModule.effCost(TWIN_MAP);
    expect(fromMap).toBeCloseTo(fromCfg, 15);
    expect(fromCfg).toBeCloseTo(1e-6 * 2, 15); // eps x list, undiscounted
  });

  it('sees pricing-cache entries added in place (no setCache) — the backfill index must not go stale', () => {
    // M3 pin: the same-model backfill is indexed for O(1) lookups (effCost
    // runs inside sort comparators), but scan-runner mutates the pricing
    // object in place. A naive memo would keep serving the stale miss;
    // the index must rebuild when the pricing generation changes.
    metricsModule.setConfig(makeCfg());
    // The SAME object must go to setCache and be mutated below — scan-runner
    // mutates the live pricing object in place.
    const livePricing: Cache['openrouter_pricing'] = { ...PRICING };
    metricsModule.setCache({ ...cache, openrouter_pricing: livePricing } as any);
    metricsModule.setModelRegistry(REGISTRY as any);

    // Warm whatever index exists with a lookup for the model added below
    // (a miss now, so a naive memo would cache the constant fallback).
    const stale = metricsModule.effCost('fake-sub/quill-late-x');
    expect(stale).toBeCloseTo(1.5e-6, 15); // constant fallback while unpriced

    // Scan shape: pricing gains a key in place, no setCache call
    // (scan-runner mutates rt.cache.openrouter_pricing directly).
    Object.assign(livePricing!, { 'vendorx/quill-late-x': { input: 6, output: 30 } });
    expect(metricsModule.effCost('fake-sub/quill-late-x')).toBeCloseTo(1e-6 * 6, 15);
  });
});

describe('shipped router-config.json carries no model_metrics sentinels', () => {
  it('has no model_metrics entry (cost ordering is derived by the subscription rule)', () => {
    const shipped = JSON.parse(readFileSync(resolve(__dirname, '../router-config.json'), 'utf8'));
    expect(Object.keys(shipped.model_metrics ?? {})).toEqual([]);
  });
});
