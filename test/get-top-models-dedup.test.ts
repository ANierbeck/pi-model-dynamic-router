// test/get-top-models-dedup.test.ts
// Regression guard: getTopModels() (the ONLY path the /router display uses)
// built its candidate list independently from resolveGroup (the live
// and never called dedupByModelIdentity(). So the /router table showed every
// alias of the same underlying model as a separate row (mistral-medium-2604,
// -3.5, -latest, and the mistral-zai equivalents all listed individually)
// even though the actual routing DECISION (via resolveGroup) had already
// deduped them — a display-only divergence from what the router really does.

import { describe, it, expect, beforeAll } from 'vitest';
import { Router } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

const testConfig: Config = {
  model_groups: {
    tactical: { method: 'best', min_gdpval: 600 },
  },
  model_metrics: {},
  providers: {
    mistral: { billing: 'pay_per_token' },
    'mistral-zai': { billing: 'pay_per_token' },
  },
  gdpval_builtin: {
    'mistral-medium-3-5': 933,
  },
};

const cache: Cache = {
  available_models: [
    { id: 'mistral-medium-2604', provider: 'mistral', cost_per_m: 0 },
    { id: 'mistral-medium-3.5', provider: 'mistral', cost_per_m: 1.5 },
    { id: 'mistral-medium-latest', provider: 'mistral', cost_per_m: 0 },
    { id: 'mistral-medium-latest', provider: 'mistral-zai', cost_per_m: 0 },
    { id: 'mistral-medium', provider: 'mistral-zai', cost_per_m: 0 },
  ],
};

beforeAll(() => {
  metricsModule.setConfig(testConfig);
  metricsModule.setModelMap(
    {
      'mistral-medium-2604': 'mistral-medium-3-5',
      'mistral-medium-3.5': 'mistral-medium-3-5',
      'mistral-medium-latest': 'mistral-medium-3-5',
      'mistral-medium': 'mistral-medium-3-5',
    },
    []
  );
  metricsModule.setCache(cache);
});

describe('getTopModels — deduplicates aliases of the same underlying model', () => {
  const router = new Router(testConfig, cache, new Map());

  it('collapses same-provider aliases (mistral/*) to a single entry', () => {
    const top = router.getTopModels('tactical', 10);
    const mistralRefs = top.filter((m) => m.ref.startsWith('mistral/'));
    // 3 mistral/* aliases (2604, 3.5, latest) all resolve to the same slug →
    // only ONE should survive, matching resolveGroup's dedup behavior.
    expect(mistralRefs.length).toBe(1);
  });

  it('collapses same-provider aliases (mistral-zai/*) to a single entry', () => {
    const top = router.getTopModels('tactical', 10);
    const zaiRefs = top.filter((m) => m.ref.startsWith('mistral-zai/'));
    // 2 mistral-zai/* aliases (latest, bare) resolve to the same slug →
    // only ONE should survive.
    expect(zaiRefs.length).toBe(1);
  });

  it('keeps ONE entry per PROVIDER (cross-provider duplicates are not merged)', () => {
    const top = router.getTopModels('tactical', 10);
    // mistral/* and mistral-zai/* are different providers offering the same
    // model — both should survive (useful for failover), just not the
    // within-provider aliases.
    const providers = new Set(top.map((m) => m.ref.split('/')[0]));
    expect(providers.has('mistral')).toBe(true);
    expect(providers.has('mistral-zai')).toBe(true);
    expect(top.length).toBe(2);
  });

  it('prefers the versioned variant over -latest when deduping', () => {
    const top = router.getTopModels('tactical', 10);
    const mistralEntry = top.find((m) => m.ref.startsWith('mistral/'));
    // mistral-medium-2604 (date-versioned, score 3) must win over
    // mistral-medium-latest (alias, score 1)
    expect(mistralEntry?.ref).toBe('mistral/mistral-medium-2604');
  });

  it('prefers an explicit version name over -latest', () => {
    // mistral-medium-3.5 (explicit version, score 2) must win over
    // mistral-medium-latest (alias, score 1) — the middle rung of the
    // preference order that the same-provider cases above don't exercise.
    const explicitVsLatestConfig: Config = {
      model_groups: { tactical: { method: 'best', min_gdpval: 0 } },
      model_metrics: {},
      providers: { mistral: { billing: 'pay_per_token' } },
      gdpval_builtin: { 'mistral-medium-3-5': 933 },
    };
    const explicitVsLatestCache: Cache = {
      available_models: [
        { id: 'mistral-medium-latest', provider: 'mistral', cost_per_m: 0 },
        { id: 'mistral-medium-3.5', provider: 'mistral', cost_per_m: 1.5 },
      ],
    };
    metricsModule.setConfig(explicitVsLatestConfig);
    metricsModule.setModelMap(
      {
        'mistral-medium-latest': 'mistral-medium-3-5',
        'mistral-medium-3.5': 'mistral-medium-3-5',
      },
      []
    );
    metricsModule.setCache(explicitVsLatestCache);
    const explicitRouter = new Router(explicitVsLatestConfig, explicitVsLatestCache, new Map());
    const result = explicitRouter.getTopModels('tactical', 10);
    expect(result.map((m) => m.ref)).toEqual(['mistral/mistral-medium-3.5']);

    // Restore the outer suite's shared state for subsequent tests.
    metricsModule.setConfig(testConfig);
    metricsModule.setModelMap(
      {
        'mistral-medium-2604': 'mistral-medium-3-5',
        'mistral-medium-3.5': 'mistral-medium-3-5',
        'mistral-medium-latest': 'mistral-medium-3-5',
        'mistral-medium': 'mistral-medium-3-5',
      },
      []
    );
    metricsModule.setCache(cache);
  });
});
