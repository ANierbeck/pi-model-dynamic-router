// test/display-dispatch.test.ts — nightly R1 triage (2026-10-07), routing.ts
// getTopModels (the /router display path), the tiered/best dispatch of both
// display and live resolution, resolve()'s fallback cascade, detectGroup's
// threshold sort and the small Router accessors. The Batch 4 file
// (resolve-group-dispatch.test.ts) pinned the first-candidate of a few
// groups; the nightly showed these were still open:
//
//   - tiered groups order by billing tier then COST (not input order) — in
//     the live resolver AND in the display
//   - display 'best' honors the group's score_by column
//   - display generic methods (max_gdpval) actually sort; dynamic and
//     unknown groups render as empty (never throw, never list models)
//   - the display dedups same-model aliases BEFORE the cost gate (the
//     2026-09-20 honest-twin rule): a capped group that drops the canonical
//     model must not show its cheaper alias instead
//   - limited refs sort to the END of the display exactly once (no
//     duplicates) and carry limited:true; an available sibling represents
//     its slug cluster
//   - roundrobin rotation yields a full permutation, never a duplicated list
//   - resolve() skips unknown fallback groups and keeps cascading past an
//     EMPTY fallback group; dynamic groups resolve to null
//   - detectGroup sorts thresholds descending for any object order
//   - Router.getActiveGroup, a pipeline group without steps

import { describe, it, expect, beforeAll } from 'vitest';
import { Router } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.ts';
import type { Config, Cache, RateLimit } from '../src/types.ts';

const config: Config = {
  model_groups: {
    tieredg: { method: 'tiered' },
    tieredx: { method: 'tiered' },
    bestcol: { method: 'best', score_by: 'briefcase' },
    bygdp: { method: 'max_gdpval' },
    mincost: { method: 'min_cost' },
    dyno: { method: 'dynamic' },
    mcap: { method: 'min_cost_if_all_priced' },
    rr: { method: 'roundrobin' },
    nopipe: { method: 'pipeline' },
    capped: { method: 'best', max_cost: 1 },
    // empty fallback group first, usable one second
    cascade: { method: 'best', min_gdpval: 99999, fallback_groups: ['ghost', 'emptyfb', 'usable'] },
    emptyfb: { method: 'best', min_gdpval: 99999 },
    usable: { method: 'best' },
    // detectGroup thresholds, scrambled object order
    t300: { method: 'best', min_gdpval: 300 },
    t900: { method: 'best', min_gdpval: 900 },
    t100: { method: 'best', min_gdpval: 100 },
    t600: { method: 'best', min_gdpval: 600 },
    t0: { method: 'best' },
  },
  model_metrics: {
    'provx/aaa': { gdpval: 300, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 2 },
    'provx/bbb': { gdpval: 200, throughput_tps: 20, avg_latency_ms: 200, cost_per_m: 1 },
    'provx/ccc': { gdpval: 100, throughput_tps: 30, avg_latency_ms: 300, cost_per_m: 3 },
    // same-model aliases for the dedup-before-gate test
    'provx/dup-3-5': { gdpval: 400, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 5 },
    'provx/dup-latest': { gdpval: 400, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 0.5 },
  },
  providers: { provx: { billing: 'pay_per_token' }, provy: { billing: 'pay_per_token' } },
} as any;

// aaa/bbb/ccc rank in REVERSE order on the briefcase column vs GDPval.
const cache: Cache = {
  available_models: [
    { id: 'aaa', provider: 'provx', cost_per_m: 2 },
    { id: 'bbb', provider: 'provx', cost_per_m: 1 },
    { id: 'ccc', provider: 'provx', cost_per_m: 3 },
  ],
  capability_profiles: {
    'slug-aaa': { briefcase: 100 },
    'slug-bbb': { briefcase: 500 },
    'slug-ccc': { briefcase: 900 },
  },
} as any;

const refs = (top: { models: { ref: string }[] }) => top.models.map((m) => m.ref);

