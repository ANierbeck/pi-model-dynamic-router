// test/group-filter-live-lookups.test.ts — nightly R1 triage (2026-10-07),
// routing.ts live gate lookups and the small group-resolution guards that the
// injected-lookup tests (group-filter-boundaries.test.ts) cannot reach:
//
//   - inFreeModelsList: a free_models entry matches prefixed OR bare; an
//     empty/absent/non-array list never matches (and never crashes)
//   - liveGroupFilterLookups.isFree: `:free` tag OR free_models entry; a
//     {0,0} list price is free; a HALF-zero price ({0,5} / {5,0}) is a real
//     price and not free (observable on a subscription provider, where a
//     free ref bypasses a positive max_cost but a priced one does not)
//   - billingFor / isTokenBased defaults for providers the config never
//     declared: unknown provider = pay_per_token for an unknown cost (dropped
//     by a positive cap) but NOT token-based for the zero-cost admission
//     (a `:free` ref of an unknown provider must not enter a max_cost 0 group)
//   - top_k: 0 means "no limit", not "empty list" (resolveGroup generic and
//     pipeline step, getTopModels pipeline step)
//   - a pipeline field on a non-pipeline group is ignored
//   - allDiscoveredRefs ignores a malformed (non-array) free_models value
//   - isVirtualGroupRef recognizes a one-character provider

import { describe, it, expect } from 'vitest';
import { Router, applyGroupFilters, isVirtualGroupRef } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.ts';
import type { Config, Cache, Group } from '../src/types.ts';

const baseMetrics = {
  'fp/prefixed': { gdpval: 500, cost_per_m: 5 },
  'fp/bare-one': { gdpval: 500, cost_per_m: 5 },
  'fp/other': { gdpval: 500, cost_per_m: 5 },
  'fp/tagged:free': { gdpval: 500, cost_per_m: 5 },
};

function useWorld(cfgPatch: Record<string, unknown>, cachePatch: Record<string, unknown> = {}): Config {
  const cfg = { model_groups: {}, model_metrics: baseMetrics, ...cfgPatch } as any as Config;
  const cache = { available_models: [], ...cachePatch } as any as Cache;
  metricsModule.setConfig(cfg);
  metricsModule.setCache(cache);
  metricsModule.setGdpval({});
  metricsModule.setModelMap({}, []);
  metricsModule.setModelRegistry({ find: () => undefined } as any);
  return cfg;
}

const zeroCostGroup = { method: 'best', max_cost: 0 } as Group;

describe('live isFree — free_models membership', () => {
  it('prefixed entry, bare entry and :free tag are free; an unlisted ref is not', () => {
    const cfg = useWorld({
      providers: { fp: { billing: 'pay_per_token', free_models: ['fp/prefixed', 'bare-one'] } },
    });
    const refs = ['fp/prefixed', 'fp/bare-one', 'fp/tagged:free', 'fp/other'];
    expect(applyGroupFilters(refs, zeroCostGroup, cfg)).toEqual(['fp/prefixed', 'fp/bare-one', 'fp/tagged:free']);
  });

  it('only a prefixed entry matches when the bare id is not listed (and vice versa)', () => {
    const prefixedOnly = useWorld({ providers: { fp: { billing: 'pay_per_token', free_models: ['fp/prefixed'] } } });
    expect(applyGroupFilters(['fp/prefixed', 'fp/bare-one'], zeroCostGroup, prefixedOnly)).toEqual(['fp/prefixed']);
    const bareOnly = useWorld({ providers: { fp: { billing: 'pay_per_token', free_models: ['bare-one'] } } });
    expect(applyGroupFilters(['fp/prefixed', 'fp/bare-one'], zeroCostGroup, bareOnly)).toEqual(['fp/bare-one']);
  });

  it('an empty list frees nothing', () => {
    const cfg = useWorld({ providers: { fp: { billing: 'pay_per_token', free_models: [] } } });
    expect(applyGroupFilters(['fp/other'], zeroCostGroup, cfg)).toEqual([]);
  });

  it('a config without any providers block does not crash and frees nothing', () => {
    const cfg = useWorld({});
    expect(applyGroupFilters(['fp/other'], zeroCostGroup, cfg)).toEqual([]);
  });

  it('a provider the config never declares cannot be admitted by :free (not token-based)', () => {
    const cfg = useWorld({});
    expect(applyGroupFilters(['zz/anything:free'], zeroCostGroup, cfg)).toEqual([]);
  });
});

describe('billing defaults of an undeclared provider', () => {
  it('unknown cost + undeclared provider + positive cap → dropped (pay_per_token default), no crash', () => {
    const cfg = useWorld({});
    expect(applyGroupFilters(['zz/unpriced'], { method: 'best', max_cost: 1 } as Group, cfg)).toEqual([]);
  });

  it('unknown cost + declared subscription provider + positive cap → kept (sunk cost)', () => {
    const cfg = useWorld({ providers: { zz: { billing: 'subscription' } } });
    expect(applyGroupFilters(['zz/unpriced'], { method: 'best', max_cost: 1 } as Group, cfg)).toEqual(['zz/unpriced']);
  });
});

