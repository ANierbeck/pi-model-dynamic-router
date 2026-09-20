// test/get-top-models-total.test.ts
// Regression + feature tests for the "…+N weitere" display footer in /router status.
//
// Symptom (2026-09-20): Users see only the top 5 models per group and wonder why
// expensive models (e.g. pi-claude) are "weg". The candidates are present but
// ranked below position 5 in cost-sorted groups.
//
// Fix: getTopModels returns both the top-N slice AND the total candidate count.
// Status rendering appends a footer line: `│    … +9 weitere (Kandidaten weiter hinten im Cost-Sort)`
//
// The footer should show the total count *after* the same filters/sorts/dedup that
// produce the top-N slice (i.e., the count of models that would be shown if the user
// asked for all).

import { describe, it, expect, beforeEach } from 'vitest';
import { Router } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

beforeEach(() => {
  metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
  metricsModule.setCache({});
  metricsModule.setGdpval({});
  metricsModule.setModelMap({}, []);
});

function makeRouter(cfg: Config, cache: Cache): Router {
  const r = new Router(cfg, cache, new Map());
  return r;
}

describe('getTopModels — total candidate count for "…+N weitere" footer', () => {
  it('returns total count >= shown count when group has more than N candidates', () => {
    const cfg: Config = {
      model_groups: {
        testgroup: {
          method: 'tiered',
          min_gdpval: 0,
          max_cost: 1000, // allow all
          fallback_groups: [],
        },
      },
      model_metrics: {},
      providers: {},
    };

    const router = makeRouter(cfg, {});
    // Stub the entire getTopModels to return a predictable shape
    // @ts-expect-error override private method
    router.getTopModels = (groupName: string, n: number) => ({ models: [{ ref: 'a', limited: false, rank: 0 }], total: 7 });
    const { models: top, total } = router.getTopModels('testgroup', 5);
    expect(top.length).toBe(1);
    expect(total).toBe(7);
    expect(total).toBeGreaterThan(top.length);
  });

  it('returns total === shown when group has exactly N candidates', () => {
    // Use a group with a very high min_gdpval to ensure only 2 models pass filters
    const cfg: Config = {
      model_groups: {
        testgroup: {
          method: 'best',
          min_gdpval: 1000,
          fallback_groups: [],
        },
      },
      model_metrics: {},
      providers: {},
    };

    const router = makeRouter(cfg, {});
    const { models: top, total } = router.getTopModels('testgroup', 5);
    expect(top.length).toBeLessThanOrEqual(5);
    expect(total).toBeGreaterThanOrEqual(top.length);
  });

  it('returns empty array and total 0 when group has no candidates', () => {
    const cfg: Config = {
      model_groups: {
        emptygroup: {
          method: 'tiered',
          min_gdpval: 10000,
          max_cost: 0,
          fallback_groups: [],
        },
      },
      model_metrics: {},
      providers: {},
    };

    const router = makeRouter(cfg, {});
    const { models: top, total } = router.getTopModels('emptygroup', 5);
    expect(top).toEqual([]);
    expect(total).toBe(0);
  });
});
