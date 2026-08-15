// test/router-cache-refresh.test.ts
// Regression guard: the Router must follow index.ts's cache reassignments.
//
// BACKGROUND: index.ts REPLACES its `cache` variable on several paths
// (loadCache, discoverKeys, budget refresh) and notifies metrics, the
// rate-limit manager and the budget tracker each time. The Router was never
// notified, so it kept reading the object it was constructed with — every
// cache-derived decision (discovered models, exclude lookups, dedup, model
// health) silently operated on stale data for the rest of the session.

import { describe, it, expect } from 'vitest';
import { Router } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.ts';
import type { Config, Cache } from '../src/types.ts';

const CFG: Config = {
  model_groups: {
    scout: { description: 'any', method: 'tiered', min_gdpval: 0, fallback_groups: [] },
  },
  providers: {},
} as any;

function makeCache(models: { id: string; provider: string }[]): Cache {
  return {
    available_models: models.map((m) => ({ ...m, cost_per_m: 0 })),
    gdpval_scores: {},
    model_score_cache: {},
    openrouter_pricing: {},
  } as any;
}

function makeRouter(cache: Cache): Router {
  metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
  metricsModule.setCache(cache);
  metricsModule.setGdpval({});
  metricsModule.setModelMap({}, []);
  return new Router(CFG, cache, new Map());
}

describe('Router.updateCache', () => {
  it('picks up models discovered after construction', () => {
    const initial = makeCache([{ id: 'old-model', provider: 'mistral' }]);
    const router = makeRouter(initial);
    expect(router.allDiscoveredRefs()).toContain('mistral/old-model');

    // index.ts replaces its cache object wholesale (e.g. after a scan).
    const refreshed = makeCache([
      { id: 'old-model', provider: 'mistral' },
      { id: 'newly-scanned', provider: 'mistral' },
    ]);
    metricsModule.setCache(refreshed);
    router.updateCache(refreshed);

    expect(router.allDiscoveredRefs()).toContain('mistral/newly-scanned');
  });

  it('drops models that disappeared from the refreshed cache', () => {
    const initial = makeCache([
      { id: 'stays', provider: 'mistral' },
      { id: 'goes-away', provider: 'mistral' },
    ]);
    const router = makeRouter(initial);
    expect(router.allDiscoveredRefs()).toContain('mistral/goes-away');

    const refreshed = makeCache([{ id: 'stays', provider: 'mistral' }]);
    metricsModule.setCache(refreshed);
    router.updateCache(refreshed);

    expect(router.allDiscoveredRefs()).toContain('mistral/stays');
    expect(router.allDiscoveredRefs()).not.toContain('mistral/goes-away');
  });

  it('reads model health from the refreshed cache, not the construction-time one', () => {
    const initial = makeCache([{ id: 'a', provider: 'mistral' }]);
    const router = makeRouter(initial);

    // Health recorded against a *replacement* cache object, mirroring what
    // index.ts does after loadCache().
    const refreshed = makeCache([{ id: 'a', provider: 'mistral' }]);
    (refreshed as any).model_health = {
      'mistral/a': { fails: 5, last_fail: Date.now() },
    };
    metricsModule.setCache(refreshed);
    router.updateCache(refreshed);

    // The router must see the streak; with a stale reference it would see none.
    const health = (router as any).cache.model_health;
    expect(health?.['mistral/a']?.fails).toBe(5);
  });
});
