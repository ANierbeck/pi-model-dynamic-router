/**
 * ADR-0025 Phase B1: free-tier candidates are DERIVED, not shipped.
 *
 * The shipped `providers.openrouter.free_models` list is gone from
 * router-config.json. Free-tier models now come from the scan
 * (cache.available_models carries every OpenRouter `pricing.prompt === '0'`
 * entry) and from Pi's registry — and they must pass the SAME credential gate
 * as every other candidate. OpenRouter needs a key even for its free tier
 * (2026-10-06 incident: a keyless user's cheap groups filled with dead
 * `openrouter/*:free` refs). The `free_models` key itself stays supported as a
 * user-layer key.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isStreamableRef } from '../src/streamable-refs.ts';
import { Router } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.ts';
import type { Config, Cache } from '../src/types.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Fake provider/model: nothing here is a real model id (ADR-0025).
const FREE_REF = 'acme-router/vendor/tiny-1:free';

describe('shipped router-config.json carries no free_models list', () => {
  it('no provider entry names free_models', () => {
    const shipped = JSON.parse(readFileSync(path.join(REPO_ROOT, 'router-config.json'), 'utf-8'));
    const offenders = Object.entries(shipped.providers ?? {})
      .filter(([, p]: [string, any]) => p && 'free_models' in p)
      .map(([id]) => id);
    expect(offenders).toEqual([]);
  });
});

describe('persist path: a scan-discovered :free ref needs the provider credential gate', () => {
  // The scan pushes the free-tier entry; Pi's builtin catalog knows the model
  // (registry `find` resolves it) whether or not the user holds a key.
  const baseCtx = {
    hasRegistryModel: (provider: string, modelId: string) =>
      provider === 'acme-router' && modelId === 'vendor/tiny-1:free',
    isLocalProvider: () => false,
    freeModelRefs: new Set<string>(),
  };

  it('admits the ref when Pi can authenticate the provider', () => {
    expect(isStreamableRef(FREE_REF, { ...baseCtx, hasConfiguredAuth: () => true })).toBe(true);
  });

  it('drops the ref when the provider has no credentials (the incident class)', () => {
    expect(isStreamableRef(FREE_REF, { ...baseCtx, hasConfiguredAuth: () => false })).toBe(false);
  });

  it('never asks the credential gate for local runtimes', () => {
    const ctx = { ...baseCtx, isLocalProvider: (p: string) => p === 'local-daemon', hasConfiguredAuth: () => false };
    expect(isStreamableRef('local-daemon/anything:7b', ctx)).toBe(true);
  });
});

describe('live path: free-tier candidates follow the credential gate', () => {
  const cache = {
    available_models: [{ id: 'vendor/tiny-1:free', provider: 'acme-router', cost_per_m: 0 }],
    gdpval_scores: {},
    model_score_cache: {},
    openrouter_pricing: {},
    usage_log: [],
    benchmarks: {},
    budget_cache: {},
    gdpval_scraped: true,
    lastScanTimestamp: Date.now(),
    models_cached: '',
  } as any as Cache;

  function makeRouter(opts: { configured: boolean; cfgProviders?: Config['providers'] }) {
    const cfg = {
      model_groups: {
        trivial: { description: 't', method: 'min_cost_if_all_priced', max_cost: 0, min_gdpval: 0, fallback_groups: [] },
      },
      providers: opts.cfgProviders ?? {},
      model_metrics: {},
      gdpval_builtin: {},
    } as any as Config;
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);
    metricsModule.setModelMap({}, []);
    // Pi's getAvailable() returns only models whose provider holds credentials.
    const model = { provider: 'acme-router', id: 'vendor/tiny-1:free', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const registry = {
      find: (p: string, id: string) => (p === model.provider && id === model.id ? model : undefined),
      getAvailable: () => (opts.configured ? [model] : []),
      getRegisteredProviderIds: () => [model.provider],
      hasConfiguredAuth: () => opts.configured,
      runtime: { hasConfiguredAuth: () => opts.configured },
    };
    const router = new Router(cfg, cache, new Map());
    router.setSessionCtx({ modelRegistry: registry } as any);
    return router;
  }

  beforeEach(() => metricsModule.setModelMap({}, []));

  // With a session registry present, allDiscoveredRefs serves registry refs
  // (getAvailable), not cache.available_models — the "entry" here is the
  // registry's model, admitted because the provider is credentialed. The
  // scan-entry admission itself is pinned by the save-path tests above.
  it('credentialed provider: the :free registry entry is a candidate with no shipped list', () => {
    expect(makeRouter({ configured: true }).allDiscoveredRefs()).toContain(FREE_REF);
  });

  it('keyless provider: no candidate', () => {
    expect(makeRouter({ configured: false }).allDiscoveredRefs()).not.toContain(FREE_REF);
  });

  it('user-layer free_models still admits its refs when credentialed', () => {
    const userRef = 'acme-router/vendor/pinned-2:free';
    const router = makeRouter({ configured: true, cfgProviders: { 'acme-router': { free_models: [userRef] } } as any });
    expect(router.allDiscoveredRefs()).toContain(userRef);
  });

  it('user-layer free_models stays gated when the provider has no key', () => {
    const userRef = 'acme-router/vendor/pinned-2:free';
    const router = makeRouter({ configured: false, cfgProviders: { 'acme-router': { free_models: [userRef] } } as any });
    expect(router.allDiscoveredRefs()).not.toContain(userRef);
  });
});
