// In a `best` group that ranks by a capability column (score_by 'briefcase' or
// 'coding'), a model WITHOUT a profile value used to be scored with its GDPval
// instead. That mixes two scales in one ranking: the coding column runs 130-250
// points above GDPval for the same model, so an unprofiled model could outrank
// profiled ones it has no measured evidence against. Owner decision 2026-10-26:
// unprofiled models rank AFTER every profiled one ("they are evidently not
// that good for coding"); among themselves they keep the GDPval order.
//
// calculateScore itself keeps its documented fallback (aa-capability-sourcing
// pins it); only the ranking in sortBy('best') changes.

import { describe, it, expect, beforeAll } from 'vitest';
import { Router as RoutingRouter } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';

const CONFIG = {
  model_groups: {
    tactical: { method: 'best', min_gdpval: 600, max_gdpval: 1700, score_by: 'coding', fallback_groups: [] },
    planning: { method: 'best', min_gdpval: 1700, score_by: 'briefcase', fallback_groups: [] },
  },
  model_metrics: {
    'mistral/mistral-medium-3.5': { cost_per_m: 0.4, throughput_tps: 80, avg_latency_ms: 900 },
    'mistral/zai-glm-5-3': { cost_per_m: 1.4, throughput_tps: 60, avg_latency_ms: 1200 },
    'mistral/glm-5-2': { cost_per_m: 1.4, throughput_tps: 60, avg_latency_ms: 1200 },
    'claude-bridge/claude-sonnet-5-5': { cost_per_m: 2.0e-6, throughput_tps: 100, avg_latency_ms: 1000 },
    'claude-bridge/claude-opus-5-5': { cost_per_m: 1.5e-6, throughput_tps: 100, avg_latency_ms: 1000 },
  },
  providers: {},
  gdpval_builtin: {
    'mistral-medium-3.5': 933,
    'zai-glm-5-3': 1644,
    'glm-5-2': 1371,
    'claude-sonnet-5-5': 1844,
    'claude-opus-5-5': 1900,
  },
  best_quality_window: 0.05,
} as any;

// Only medium has a coding value, and a LOW one: below glm's GDPval (1644).
// Only sonnet has a briefcase value, below opus's GDPval (1900).
const PROFILES = {
  'mistral-medium-3.5': { coding: 1200 },
  'claude-sonnet-5-5': { briefcase: 1500 },
};

describe("sortBy('best') with a capability column: unprofiled models rank last", () => {
  let router: any;
  beforeAll(() => {
    metricsModule.setConfig(CONFIG);
    metricsModule.setCache({ available_models: [], capability_profiles: PROFILES } as any);
    metricsModule.setModelRegistry({ find: () => undefined } as any);
    router = new RoutingRouter(CONFIG, { available_models: [], capability_profiles: PROFILES } as any, new Map());
  });

  it("coding: a profiled model beats an unprofiled one whose GDPval is numerically higher", () => {
    const sorted = router.sortBy(['mistral/zai-glm-5-3', 'mistral/mistral-medium-3.5'], 'best', 'coding');
    expect(sorted).toEqual(['mistral/mistral-medium-3.5', 'mistral/zai-glm-5-3']);
  });

  it('briefcase: the same rule for the planning column', () => {
    const sorted = router.sortBy(['claude-bridge/claude-opus-5-5', 'claude-bridge/claude-sonnet-5-5'], 'best', 'briefcase');
    expect(sorted).toEqual(['claude-bridge/claude-sonnet-5-5', 'claude-bridge/claude-opus-5-5']);
  });

  it('unprofiled models keep the GDPval order among themselves, behind the profiled ones', () => {
    const sorted = router.sortBy(
      ['mistral/glm-5-2', 'mistral/zai-glm-5-3', 'mistral/mistral-medium-3.5'],
      'best',
      'coding',
    );
    expect(sorted).toEqual(['mistral/mistral-medium-3.5', 'mistral/zai-glm-5-3', 'mistral/glm-5-2']);
  });

  it('when no candidate has a profile the order is the plain GDPval order (nothing to demote)', () => {
    const sorted = router.sortBy(['mistral/glm-5-2', 'mistral/zai-glm-5-3'], 'best', 'coding');
    expect(sorted).toEqual(['mistral/zai-glm-5-3', 'mistral/glm-5-2']);
  });

  it('without a column (score_by absent / gdpval) nothing changes: pure GDPval ordering', () => {
    const sorted = router.sortBy(['mistral/mistral-medium-3.5', 'mistral/zai-glm-5-3'], 'best', 'gdpval');
    expect(sorted[0]).toBe('mistral/zai-glm-5-3');
  });

  it('resolve() applies it end to end for a coding group (tactical)', () => {
    const cache = {
      available_models: [
        { provider: 'mistral', id: 'zai-glm-5-3' },
        { provider: 'mistral', id: 'mistral-medium-3.5' },
      ] as any,
      capability_profiles: PROFILES,
    } as any;
    const r = new RoutingRouter(CONFIG, cache, new Map());
    const res = r.resolve('tactical');
    expect(res?.candidates?.slice(0, 2)).toEqual(['mistral/mistral-medium-3.5', 'mistral/zai-glm-5-3']);
  });

  it('calculateScore keeps its documented gdpval fallback (the unit contract is unchanged)', () => {
    expect(metricsModule.calculateScore('mistral/zai-glm-5-3', 'coding')).toBe(1644);
  });
});
