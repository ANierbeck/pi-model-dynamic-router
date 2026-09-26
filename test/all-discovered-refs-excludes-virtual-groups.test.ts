/**
 * Regression test: allDiscoveredRefs() must exclude the router's own virtual
 * group-provider models from candidate lists, without removing them from
 * Pi's registry.
 *
 * Symptom (2026-09-10): /router showed trivial/trivial, simple/simple as the
 * top models for their own groups — a circular reference:
 *   1. registerGroupProviders() registers a virtual model with id=groupName
 *      (e.g. 'trivial') for each group, so users/Pi can select a group as
 *      the active model (README: "You select `dynamic` group").
 *   2. Pi's registry surfaces these virtual models via getAvailable().
 *   3. allDiscoveredRefs() included them as candidates.
 *   4. resolve('trivial') selected 'trivial/trivial' as its own top
 *      candidate — a circular reference with no real cost/gdpval.
 *
 * First attempted fix (models: []) removed the virtual models entirely,
 * which broke the SELECTION entry point (--model dynamic/dynamic no longer
 * resolved to anything, so the dynamic router became inaccessible after a
 * reload — reported 2026-09-15). Correct fix: keep the models registered,
 * but filter them out of allDiscoveredRefs() so they're never considered a
 * resolution CANDIDATE, while remaining selectable as an entry point.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Router, isVirtualGroupRef } from '../src/routing.ts';
import type { Config, Cache } from '../src/types.ts';
import * as metricsModule from '../src/metrics.ts';

function makeRegistry(models: Array<{ provider: string; id: string; cost?: { input: number; output: number } }>) {
  const all = models.map((m) => ({
    provider: m.provider,
    id: m.id,
    cost: m.cost
      ? { input: m.cost.input, output: m.cost.output, cacheRead: 0, cacheWrite: 0 }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  return {
    find: (provider: string, modelId: string) => all.find((m) => m.provider === provider && m.id === modelId),
    getAvailable: () => all,
    getRegisteredProviderIds: () => [...new Set(all.map((m) => m.provider))],
  };
}

describe('allDiscoveredRefs() excludes virtual group self-references', () => {
  const cfg: Config = {
    model_groups: {
      trivial: {
        description: 'Trivial',
        method: 'min_cost_if_all_priced',
        max_cost: 0,
        min_gdpval: 0,
        fallback_groups: [],
      },
      dynamic: {
        description: 'Dynamic',
        method: 'dynamic',
        fallback_groups: [],
      },
    },
    providers: {},
    model_metrics: {},
    gdpval_builtin: {},
  } as any;

  const cache: Cache = {
    available_models: [],
    gdpval_scores: {},
    model_score_cache: {},
    openrouter_pricing: {},
    usage_log: [],
    benchmarks: {},
    budget_cache: {},
    gdpval_scraped: true,
    lastScanTimestamp: Date.now(),
    models_cached: '',
  } as any;

  beforeEach(() => {
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);
    metricsModule.setModelMap({}, []);
  });

  it('drops <group>/<group> and <group>/<group>:use-static refs, keeps real models', () => {
    // The registry contains BOTH the virtual group models (as
    // registerGroupProviders() would register them) AND a real model.
    const registry = makeRegistry([
      { provider: 'trivial', id: 'trivial' }, // virtual self-ref
      { provider: 'dynamic', id: 'dynamic' }, // virtual self-ref
      { provider: 'dynamic', id: 'dynamic:use-static' }, // virtual self-ref
      { provider: 'mistral', id: 'glm-5-2', cost: { input: 0.3, output: 0.9 } }, // real model
    ]);

    const router = new Router(cfg, cache, new Map());
    router.setSessionCtx({ modelRegistry: registry } as any);

    const refs = router.allDiscoveredRefs();

    expect(refs).not.toContain('trivial/trivial');
    expect(refs).not.toContain('dynamic/dynamic');
    expect(refs).not.toContain('dynamic/dynamic:use-static');
    expect(refs).toContain('mistral/glm-5-2');
  });

  it('resolve("trivial") never selects trivial/trivial as its own candidate', () => {
    const registry = makeRegistry([
      { provider: 'trivial', id: 'trivial' },
      { provider: 'mistral', id: 'free-model:free', cost: { input: 0, output: 0 } },
    ]);

    const router = new Router(cfg, cache, new Map());
    router.setSessionCtx({ modelRegistry: registry } as any);

    const res = router.resolve('trivial');
    expect(res).not.toBeNull();
    expect(res!.selected).not.toBe('trivial/trivial');
    expect(res!.candidates).not.toContain('trivial/trivial');
    expect(res!.selected).toBe('mistral/free-model:free');
  });

  it('a group whose only registry entry is its own virtual model resolves to null (not itself)', () => {
    // No real models at all — only the virtual self-ref. Must not select
    // itself; must return null (no viable candidate) instead.
    const registry = makeRegistry([{ provider: 'trivial', id: 'trivial' }]);

    const router = new Router(cfg, cache, new Map());
    router.setSessionCtx({ modelRegistry: registry } as any);

    const res = router.resolve('trivial');
    expect(res).toBeNull();
  });
});

describe('isVirtualGroupRef() predicate', () => {
  const groupNames = new Set(['trivial', 'dynamic']);

  it('flags <group>/<group> and <group>/<group>:use-static', () => {
    expect(isVirtualGroupRef('trivial/trivial', groupNames)).toBe(true);
    expect(isVirtualGroupRef('dynamic/dynamic', groupNames)).toBe(true);
    expect(isVirtualGroupRef('dynamic/dynamic:use-static', groupNames)).toBe(true);
  });

  it('does not flag real models, even those under a group-named provider', () => {
    expect(isVirtualGroupRef('mistral/glm-5-2', groupNames)).toBe(false);
    // A real model registered under a group-named provider (id differs) is
    // NOT a virtual self-ref and must stay eligible.
    expect(isVirtualGroupRef('trivial/some-real-model', groupNames)).toBe(false);
  });

  it('does not flag a non-existent group or a ref without a slash', () => {
    expect(isVirtualGroupRef('unknown/unknown', groupNames)).toBe(false);
    expect(isVirtualGroupRef('trivial', groupNames)).toBe(false);
  });
});

describe('unknown-cost diagnostic excludes virtual group refs', () => {
  const baseCfg: Config = {
    model_groups: {
      trivial: { description: 'Trivial', method: 'min_cost_if_all_priced', max_cost: 0, min_gdpval: 0, fallback_groups: [] },
    },
    providers: {},
    model_metrics: {},
    gdpval_builtin: {},
  } as any;
  const cache: Cache = { available_models: [], gdpval_scores: {}, model_score_cache: {}, openrouter_pricing: {}, usage_log: [], benchmarks: {}, budget_cache: {}, gdpval_scraped: true, lastScanTimestamp: Date.now(), models_cached: '' } as any;

  beforeEach(() => {
    metricsModule.setConfig(baseCfg);
    metricsModule.setCache(cache);
    metricsModule.setModelMap({}, []);
  });

  it('keeps the "unknown cost" log free of routing artefacts (preventive)', () => {
    // A virtual group self-ref normally picks up effCost's default price
    // (0.000020), not 'unknown' — so today it does not appear in the log.
    // But a user model_metrics override (or a future change to the default)
    // could make it 'unknown'. The diagnostic path (index.ts) filters
    // virtual refs FIRST, so the log stays free of routing artefacts
    // regardless of how their cost resolves.
    const cfgWithUnknown = { ...baseCfg, model_metrics: { 'trivial/trivial': { cost_per_m: 'unknown' } } } as any;
    metricsModule.setConfig(cfgWithUnknown);

    const registry = makeRegistry([{ provider: 'trivial', id: 'trivial' }]);
    const allModelRefs = [...new Set(registry.getAvailable().map((m) => `${m.provider}/${m.id}`))];

    // Confirmed leak without the filter: the virtual ref resolves to
    // 'unknown' under the override and would be diagnosed.
    expect(metricsModule.collectUnknownCostRefs(allModelRefs)).toContain('trivial/trivial');

    // The fix: filter virtual group refs before the diagnostic (mirrors
    // index.ts applying isVirtualGroupRef before collectUnknownCostRefs).
    const groupNames = new Set(Object.keys(baseCfg.model_groups));
    const diagnosticRefs = allModelRefs.filter((r) => !isVirtualGroupRef(r, groupNames));
    expect(metricsModule.collectUnknownCostRefs(diagnosticRefs)).not.toContain('trivial/trivial');
  });
});
