// test/routing-n12-pins.test.ts — nightly N12 round (2026-11-22/24), routing.ts.
// Pins the three observable behaviors the full-suite recheck left surviving
// after the existing tests ran (see docs/mutation-triage.md, "Nightly N12
// — routing.ts remainders"):
//
//   turn boundary  — noteTurnStart ignores a non-number (typeof guard, id 388)
//   auth reach     — a registry without a runtime handle fails open, so the
//                    configured free_models still count (id 482)
//   explanation    — a candidate without a capability profile in a
//                    capability-scored group reads "no profile, by GDPval"
//                    (isProfiled, id 1123)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as m from '../src/metrics.ts';
import { Router } from '../src/routing.ts';
import type { Config, Cache } from '../src/types.ts';

const mkRouter = () =>
  new Router(
    { model_groups: {}, model_metrics: {}, providers: {} } as Config,
    {} as never,
    new Map() as never
  );

describe('Router turn boundary — a non-number turn start is ignored (388)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a string turn start does not move the boundary, so the pin stays on the first ref', () => {
    const r = mkRouter();
    r.setCurModel('prov/a'); // pinned at t=5000
    r.noteTurnStart('9000' as unknown as number);
    r.setCurModel('prov/b');
    expect(r.getTurnDriverRef()).toBe('prov/a');
  });
});

describe('allDiscoveredRefs — a registry without a runtime handle fails open (482)', () => {
  const cfg = {
    model_groups: {},
    model_metrics: {},
    providers: { zz: { free_models: ['zz/free-one'] } },
  } as unknown as Config;
  const cache = { available_models: [] } as unknown as Cache;

  beforeEach(() => {
    m.setConfig(cfg);
    m.setCache(cache);
    m.setModelRegistry({ find: () => undefined } as any);
  });

  it('a session registry without runtime does not throw and keeps the configured free model', () => {
    const r = new Router(cfg, cache, new Map());
    r.setSessionCtx({ modelRegistry: { getAvailable: () => [] } } as any);
    expect(() => r.allDiscoveredRefs()).not.toThrow();
    expect(r.allDiscoveredRefs()).toContain('zz/free-one');
  });

  it('a runtime that denies the provider drops its free models (the auth gate itself)', () => {
    const r = new Router(cfg, cache, new Map());
    r.setSessionCtx({
      modelRegistry: { getAvailable: () => [], runtime: { hasConfiguredAuth: () => false } },
    } as any);
    expect(r.allDiscoveredRefs()).not.toContain('zz/free-one');
  });
});

describe('getTopModels — an unprofiled candidate in a capability group (1123)', () => {
  it('reads "no profile, by GDPval", not a score, when its column has no profile', () => {
    const cfg = {
      model_groups: {
        coding: { method: 'best', score_by: 'coding', fallback_groups: [] },
      },
      model_metrics: {
        'zz/steady': { cost_per_m: 2 },
        'zz/bare': { cost_per_m: 2 },
      },
      providers: { zz: { billing: 'pay_per_token' } },
      gdpval_builtin: { steady: 1900, bare: 1500 },
    } as unknown as Config;
    const cache = {
      available_models: [
        { provider: 'zz', id: 'steady', cost_per_m: 2 },
        { provider: 'zz', id: 'bare', cost_per_m: 2 },
      ],
      // Profiles are keyed by model id: only 'steady' has a coding score.
      capability_profiles: { steady: { coding: 90 } },
    } as unknown as Cache;
    m.setConfig(cfg);
    m.setCache(cache);
    m.setGdpval({});
    m.setMetrics({});
    m.setModelRegistry({ find: () => undefined } as any);
    const { models } = new Router(cfg, cache, new Map()).getTopModels('coding', 5);
    const bare = models.find((x) => x.ref === 'zz/bare')!;
    expect(bare.why).toBe('no profile, by GDPval');
  });
});