beforeAll(() => {
  metricsModule.setConfig(config);
  metricsModule.setCache(cache);
  metricsModule.setGdpval({ 'slug-aaa': 300, 'slug-bbb': 200, 'slug-ccc': 100, 'dup-3-5': 400 });
  metricsModule.setModelMap(
    {
      aaa: 'slug-aaa',
      bbb: 'slug-bbb',
      ccc: 'slug-ccc',
      'dup-3-5': 'dup-3-5',
      'dup-latest': 'dup-3-5',
    },
    [],
  );
  metricsModule.setModelRegistry({ find: () => undefined } as any);
});

const mk = (c: Cache = cache, limits: Map<string, RateLimit> = new Map(), cfg: Config = config) => new Router(cfg, c, limits);

describe('tiered groups — billing tier, then cost (never the input order)', () => {
  it('live resolution orders by cost inside the payg tier', () => {
    expect(mk().resolve('tieredg')!.candidates).toEqual(['provx/bbb', 'provx/aaa', 'provx/ccc']);
  });

  it('the display shows the same order', () => {
    expect(refs(mk().getTopModels('tieredg', 10))).toEqual(['provx/bbb', 'provx/aaa', 'provx/ccc']);
  });
});

describe('getTopModels — display dispatch', () => {
  it("'best' honors the group's score_by column (briefcase reverses the GDPval order)", () => {
    expect(refs(mk().getTopModels('bestcol', 10))).toEqual(['provx/ccc', 'provx/bbb', 'provx/aaa']);
  });

  it('live resolution of the same group uses the column too', () => {
    expect(mk().resolve('bestcol')!.candidates).toEqual(['provx/ccc', 'provx/bbb', 'provx/aaa']);
  });

  it('a generic method sorts (min_cost reorders the discovery order aaa, bbb, ccc)', () => {
    expect(refs(mk().getTopModels('mincost', 10))).toEqual(['provx/bbb', 'provx/aaa', 'provx/ccc']);
  });

  it('max_gdpval sorts by score', () => {
    expect(refs(mk().getTopModels('bygdp', 10))).toEqual(['provx/aaa', 'provx/bbb', 'provx/ccc']);
  });

  it('min_cost_if_all_priced sorts by cost', () => {
    expect(refs(mk().getTopModels('mcap', 10))).toEqual(['provx/bbb', 'provx/aaa', 'provx/ccc']);
  });

  it('a dynamic group renders empty even though candidates exist', () => {
    expect(mk().getTopModels('dyno', 10)).toEqual({ models: [], total: 0 });
  });

  it('an unknown group renders empty', () => {
    expect(mk().getTopModels('no-such-group', 10)).toEqual({ models: [], total: 0 });
  });

  it('a pipeline group without steps falls through to a plain sort instead of throwing', () => {
    expect(() => mk().getTopModels('nopipe', 10)).not.toThrow();
    expect(() => mk().resolve('nopipe')).not.toThrow();
  });
});

describe('getTopModels — same-model aliases are deduped BEFORE the cost gate', () => {
  const dupCache: Cache = {
    available_models: [
      { id: 'dup-3-5', provider: 'provx', cost_per_m: 5 },
      { id: 'dup-latest', provider: 'provx', cost_per_m: 0.5 },
    ],
  } as any;

  it('a capped group drops the whole cluster when its canonical model is over the cap', () => {
    // Canonical dup-3-5 costs 5 (> max_cost 1); the alias costs 0.5. With
    // dedup first the cluster is represented by the canonical model and
    // dropped; gating first would drop only the canonical and display the
    // dishonest cheap alias.
    expect(refs(mk(dupCache).getTopModels('capped', 10))).toEqual([]);
    expect(mk(dupCache).resolve('capped')).toBeNull();
  });
});

