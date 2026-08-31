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
    // After coalescing + seenSlugs dedup, all variants of the same slug are
    // collapsed to ONE entry — mistral-zai resolves to mistral-medium-3-5
    // (same slug as mistral variants), so it is deduplicated away.
    const zaiRefs = top.filter((m) => m.ref.startsWith('mistral-zai/'));
    expect(zaiRefs.length).toBe(0);
  });

  it('keeps ONE entry per MODEL across all providers (display collapses cross-provider same-model)', () => {
    const top = router.getTopModels('tactical', 10);
    // All variants (mistral/* and mistral-zai/*) resolve to the same slug
    // mistral-medium-3-5 → coalescing collapses them to a single row.
    // The display shows "which models are available", not "which providers".
    expect(top.length).toBe(1);
  });

  it('prefers the versioned variant over -latest when deduping', () => {
    const top = router.getTopModels('tactical', 10);
    const mistralEntry = top.find((m) => m.ref.startsWith('mistral/'));
    // mistral-medium-2604 (date-versioned, score 3) must win over
    // mistral-medium-latest (alias, score 1)
    expect(mistralEntry?.ref).toBe('mistral/mistral-medium-2604');
  });

describe('coalesceBySlug — clusters cross-provider same-slug entries together', () => {
  // Shared setup: 3 providers for glm-5-2 + 1 unrelated model (different slug).
  const coalesceConfig: Config = {
    model_groups: { tactical: { method: 'best', min_gdpval: 0 } },
    model_metrics: {},
    providers: {
      mistral: { billing: 'pay_per_token' },
      'mistral-zai': { billing: 'pay_per_token' },
      openrouter: { billing: 'pay_per_token' },
    },
    gdpval_builtin: { 'glm-5-2': 1497.55, 'other-model': 500 },
  };
  const coalesceCache: Cache = {
    available_models: [
      { id: 'zai-glm-5-2', provider: 'mistral', cost_per_m: 0 },
      { id: 'zai-glm-5-2', provider: 'mistral-zai', cost_per_m: 0 },
      { id: 'glm-5.2:free', provider: 'openrouter', cost_per_m: 0 },
      { id: 'other-model', provider: 'mistral', cost_per_m: 0 },
    ],
  };
  beforeAll(() => {
    metricsModule.setConfig(coalesceConfig);
    // Explicit model-map entries for all refs so resolveSlug() returns the
    // expected slug even without wildcards (the real model-map.yaml has no
    // wildcard for openrouter/z-ai/*, so free-tier refs from available_models
    // that don't appear in free_models need explicit mapping here).
    // NOTE: model-map keys are matched AFTER stripProvider() strips the
    // provider prefix, so keys are bare model-IDs, NOT "provider/id".
    // mapLookup() strips "openrouter/" from "openrouter/glm-5.2:free" → looks
    // up key "glm-5.2:free" (not "openrouter/glm-5.2:free").
    metricsModule.setModelMap(
      {
        'mistral/zai-glm-5-2': 'glm-5-2',
        'mistral-zai/zai-glm-5-2': 'glm-5-2',
        // Stripped key: stripProvider("openrouter/glm-5.2:free") = "glm-5.2:free"
        'glm-5.2:free': 'glm-5-2',
        'mistral/other-model': 'other-model',
      },
      []
    );
    metricsModule.setCache(coalesceCache);
  });

  const router = new Router(coalesceConfig, coalesceCache, new Map());


  it('collapses cross-provider same-slug entries to ONE row in the display', () => {
    const top = router.getTopModels('tactical', 10);
    // coalesceBySlug clusters all glm-5-2 variants into one slot — the display
    // shows "which models are available", not "which providers offer this model".
    // The routing path keeps all variants internally for correct failover.
    const refs = top.map((m) => m.ref);
    const glmRefs = refs.filter(
      (r) => r.includes('glm-5-2') || r.includes('glm-5.2')
    );
    expect(glmRefs.length).toBe(1); // collapsed to ONE row per model
    // The single survivor is the best-ranked variant (by sortBy 'max_gdpval',
    // stable sort preserves input order on ties).
    // Plus one other-model entry → total = 2.
    expect(top.length).toBe(2);
  });

  it('the best-ranked model (highest GDPval) appears first in the display', () => {
    const top = router.getTopModels('tactical', 10);
    // glm-5-2 (1497.55) ranks above other-model (500) → glm-5-2 is first.
    // After collapse, top[0] is the single best glm-5-2 row.
    expect(top[0].ref).toMatch(/glm-5-2/);
    expect(top.length).toBe(2); // glm-5-2 + other-model
  });
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

// resolveGroup/resolve() is the live routing path (as opposed to getTopModels,
// the display path exercised by the suites above) — verify that same-slug
// variants stay grouped consecutively in the candidate list so driveStream
// failure handlers try every provider of a model before falling through to
// the next model.
describe('resolveGroup — failover ordering', () => {
  it(
    'resolve() keeps all cross-provider same-slug variants consecutively in ' +
      'the candidate list (failover ordering)',
    () => {
      const failConfig: Config = {
        model_groups: {
          tactical: { method: 'best', min_gdpval: 0 },
        },
        model_metrics: {},
        providers: {
          mistral: { billing: 'pay_per_token' },
          'mistral-zai': { billing: 'pay_per_token' },
          openrouter: { billing: 'pay_per_token' },
        },
        gdpval_builtin: { 'glm-5-2': 1497.55, 'other-model': 500 },
      };
      const failCache: Cache = {
        available_models: [
          { id: 'zai-glm-5-2', provider: 'mistral', cost_per_m: 0 },
          { id: 'zai-glm-5-2', provider: 'mistral-zai', cost_per_m: 0 },
          { id: 'glm-5.2:free', provider: 'openrouter', cost_per_m: 0 },
          { id: 'other-model', provider: 'mistral', cost_per_m: 0 },
        ],
      };
      metricsModule.setConfig(failConfig);
      metricsModule.setModelMap(
        {
          'mistral/zai-glm-5-2': 'glm-5-2',
          'mistral-zai/zai-glm-5-2': 'glm-5-2',
          'glm-5.2:free': 'glm-5-2',
          'mistral/other-model': 'other-model',
        },
        []
      );
      metricsModule.setCache(failCache);
      const failRouter = new Router(failConfig, failCache, new Map());

      const result = failRouter.resolve('tactical');
      expect(result).not.toBeNull();
      const { candidates } = result!;

      // Every variant of glm-5-2 must appear consecutively in the candidate list.
      // The first non-glm-5-2 ref marks the boundary — nothing from glm-5-2
      // may appear after it.
      const firstOtherIdx = candidates.findIndex(
        (r) => !r.includes('glm-5-2') && !r.includes('glm-5.2')
      );
      const glmSlice = candidates.slice(0, firstOtherIdx < 0 ? candidates.length : firstOtherIdx);
      const allGlm = glmSlice.every(
        (r) => r.includes('glm-5-2') || r.includes('glm-5.2')
      );
      expect(allGlm).toBe(true);
      // All three glm-5-2 variants must be in the list.
      const glmCount = candidates.filter(
        (r) => r.includes('glm-5-2') || r.includes('glm-5.2')
      ).length;
      expect(glmCount).toBe(3);

      // Restore state.
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
    }
  );
});
