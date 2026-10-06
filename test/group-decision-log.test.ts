// test/group-decision-log.test.ts
// Phase 0 step 1 of docs/plans/2026-10-05-task-type-balancing.md: the LIVE
// group decision must be observable. Evidence 5 of the plan (simulation
// picks claude-sonnet-5 in tactical, live routing picks zai-glm-5-3) could
// not be explained because resolveGroup never logged its candidate ranking
// nor why a model was dropped. This pins a debug-level line per group
// decision: group, method, ordered candidates with gdpval / effCost / score
// and their health/cooldown flags, plus every excluded ref with the gate
// that dropped it.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/logger.js', async (orig) => {
  const actual = await orig<typeof import('../src/logger.js')>();
  return { ...actual, debugLogOnce: vi.fn(), isDebugEnabled: vi.fn(() => true) };
});

import * as loggerModule from '../src/logger.js';
import { Router, applyGroupFilters } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import { recordModelFailure } from '../src/model-health.js';
import type { Config, Cache, RateLimit } from '../src/types.js';

const mockDebugOnce = vi.mocked(loggerModule.debugLogOnce);
const mockDebugEnabled = vi.mocked(loggerModule.isDebugEnabled);

const REFS = [
  'claude-bridge/claude-opus-5-5',
  'claude-bridge/claude-sonnet-5-5',
  'mistral/zai-glm-5-3',
  'mistral/mistral-medium-3.5',
  'mistral/unscored-thing',
];

const cfg: Config = {
  model_groups: {
    tactical: { method: 'best', min_gdpval: 900, max_gdpval: 1700, fallback_groups: [] },
  },
  model_metrics: {
    'claude-bridge/claude-opus-5-5': { cost_per_m: 1.5e-6, gdpval: 1900, throughput_tps: 100, avg_latency_ms: 1000 },
    'claude-bridge/claude-sonnet-5-5': { cost_per_m: 1.5e-6, gdpval: 1844, throughput_tps: 100, avg_latency_ms: 1000 },
    'mistral/zai-glm-5-3': { cost_per_m: 1.4, gdpval: 1644, throughput_tps: 60, avg_latency_ms: 1200 },
    'mistral/mistral-medium-3.5': { gdpval: 933, throughput_tps: 80, avg_latency_ms: 900 },
  },
  providers: {},
  gdpval_builtin: {
    'claude-opus-5-5': 1900,
    'claude-sonnet-5-5': 1844,
    'zai-glm-5-3': 1644,
    'mistral-medium-3.5': 933,
  },
  best_quality_window: 0.05,
} as any;

let cache: Cache;

beforeEach(() => {
  mockDebugOnce.mockClear();
  mockDebugEnabled.mockReturnValue(true);
  cache = {
    available_models: REFS.map((r) => ({ provider: r.split('/')[0], id: r.slice(r.indexOf('/') + 1) })),
  } as any;
  metricsModule.setConfig(cfg);
  metricsModule.setCache(cache);
  metricsModule.setModelRegistry({ find: () => undefined } as any);
});

function decisionLine(): string {
  const call = mockDebugOnce.mock.calls.find(([key]) => key === 'group-decision:tactical');
  expect(call, 'resolve() must log the tactical group decision').toBeDefined();
  return call![1];
}

describe('group decision debug log (Phase 0 step 1)', () => {
  it('logs group, method and the ordered candidates with gdpval and effCost', () => {
    const router = new Router(cfg, cache, new Map());
    const res = router.resolve('tactical');
    expect(res?.selected).toBe('mistral/zai-glm-5-3');

    const line = decisionLine();
    expect(line).toContain('group=tactical');
    expect(line).toContain('method=best');
    expect(line).toContain('mistral/zai-glm-5-3 gdp=1644 cost=1.4');
    expect(line).toContain('mistral/mistral-medium-3.5 gdp=933 cost=unknown');
    // Candidate order in the line follows the live ranking.
    expect(line.indexOf('1. mistral/zai-glm-5-3')).toBeGreaterThan(-1);
    expect(line.indexOf('2. mistral/mistral-medium-3.5')).toBeGreaterThan(line.indexOf('1. mistral/zai-glm-5-3'));
  });

  it('names the gate that excluded each dropped ref', () => {
    const router = new Router(cfg, cache, new Map());
    router.resolve('tactical');
    const line = decisionLine();
    expect(line).toContain('excluded:');
    expect(line).toContain('claude-bridge/claude-opus-5-5=max_gdpval');
    expect(line).toContain('claude-bridge/claude-sonnet-5-5=max_gdpval');
    expect(line).toContain('mistral/unscored-thing=min_gdpval');
  });

  it('flags unhealthy and rate-limited candidates', () => {
    recordModelFailure(cache, 'mistral/zai-glm-5-3');
    recordModelFailure(cache, 'mistral/zai-glm-5-3');
    const limits = new Map<string, RateLimit>([
      ['mistral/mistral-medium-3.5', { cooldown_until: Date.now() + 60_000, backoff_ms: 1000, hits: 1 }],
    ]);
    const router = new Router(cfg, cache, limits);
    router.resolve('tactical');
    const line = decisionLine();
    expect(line).toMatch(/mistral\/zai-glm-5-3 [^|]*\[unhealthy\]/);
    expect(line).toMatch(/mistral\/mistral-medium-3\.5 [^|]*\[limited\]/);
  });

  it('does not build the line when debug logging is off', () => {
    mockDebugEnabled.mockReturnValue(false);
    const router = new Router(cfg, cache, new Map());
    router.resolve('tactical');
    expect(mockDebugOnce).not.toHaveBeenCalled();
  });
});

describe('applyGroupFilters drop recorder', () => {
  it('reports each dropped ref with its gate and leaves the result unchanged', () => {
    const drops: Array<[string, string]> = [];
    const withRecorder = applyGroupFilters(REFS, cfg.model_groups!.tactical, cfg, false, undefined, undefined,
      (ref, reason) => drops.push([ref, reason]));
    const without = applyGroupFilters(REFS, cfg.model_groups!.tactical, cfg);
    expect(withRecorder).toEqual(without);
    expect(drops).toEqual(expect.arrayContaining([
      ['claude-bridge/claude-opus-5-5', 'max_gdpval'],
      ['claude-bridge/claude-sonnet-5-5', 'max_gdpval'],
      ['mistral/unscored-thing', 'min_gdpval'],
    ]));
    expect(drops).toHaveLength(3);
  });
});
