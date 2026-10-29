// getTopModels carries the ranking reason for `best` groups (src/rank-explain.ts)
// into the /router display, and only there: the order itself is the ranking's.

import { describe, it, expect, beforeAll } from 'vitest';
import { Router } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

const cfg = {
  model_groups: {
    planning: { method: 'best', score_by: 'briefcase' },
    code_complex: { method: 'best', score_by: 'coding' },
    standard: { method: 'tiered' },
  },
  model_metrics: {
    'claude-bridge/claude-sonnet-5-5': { cost_per_m: 2 },
    'claude-bridge/claude-opus-5-5': { cost_per_m: 4 },
  },
  providers: { 'claude-bridge': { billing: 'pay_per_token' } },
  gdpval_builtin: { 'claude-sonnet-5-5': 1844, 'claude-opus-5-5': 1900 },
  best_quality_window: 0.05,
} as unknown as Config;

const cache = {
  available_models: [
    { id: 'claude-sonnet-5-5', provider: 'claude-bridge', cost_per_m: 2 },
    { id: 'claude-opus-5-5', provider: 'claude-bridge', cost_per_m: 4 },
  ],
  // sonnet leads on briefcase (1823 vs 1807); opus leads on coding (2007 vs 1909, sonnet 4.9 % behind)
  capability_profiles: {
    'claude-sonnet-5-5': { briefcase: 1823, coding: 1909 },
    'claude-opus-5-5': { briefcase: 1807, coding: 2007 },
  },
} as unknown as Cache;

describe('getTopModels — ranking reasons in best groups', () => {
  let router: Router;
  beforeAll(() => {
    metricsModule.setConfig(cfg);
    metricsModule.setCache(cache);
    metricsModule.setModelRegistry({ find: () => undefined } as any);
    router = new Router(cfg, cache, new Map());
  });

  it('planning: sonnet first on the higher briefcase score, opus shows its gap', () => {
    const { models } = router.getTopModels('planning', 5);
    expect(models.map((m) => [m.ref, m.why])).toEqual([
      ['claude-bridge/claude-sonnet-5-5', 'top score'],
      ['claude-bridge/claude-opus-5-5', '−0.9% score'],
    ]);
  });

  it('code_complex: sonnet first although opus scores higher, because it is cheaper in the window', () => {
    const { models } = router.getTopModels('code_complex', 5);
    expect(models.map((m) => [m.ref, m.why])).toEqual([
      ['claude-bridge/claude-sonnet-5-5', '−4.9% score, in window, cheaper'],
      ['claude-bridge/claude-opus-5-5', 'top score'],
    ]);
  });

  it('tiered groups carry no reason', () => {
    const { models } = router.getTopModels('standard', 5);
    expect(models.every((m) => m.why === undefined)).toBe(true);
  });
});