describe('live isFree — list price zero vs half-zero (subscription provider, tiny cap)', () => {
  // A subscription ref is priced by the ADR-0025 B2 rule (positive), so only a
  // genuinely free ref can pass a cap far below that price.
  const TINY_CAP = { method: 'best', max_cost: 1e-12 } as Group;
  const cfgPatch = { providers: { subp: { billing: 'subscription' } } };

  it('a {0,0} list price is free: kept under the tiny cap', () => {
    const cfg = useWorld(cfgPatch, {
      available_models: [{ provider: 'subp', id: 'zero', cost_per_m: 0 }],
      openrouter_pricing: { 'subp/zero': { input: 0, output: 0 } },
    });
    expect(applyGroupFilters(['subp/zero'], TINY_CAP, cfg)).toEqual(['subp/zero']);
  });

  it('a half-zero price ({0,5} or {5,0}) is a real price: dropped under the tiny cap', () => {
    const cfg = useWorld(cfgPatch, {
      openrouter_pricing: {
        'subp/in-zero': { input: 0, output: 5 },
        'subp/out-zero': { input: 5, output: 0 },
      },
    });
    expect(applyGroupFilters(['subp/in-zero', 'subp/out-zero'], TINY_CAP, cfg)).toEqual([]);
  });
});

describe('top_k: 0 means no limit', () => {
  const metrics = {
    'tk/a': { gdpval: 300, cost_per_m: 1 },
    'tk/b': { gdpval: 200, cost_per_m: 2 },
    'tk/c': { gdpval: 100, cost_per_m: 0.5 }, // cheapest AND weakest: min_cost order is the reverse of max_gdpval's tail
  };
  const cache = {
    available_models: [
      { provider: 'tk', id: 'a', cost_per_m: 1 },
      { provider: 'tk', id: 'b', cost_per_m: 2 },
      { provider: 'tk', id: 'c', cost_per_m: 0.5 },
    ],
  } as any as Cache;

  function router(groups: Record<string, Group>) {
    const cfg = { model_groups: groups, model_metrics: metrics, providers: {} } as any as Config;
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);
    metricsModule.setGdpval({});
    metricsModule.setModelMap({}, []);
    metricsModule.setModelRegistry({ find: () => undefined } as any);
    return new Router(cfg, cache, new Map());
  }

  it('a generic group with top_k 0 keeps every candidate', () => {
    const r = router({ g: { method: 'max_gdpval', top_k: 0 } }).resolve('g');
    expect(r!.candidates).toEqual(['tk/a', 'tk/b', 'tk/c']);
  });

  it('a pipeline step with top_k 0 keeps every candidate', () => {
    const r = router({ p: { method: 'pipeline', pipeline: [{ method: 'max_gdpval', top_k: 0 }, { method: 'min_cost' }] } }).resolve('p');
    expect(r!.candidates).toEqual(['tk/c', 'tk/a', 'tk/b']);
  });

  it('the display pipeline step with top_k 0 (not last) keeps every candidate', () => {
    const top = router({ p: { method: 'pipeline', pipeline: [{ method: 'max_gdpval', top_k: 0 }, { method: 'min_cost' }] } }).getTopModels('p', 10);
    expect(top.models.map((m) => m.ref)).toEqual(['tk/c', 'tk/a', 'tk/b']);
  });

  it('a non-pipeline group ignores a stray pipeline field (live and display)', () => {
    const groups = { s: { method: 'min_cost', pipeline: [{ method: 'max_gdpval', top_k: 1 }] } as Group };
    expect(router(groups).resolve('s')!.candidates).toEqual(['tk/c', 'tk/a', 'tk/b']);
    expect(router(groups).getTopModels('s', 10).models.map((m) => m.ref)).toEqual(['tk/c', 'tk/a', 'tk/b']);
  });
});

describe('allDiscoveredRefs — malformed free_models', () => {
  it('a non-array free_models value contributes nothing (not its characters)', () => {
    const cfg = { model_groups: {}, model_metrics: {}, providers: { weird: { free_models: 'abc' } } } as any as Config;
    const cache = { available_models: [] } as any as Cache;
    const refs = new Router(cfg, cache, new Map()).allDiscoveredRefs();
    expect(refs).toEqual([]);
  });
});

describe('isVirtualGroupRef — one-character provider', () => {
  it('"a/a" is the virtual ref of group "a"', () => {
    expect(isVirtualGroupRef('a/a', new Set(['a']))).toBe(true);
    expect(isVirtualGroupRef('a/a:use-static', new Set(['a']))).toBe(true);
  });
});