describe('getTopModels — limited refs', () => {
  it('a limited top-ranked ref sorts to the END once, flagged limited', () => {
    const limits = new Map<string, RateLimit>([
      ['provx/aaa', { cooldown_until: Date.now() + 500_000, backoff_ms: 0, hits: 0 } as RateLimit],
    ]);
    const top = mk(cache, limits).getTopModels('bygdp', 10);
    expect(top.models.map((m) => [m.ref, m.limited, m.rank])).toEqual([
      ['provx/bbb', false, 0],
      ['provx/ccc', false, 1],
      ['provx/aaa', true, 2],
    ]);
    expect(top.total).toBe(3);
  });

  it('an available sibling represents its slug cluster over a limited higher-ranked one', () => {
    const twinCache: Cache = {
      available_models: [
        { id: 'aaa', provider: 'provx', cost_per_m: 2 },
        { id: 'aaa', provider: 'provy', cost_per_m: 2 },
      ],
    } as any;
    const limits = new Map<string, RateLimit>([
      ['provx/aaa', { cooldown_until: Date.now() + 500_000, backoff_ms: 0, hits: 0 } as RateLimit],
    ]);
    const top = mk(twinCache, limits).getTopModels('bygdp', 10);
    expect(top.models.map((m) => [m.ref, m.limited])).toEqual([['provy/aaa', false]]);
  });
});

describe('roundrobin', () => {
  it('rotation keeps the candidate list a permutation (no duplicated tail)', () => {
    const router = mk();
    router.resolve('rr'); // i = 0
    const second = router.resolve('rr')!; // i = 1
    expect(second.candidates).toHaveLength(3);
    expect(new Set(second.candidates).size).toBe(3);
    expect(second.candidates[0]).toBe(second.selected);
  });
});

describe('resolve() — fallback cascade', () => {
  it('a dynamic group never resolves statically', () => {
    expect(mk().resolve('dyno')).toBeNull();
  });

  it('skips unknown fallback groups and cascades PAST an empty one to the next', () => {
    const r = mk().resolve('cascade');
    expect(r).not.toBeNull();
    expect(r!.candidates.length).toBeGreaterThan(0);
  });
});

describe('detectGroup threshold ordering', () => {
  it('picks the highest min_gdpval the score clears, whatever the object order', () => {
    const router = mk();
    // provx/aaa has gdpval 300 → the highest threshold it clears is t300.
    expect(router.detectGroup('provx/aaa')).toBe('t300');
    // provx/ccc has gdpval 100 → t100.
    expect(router.detectGroup('provx/ccc')).toBe('t100');
  });
});

describe('detectGroup — an unscored ref takes the first UNRESTRICTED tier of the fallback list', () => {
  const unscored = 'provx/not-in-any-score-table';
  const detect = (groups: Record<string, any>) =>
    new Router({ ...config, model_groups: groups } as Config, cache, new Map()).detectGroup(unscored);

  it('the list is scout, operational, tactical, strategic, fallback — each tier on its own', () => {
    expect(detect({ strategic: { method: 'best' } })).toBe('strategic');
    expect(detect({ tactical: { method: 'best' } })).toBe('tactical');
    expect(detect({ fallback: { method: 'best' } })).toBe('fallback');
    expect(detect({ fallback: { method: 'best' }, strategic: { method: 'best' } })).toBe('strategic');
    expect(detect({ strategic: { method: 'best' }, tactical: { method: 'best' } })).toBe('tactical');
  });

  it('the fallback list wins over a min-0 group that merely sorts first (no null -> 0 coercion)', () => {
    expect(detect({ zzz: { method: 'best', min_gdpval: 0 }, tactical: { method: 'best' } })).toBe('tactical');
  });

  it('an explicit min_gdpval of 0 still counts as unrestricted; a positive floor does not', () => {
    expect(detect({ scout: { method: 'best', min_gdpval: 0 } })).toBe('scout');
    expect(detect({ scout: { method: 'best', min_gdpval: 100 } })).toBeNull();
  });
});

describe('Router.getActiveGroup', () => {
  it('reads back what setActiveGroup wrote, null by default', () => {
    const router = mk();
    expect(router.getActiveGroup()).toBeNull();
    router.setActiveGroup('rr');
    expect(router.getActiveGroup()).toBe('rr');
    router.setActiveGroup(null);
    expect(router.getActiveGroup()).toBeNull();
  });
});
