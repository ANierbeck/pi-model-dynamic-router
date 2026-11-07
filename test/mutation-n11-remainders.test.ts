// test/mutation-n11-remainders.test.ts — nightly triage round N11 (2026-11-08),
// metrics.ts / routing.ts remainders. Fresh nightly (GitHub run 42362620882)
// left 148 undetected mutants in the two files; 89 were already ledgered
// EQUIVALENT, the rest was rechecked against the full suite (10 killed by
// existing tests, 49 real survivors). The survivors split into the pins
// below and the equivalents added to the ledger (docs/mutation-triage.md,
// "Nightly N11"). Grouped by the behavior each block protects:
//
//   metrics   — registry context-window fall-through, null capability profile
//               entries, provenance mirror kept when a cache omits it,
//               model_metrics-less configs, EWMA blending from the 2nd stream on
//   routing   — min_score 0 means "no floor", min_gdpval_pct without any
//               scored model, health-aware fallback cascade, the lazy `pool`
//               property shape, every field of the decision-time pool record,
//               detectGroup's last unrestricted tier, the `why` column of a
//               plain GDPval `best` group

import { describe, it, expect, beforeEach } from 'vitest';
import * as m from '../src/metrics.ts';
import { Router, applyGroupFilters } from '../src/routing.ts';
import { recordModelFailure } from '../src/model-health.ts';
import { resetBudgetPacingMemo } from '../src/budget-pacing.ts';
import type { Config, Cache, RateLimit } from '../src/types.ts';

const refOf = (provider: string, id: string): string => `${provider}/${id}`;

function boot(cfg: Partial<Config>, cache: Partial<Cache> = {}) {
  const config = { model_groups: {}, model_metrics: {}, providers: {}, ...cfg } as any as Config;
  const c = { available_models: [], ...cache } as any as Cache;
  m.setConfig(config);
  m.setCache(c);
  m.setGdpval({});
  m.setMetrics({});
  m.setModelMap({}, []);
  m.setModelRegistry({ find: () => undefined } as any);
  return { config, cache: c };
}

// ── metrics.ts ─────────────────────────────────────────────────────────────

describe('lookupContextWindow — registry value must be a positive number', () => {
  const discovered = [{ provider: 'zz', id: 'cw', capabilities: { contextWindow: 5000 } }] as any;

  it('a registry model without a contextWindow falls through to the scanned capability', () => {
    boot({}, { available_models: discovered });
    m.setModelRegistry({ find: () => ({ id: 'cw' }) } as any);
    expect(m.lookupContextWindow('zz/cw')).toBe(5000);
  });

  it('a registry contextWindow of 0 is not an answer either', () => {
    boot({}, { available_models: discovered });
    m.setModelRegistry({ find: () => ({ contextWindow: 0 }) } as any);
    expect(m.lookupContextWindow('zz/cw')).toBe(5000);
  });

  it('a positive registry contextWindow wins over the scan', () => {
    boot({}, { available_models: discovered });
    m.setModelRegistry({ find: () => ({ contextWindow: 128000 }) } as any);
    expect(m.lookupContextWindow('zz/cw')).toBe(128000);
  });
});

describe('setCache — capability profiles and provenance mirrors', () => {
  it('a null profile entry in a corrupt cache is skipped, not a TypeError', () => {
    boot({});
    expect(() =>
      m.setCache({
        available_models: [],
        capability_profiles: { broken: null, ok: { coding: 5 } },
      } as any)
    ).not.toThrow();
  });

  it('a cache without gdpval_provenance leaves the existing mirror untouched', () => {
    boot({});
    m.setGdpval({ 'apodex-1-1': 1190.82 });
    m.setCache({
      gdpval_provenance: { 'apodex-1-1': { creator: 'Apodex', displayName: 'Apodex 1.1' } },
    } as any);
    expect(m.lookupProvenance('openrouter/apodex/apodex-1.1:free')).toEqual({
      creator: 'Apodex',
      displayName: 'Apodex 1.1',
    });
    m.setCache({ available_models: [] } as any); // field absent: no replace
    expect(m.lookupProvenance('openrouter/apodex/apodex-1.1:free')).toEqual({
      creator: 'Apodex',
      displayName: 'Apodex 1.1',
    });
  });
});

