// test/resolve-group-dispatch.test.ts — Batch 4 of the mutation-survivor
// triage (ledger: routing.ts:1000-1100). Closes the REAL-GAP survivors in
// resolveGroup's method dispatch and detectGroup's head — almost the entire
// region was NoCoverage: the pipeline/roundrobin/top_k branches had NEVER
// been driven end-to-end through the public Router.resolve().
//
//   - explicit `models` list intersects with discovered refs
//   - pipeline steps (sort + per-step top_k truncation)
//   - roundrobin rotation across successive resolves
//   - min_cost_if_all_priced dispatch with group top_k
//   - generic else-branch (any sortBy method) with top_k
//   - 'best' must NOT fall into the tiered branch
//   - detectGroup: activeGroup pinning, dynamic-group exclusion,
//     threshold ordering (highest min_gdpval first)

import { describe, it, expect, beforeAll } from 'vitest';
import { Router } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

const testConfig: Config = {
  model_groups: {
    // NOTE: object order is deliberate — see the detectGroup tests: the
    // unsorted iteration order differs from the sorted threshold order.
    dyno: { method: 'dynamic', min_gdpval: 800 },
    complexish: { method: 'best', min_gdpval: 400 },
    tacticalish: { method: 'best', min_gdpval: 700 },
    pipe: {
      method: 'pipeline',
      pipeline: [
        { method: 'max_gdpval', top_k: 2 },
        { method: 'min_cost' },
      ],
    },
    rr: { method: 'roundrobin', models: ['provx/aaa', 'provx/bbb'] },
    mc: { method: 'min_cost_if_all_priced', top_k: 2 },
    gen: { method: 'max_gdpval', top_k: 1 },
    bestgrp: { method: 'best' },
    ex: { method: 'max_gdpval', models: ['provx/ccc', 'provx/never-discovered'] },
  },
  model_metrics: {
    'provx/aaa': { gdpval: 300, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 2 },
    'provx/bbb': { gdpval: 200, throughput_tps: 20, avg_latency_ms: 200, cost_per_m: 1 },
    'provx/ccc': { gdpval: 100, throughput_tps: 30, avg_latency_ms: 300, cost_per_m: 3 },
  },
  providers: {},
  // detectGroup reads scores through the slug pipeline: direct builtin keys.
  gdpval_builtin: { aaa: 900 },
} as any;

const cache: Cache = {
  available_models: [
    { id: 'aaa', provider: 'provx', cost_per_m: 2 },
    { id: 'bbb', provider: 'provx', cost_per_m: 1 },
    { id: 'ccc', provider: 'provx', cost_per_m: 3 },
  ],
} as any;

beforeAll(() => {
  metricsModule.setConfig(testConfig);
  metricsModule.setCache(cache);
  metricsModule.setModelRegistry({ find: () => undefined } as any);
});

describe('resolveGroup method dispatch (via public resolve)', () => {
  it("pipeline: step sorts apply, per-step top_k truncates", () => {
    const router = new Router(testConfig, cache, new Map());
    const r = router.resolve('pipe');
    expect(r).not.toBeNull();
    // step 1: max_gdpval desc [aaa, bbb, ccc], top_k 2 → [aaa, bbb]
    // step 2: min_cost asc → [bbb, aaa]
    expect(r!.candidates).toEqual(['provx/bbb', 'provx/aaa']);
    expect(r!.selected).toBe('provx/bbb');
  });

  it('roundrobin: successive resolves ROTATE through the models', () => {
    const router = new Router(testConfig, cache, new Map());
    expect(router.resolve('rr')!.selected).toBe('provx/aaa');
    expect(router.resolve('rr')!.selected).toBe('provx/bbb');
    expect(router.resolve('rr')!.selected).toBe('provx/aaa');
  });

  it("min_cost_if_all_priced: sorted by cost, group top_k truncates", () => {
    const router = new Router(testConfig, cache, new Map());
    const r = router.resolve('mc');
    expect(r!.candidates).toEqual(['provx/bbb', 'provx/aaa']);
    expect(r!.selected).toBe('provx/bbb');
  });

  it('generic method with top_k: candidates truncated to top_k', () => {
    const router = new Router(testConfig, cache, new Map());
    const r = router.resolve('gen');
    expect(r!.candidates).toEqual(['provx/aaa']);
    expect(r!.selected).toBe('provx/aaa');
  });

  it("'best' does NOT fall into the tiered/billing branch", () => {
    // best → score desc [aaa, bbb, ccc]; tiered default for same-provider
    // payg models → cost tiebreak [bbb, aaa, ccc]. The first candidate
    // discriminates the two dispatch paths.
    const router = new Router(testConfig, cache, new Map());
    const r = router.resolve('bestgrp');
    expect(r!.candidates[0]).toBe('provx/aaa');
  });

  it('an explicit models list INTERSECTS with discovered refs', () => {
    const router = new Router(testConfig, cache, new Map());
    const r = router.resolve('ex');
    // 'provx/never-discovered' is not in available_models → only ccc stays.
    expect(r!.candidates).toEqual(['provx/ccc']);
    expect(r!.selected).toBe('provx/ccc');
  });
});

describe('detectGroup — pinning, dynamic exclusion, threshold order', () => {
  it('activeGroup pinning wins over threshold detection', () => {
    const router = new Router(testConfig, cache, new Map());
    router.setActiveGroup('strategic');
    expect(router.detectGroup('provx/aaa')).toBe('strategic');
    router.setActiveGroup(null);
    expect(router.detectGroup('provx/aaa')).toBe('tacticalish');
  });

  it("dynamic groups are NOT threshold candidates; highest min_gdpval wins", () => {
    // aaa scores 900. Threshold order (desc): dyno is dynamic (excluded),
    // tacticalish (700) before complexish (400) → 900 >= 700 → tacticalish.
    // The config's OBJECT order (complexish first) is deliberately wrong
    // for iteration order — only the sort produces the right answer.
    const router = new Router(testConfig, cache, new Map());
    expect(router.detectGroup('provx/aaa')).toBe('tacticalish');
  });
});
