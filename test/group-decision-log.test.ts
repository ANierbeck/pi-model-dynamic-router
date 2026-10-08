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
import { resetBudgetPacingMemo } from '../src/budget-pacing.js';
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

// Nightly R1 triage (2026-10-07): the assertions above are all `toContain`,
// so extra, missing, mislabeled or constant fragments of the line passed.
// These pin its exact shape: separators, the "(none)" placeholders, flags
// only where they apply, score= only for `best`, and the two late drop
// reasons (budget, top_k).
describe('group decision debug log — exact shape (nightly R1)', () => {
  const lineFor = (group: string) => {
    const call = mockDebugOnce.mock.calls.find(([key]) => key === `group-decision:${group}`);
    expect(call, `resolve() must log the ${group} group decision`).toBeDefined();
    return call![1] as string;
  };

  const withGroups = (groups: Record<string, any>, c: Cache = cache) => {
    const config = { ...cfg, model_groups: groups } as Config;
    metricsModule.setConfig(config);
    return new Router(config, c, new Map());
  };

  it('a clean decision lists no exclusions, no flags, and separates fields exactly', () => {
    const router = withGroups({ open: { method: 'best', fallback_groups: [] } });
    router.resolve('open');
    const line = lineFor('open');
    expect(line.startsWith('[routing] group=open method=best candidates: 1. ')).toBe(true);
    expect(line).toContain(' | 2. ');
    expect(line.endsWith(' || excluded: (none)')).toBe(true);
    expect(line).not.toContain('[unhealthy]');
    expect(line).not.toContain('[limited]');
  });

  it('score= is logged for best groups only', () => {
    const router = withGroups({
      b: { method: 'best', fallback_groups: [] },
      m: { method: 'min_cost', fallback_groups: [] },
    });
    router.resolve('b');
    router.resolve('m');
    expect(lineFor('b')).toMatch(/gdp=\d+ cost=\S+ score=\d+/);
    expect(lineFor('m')).not.toContain('score=');
  });

  it('an empty result logs (none) candidates and the drops', () => {
    const router = withGroups({ dead: { method: 'best', min_gdpval: 99999, fallback_groups: [] } });
    expect(router.resolve('dead')).toBeNull();
    const line = lineFor('dead');
    expect(line).toContain('candidates: (none) || excluded: ');
    expect(line).toContain('claude-bridge/claude-opus-5-5=min_gdpval');
  });

  it('top_k truncation is reported as the gate that dropped the cut refs, and only those', () => {
    const router = withGroups({ cut: { method: 'min_cost', top_k: 1, min_gdpval: 900, max_gdpval: 1700, fallback_groups: [] } });
    const res = router.resolve('cut');
    const line = lineFor('cut');
    expect(res!.candidates).toHaveLength(1);
    expect(line).toContain('mistral/mistral-medium-3.5=top_k');
    expect(line).not.toContain(`${res!.selected}=top_k`);
  });

  it('a subscription provider with an exhausted budget is reported as dropped by the budget gate', () => {
    const budgetCache = {
      ...cache,
      budget_cache: { 'claude-bridge': { remaining_tokens: 0 } },
    } as Cache;
    metricsModule.setCache(budgetCache);
    const config = {
      ...cfg,
      model_groups: { wide: { method: 'best', fallback_groups: [] } },
      providers: { 'claude-bridge': { billing: 'subscription' } },
    } as Config;
    metricsModule.setConfig(config);
    new Router(config, budgetCache, new Map()).resolve('wide');
    const line = lineFor('wide');
    expect(line).toContain('claude-bridge/claude-opus-5-5=budget');
    expect(line).toContain('claude-bridge/claude-sonnet-5-5=budget');
    expect(line).not.toContain('mistral/zai-glm-5-3=budget');
  });

  it('an unscored candidate is logged as gdp=none; exclusions are comma-separated', () => {
    const router = withGroups({ wide: { method: 'best', fallback_groups: [] } });
    router.resolve('wide');
    expect(lineFor('wide')).toContain('mistral/unscored-thing gdp=none');
    // two gates drop refs in the tactical decision → "ref=gate, ref=gate"
    new Router(cfg, cache, new Map()).resolve('tactical');
    expect(decisionLine()).toMatch(/=\w+, \S+=\w+/);
  });

  it('the score= shown for a best group follows its score_by column', () => {
    const profiled = { ...cache, capability_profiles: { 'zai-glm-5-3': { briefcase: 777 } } } as Cache;
    metricsModule.setCache(profiled);
    const config = { ...cfg, model_groups: { col: { method: 'best', score_by: 'briefcase', fallback_groups: [] } } } as Config;
    metricsModule.setConfig(config);
    new Router(config, profiled, new Map()).resolve('col');
    expect(lineFor('col')).toContain('mistral/zai-glm-5-3 gdp=1644 cost=1.4 score=777');
  });

  it('a budget drop with debug logging OFF neither throws nor logs', () => {
    mockDebugEnabled.mockReturnValue(false);
    const budgetCache = { ...cache, budget_cache: { 'claude-bridge': { remaining_tokens: 0 } } } as Cache;
    metricsModule.setCache(budgetCache);
    const config = {
      ...cfg,
      model_groups: { wide: { method: 'best', fallback_groups: [] } },
      providers: { 'claude-bridge': { billing: 'subscription' } },
    } as Config;
    metricsModule.setConfig(config);
    const router = new Router(config, budgetCache, new Map());
    expect(() => router.resolve('wide')).not.toThrow();
    expect(mockDebugOnce).not.toHaveBeenCalled();
  });

  it('a provider ahead of its budget pace is flagged [paced] and ranked last; on-pace ones are not', () => {
    // The live pacing effect (paceDemote) is only observable through this
    // line. Nightly R2 (2026-10-08): the [paced] marker had no test at all —
    // forcing it on, off, keying it on the wrong ref part or blanking it all
    // survived (routing.ts formatGroupDecision, ids 1603-1606). The paced
    // provider is the one that ranks FIRST without pacing, so the order
    // assertion below fails if the demotion does not happen.
    resetBudgetPacingMemo();
    const pacedCache = {
      ...cache,
      usage_log: [{ ref: 'claude-bridge/claude-opus-5-5', tokens: 1e9, ts: Date.now() }],
    } as Cache;
    metricsModule.setCache(pacedCache);
    const config = {
      ...cfg,
      model_groups: { open: { method: 'best', fallback_groups: [] } },
      providers: {
        'claude-bridge': { billing: 'pay_per_token', budget: { amount: 1000, unit: 'tokens', period: 'month', reset_day: 1 } },
      },
    } as Config;
    metricsModule.setConfig(config);
    new Router(config, pacedCache, new Map()).resolve('open');
    const line = lineFor('open');
    expect(line).toMatch(/claude-bridge\/claude-opus-5-5 [^|]*\[paced\]/);
    expect(line).toMatch(/claude-bridge\/claude-sonnet-5-5 [^|]*\[paced\]/);
    expect(line).not.toMatch(/mistral\/zai-glm-5-3 [^|]*\[paced\]/);
    expect(line).not.toMatch(/mistral\/mistral-medium-3\.5 [^|]*\[paced\]/);
    // Rank penalty, not exclusion: the paced provider's refs trail every
    // on-pace candidate but stay in the list.
    const order = [...line.matchAll(/\d+\. (\S+)/g)].map((m) => m[1].split('/')[0]);
    expect(order).toContain('claude-bridge');
    expect(order.indexOf('claude-bridge')).toBeGreaterThan(order.lastIndexOf('mistral'));
    resetBudgetPacingMemo();
  });
});