describe('updateMetrics — configless priors and EWMA from the second stream', () => {
  it('a config without a model_metrics block does not crash the update', () => {
    const { config } = boot({});
    delete (config as any).model_metrics;
    expect(() => m.updateMetrics('zz/u', 500, 100, 1000)).not.toThrow();
    expect(m.getM('zz/u').avg_latency_ms).toBe(500);
  });

  it('the second stream blends into the first measurement (alpha 0.3), it does not re-initialize', () => {
    boot({});
    m.updateMetrics('zz/u', 500, 200, 1000); // 500 ms, 200 tok/s — initializes
    m.updateMetrics('zz/u', 1000, 100, 1000); // 1000 ms, 100 tok/s — blends
    const met = m.getM('zz/u');
    expect(met.avg_latency_ms).toBeCloseTo(500 * 0.7 + 1000 * 0.3, 6);
    expect(met.throughput_tps).toBeCloseTo(200 * 0.7 + 100 * 0.3, 6);
  });
});

// ── routing.ts: group filters ──────────────────────────────────────────────

describe('applyGroupFilters — degenerate gate values', () => {
  it('min_score 0 is no floor: an unprofiled model stays (a null value only fails a POSITIVE floor)', () => {
    const cfg = boot(
      {
        model_groups: {},
        gdpval_builtin: { 'prof-a': 1900, 'prof-b': 1800 },
      },
      {
        available_models: [
          { provider: 'zz', id: 'prof-a' },
          { provider: 'zz', id: 'prof-b' },
        ] as any,
        capability_profiles: { 'prof-a': { reasoning: 50 } },
      }
    ).config;
    const g = { method: 'best', score_by: 'reasoning', min_score: 0 } as any;
    expect(applyGroupFilters(['zz/prof-a', 'zz/prof-b'], g, cfg)).toEqual([
      'zz/prof-a',
      'zz/prof-b',
    ]);
  });

  it('min_gdpval_pct with no scored model at all gates nothing (empty max is not a -Infinity threshold)', () => {
    const cfg = boot({}, { available_models: [] }).config;
    const g = { method: 'best', min_gdpval_pct: 50 } as any;
    expect(applyGroupFilters(['zq/nobody-1', 'zq/nobody-2'], g, cfg)).toEqual([
      'zq/nobody-1',
      'zq/nobody-2',
    ]);
  });
});

// ── routing.ts: cascade, pool, display ─────────────────────────────────────

describe('Router.resolve — health-aware fallback cascade', () => {
  const cfg = {
    model_groups: {
      prim: { method: 'best', min_gdpval: 1800, fallback_groups: ['fb1', 'fb2'] },
      fb1: { method: 'best', min_gdpval: 1500, max_gdpval: 1700, fallback_groups: [] },
      fb2: { method: 'best', max_gdpval: 1400, fallback_groups: [] },
      empty: { method: 'best', min_gdpval: 9999, fallback_groups: ['fb1'] },
    },
    model_metrics: {},
    providers: {},
    gdpval_builtin: { aaa: 1900, bbb: 1600, ccc: 1300 },
  } as any as Config;
  let cache: Cache;

  beforeEach(() => {
    cache = {
      available_models: ['aaa', 'bbb', 'ccc'].map((id) => ({ provider: 'p', id })),
    } as any;
    m.setConfig(cfg);
    m.setCache(cache);
    m.setModelRegistry({ find: () => undefined } as any);
  });

  const fail = (ref: string) => {
    recordModelFailure(cache, ref);
    recordModelFailure(cache, ref);
  };

  it('an unhealthy primary skips an unhealthy first fallback and lands on the first HEALTHY group', () => {
    fail('p/aaa');
    fail('p/bbb');
    expect(new Router(cfg, cache, new Map()).resolve('prim')?.selected).toBe('p/ccc');
  });

  it('an unhealthy primary with a healthy first fallback hands over to it', () => {
    fail('p/aaa');
    expect(new Router(cfg, cache, new Map()).resolve('prim')?.selected).toBe('p/bbb');
  });

  it('an EMPTY primary takes the first non-empty fallback even when that one is unhealthy', () => {
    fail('p/bbb');
    expect(new Router(cfg, cache, new Map()).resolve('empty')?.selected).toBe('p/bbb');
  });
});

describe('Router.resolve — the decision-time pool', () => {
  const NOW = Date.now();
  const cfg = {
    model_groups: {
      bestg: { method: 'best', fallback_groups: [] },
      plain: { method: 'max_gdpval', fallback_groups: [] },
      coding: { method: 'best', score_by: 'coding', fallback_groups: [] },
    },
    model_metrics: {
      'paceful/one': { cost_per_m: 10, gdpval: 1900 },
      'steady/two': { cost_per_m: 10, gdpval: 1800 },
      'limp/three': { cost_per_m: 10, gdpval: 1700 },
      // 'mystery/four' has no cost: effCost 'unknown'
    },
    providers: {
      paceful: {
        billing: 'pay_per_token',
        budget: { amount: 1000, unit: 'tokens', period: 'month', reset_day: 1 },
      },
      steady: { billing: 'pay_per_token' },
      limp: { billing: 'pay_per_token' },
      mystery: { billing: 'pay_per_token' },
    },
    gdpval_builtin: { one: 1900, two: 1800, three: 1700, four: 1600 },
  } as any as Config;

  const limits = new Map<string, RateLimit>([
    ['limp/three', { cooldown_until: NOW + 60_000, backoff_ms: 1000, hits: 1 }],
  ]);

  let cache: Cache;
  let router: Router;

  beforeEach(() => {
    resetBudgetPacingMemo();
    cache = {
      available_models: [
        { provider: 'paceful', id: 'one', cost_per_m: 10 },
        { provider: 'steady', id: 'two', cost_per_m: 10 },
        { provider: 'limp', id: 'three', cost_per_m: 10 },
        { provider: 'mystery', id: 'four' },
      ],
      usage_log: [{ ref: 'paceful/one', tokens: 1e9, ts: NOW }],
      capability_profiles: {
        one: { coding: 10 },
        two: { coding: 90 },
        three: { coding: 50 },
        four: { coding: 30 },
      },
    } as any;
    m.setConfig(cfg);
    m.setCache(cache);
    m.setModelRegistry({ find: () => undefined } as any);
    router = new Router(cfg, cache, limits);
  });

  const entry = (group: string, ref: string) =>
    router.resolve(group)!.pool!.candidates.find((c) => c.ref === ref)!;

  it('flags a provider ahead of its budget pace as paced (and only that provider)', () => {
    expect(entry('bestg', refOf('paceful', 'one')).flags).toEqual(['paced']);
    expect(entry('bestg', refOf('steady', 'two')).flags).toEqual([]);
  });

  it('flags a rate-limited candidate as limited', () => {
    expect(entry('bestg', refOf('limp', 'three')).flags).toEqual(['limited']);
  });

  it('an unknown price is recorded as null, not as the string "unknown"', () => {
    expect(entry('bestg', refOf('mystery', 'four')).cost).toBeNull();
    expect(entry('bestg', refOf('steady', 'two')).cost).toBe(10);
  });

  it('only best groups carry a score; other methods leave the key out', () => {
    expect('score' in entry('bestg', refOf('steady', 'two'))).toBe(true);
    expect('score' in entry('plain', refOf('steady', 'two'))).toBe(false);
  });

  it("the score follows the group's own score_by column, not GDPval", () => {
    expect(entry('coding', refOf('steady', 'two')).score).toBe(90);
    expect(entry('coding', refOf('limp', 'three')).score).toBe(50);
  });

  it('the pool property is enumerable and configurable (survives a spread, can be redefined)', () => {
    const r = router.resolve('bestg')!;
    const desc = Object.getOwnPropertyDescriptor(r, 'pool')!;
    expect(desc.enumerable).toBe(true);
    expect(desc.configurable).toBe(true);
    expect(Object.keys({ ...r })).toContain('pool');
  });
});

describe('detectGroup — fallback list reaches the design tier', () => {
  it('with only an unrestricted design group, an unscored ref lands there', () => {
    const cfg = { model_groups: { design: { method: 'best' } } } as any as Config;
    const cache = { available_models: [] } as any as Cache;
    m.setConfig(cfg);
    m.setCache(cache);
    expect(new Router(cfg, cache, new Map()).detectGroup('zzq/qq-999')).toBe('design');
  });
});

describe('getTopModels — a plain GDPval best group still explains its ranking', () => {
  it('no score_by: the leader reads "top score", not "no profile"', () => {
    const cfg = {
      model_groups: { plain: { method: 'best', fallback_groups: [] } },
      model_metrics: {
        'zz/lead': { cost_per_m: 2 },
        'zz/trail': { cost_per_m: 2 },
      },
      providers: { zz: { billing: 'pay_per_token' } },
      gdpval_builtin: { lead: 1900, trail: 1500 },
    } as any as Config;
    const cache = {
      available_models: [
        { provider: 'zz', id: 'lead', cost_per_m: 2 },
        { provider: 'zz', id: 'trail', cost_per_m: 2 },
      ],
    } as any as Cache;
    m.setConfig(cfg);
    m.setCache(cache);
    m.setModelRegistry({ find: () => undefined } as any);
    const { models } = new Router(cfg, cache, new Map()).getTopModels('plain', 5);
    expect(models[0]!.ref).toBe('zz/lead');
    expect(models[0]!.why).toBe('top score');
    expect(models[1]!.why).not.toBe('no profile, by GDPval');
  });
});
