/**
 * GDPval slug canonicalization + dedup-before-cost-gates (2026-09-20).
 *
 * Two bugs surfaced together in the live /router panel:
 *
 *  1. The GDPval scrape lists the same model under two spellings when the
 *     version contains a dot: 'glm-5-3' AND 'glm-53' (same score). The
 *     non-dashed key is a real gdpval_scores entry, and version-tuple
 *     parsing reads it as version [53] — which beats every real multi-part
 *     version ([5,3]: 53 > 5) in -latest resolution. Result: zai-glm-latest
 *     resolved to 'glm-53' while zai-glm-5-3 resolved to 'glm-5-3' —
 *     same model, DIFFERENT identity keys, so same-slug dedup never fired
 *     and the panel showed zai-glm-5, zai-glm-latest AND zai-glm-5-3 as
 *     three separate models (zai-glm-latest with a fake $0.0).
 *
 *  2. applyGroupFilters ran its optional dedup AFTER the max_cost gate.
 *     In cost-capped groups the honest registry-priced variant
 *     (zai-glm-5-3, $1.4) was dropped by max_cost first, so the dedup only
 *     ever saw the fake-priced aliases (cost_per_m 0 scan placeholder)
 *     and kept them — capped groups displayed and routed the dishonest
 *     variant. Dedup must run BEFORE the cost gates so the filters act on
 *     the canonical cluster representative.
 *
 * Canonical rule (score-validated): a key maps to its dashed twin only when
 * splatting the digit-runs yields an EXISTING key with the SAME score —
 * true duplicates collapse ('glm-53' → 'glm-5-3'). Score-different twins
 * stay distinct: 'glm-52' (1232.78) is GDPval's non-reasoning variant, not
 * a duplicate of 'glm-5-2' (1357.35). Date keys without a splatted twin
 * ('mistral-small-2603') are untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as metricsModule from '../src/metrics.ts';
import { applyGroupFilters, Router } from '../src/routing.ts';
import { normalizeModelId } from '../src/slug-matcher.ts';
import { collapseSameSlugClusters, filterModelsForGroup, ModelWithMetadata } from '../src/dynamic-config.ts';
import type { Config, Group, Cache } from '../src/types.ts';

/** GDPval scrape excerpt with the duplicate-spelling artifacts. */
const SCORES: Record<string, number> = {
  'glm-5-3': 1645.36,
  'glm-53': 1645.36, // true duplicate of glm-5-3
  'glm-5-2': 1357.35,
  'glm-52': 1232.78, // NOT a duplicate: non-reasoning variant, different score
  'glm-5-1': 1103.14,
  'glm-51': 1103.14, // true duplicate of glm-5-1
  'mistral-small-3-2': 478,
  'mistral-small-2603': 478, // date snapshot — no splatted twin exists
};

const MODEL_METRICS: Config['model_metrics'] = {
  'mistral/zai-glm-5-3': { cost_per_m: 1.4 },
  'mistral/zai-glm-latest': { cost_per_m: 0 }, // scan placeholder semantics
  'mistral/zai-glm-5': { cost_per_m: 0 },
  'mistral/glm-5-2': { cost_per_m: 0.6 },
};

const CFG: Config = {
  model_groups: {
    capped: { method: 'best', max_cost: 0, fallback_groups: [] },
    uncapped: { method: 'best', fallback_groups: [] },
  },
  model_metrics: MODEL_METRICS,
  providers: { mistral: { billing: 'subscription' } },
} as any;

const CLUSTER_REFS = [
  'mistral/zai-glm-latest', // alias, fake $0
  'mistral/zai-glm-5', // unversioned, fake $0
  'mistral/zai-glm-5-3', // canonical, $1.4
];

beforeAll(() => {
  metricsModule.setConfig({
    model_groups: CFG.model_groups,
    model_metrics: MODEL_METRICS,
    gdpval_builtin: {},
    providers: { mistral: { billing: 'subscription' } },
  } as any);
  metricsModule.setCache({
    available_models: [],
    gdpval_scores: SCORES,
    llm_matches: {},
  } as any);
  metricsModule.setGdpval(SCORES);
  metricsModule.setModelMap({}, []);
});

afterAll(() => {
  metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} } as any);
  metricsModule.setGdpval({});
  metricsModule.setCache({} as any);
});

// ── resolveSlug canonicalization ────────────────────────────────────────

describe('GDPval slug canonicalization (duplicate spellings)', () => {
  it('-latest alias resolves to the DASHED canonical slug, not the [53] digit-run (the panel bug)', () => {
    expect(metricsModule.getMatchedSlug('mistral/zai-glm-latest')).toBe('glm-5-3');
  });

  it('all cluster variants share ONE identity slug', () => {
    expect(metricsModule.getMatchedSlug('mistral/zai-glm-5-3')).toBe('glm-5-3');
    expect(metricsModule.getMatchedSlug('mistral/zai-glm-5')).toBe('glm-5-3');
  });

  it('score-different twins stay DISTINCT (glm-52 is the non-reasoning variant)', () => {
    expect(metricsModule.getMatchedSlug('mistral/glm-52')).toBe('glm-52');
    expect(metricsModule.getMatchedSlug('mistral/glm-5-2')).toBe('glm-5-2');
  });

  it('date keys without a splatted twin are untouched', () => {
    expect(metricsModule.getMatchedSlug('mistral/mistral-small-2603')).toBe('mistral-small-2603');
  });

  it('canonicalizes a cached LLM match that points at the duplicate spelling', () => {
    metricsModule.setLlmMatches({ 'mistral/zai-glm-latest': 'glm-53' });
    try {
      expect(metricsModule.getMatchedSlug('mistral/zai-glm-latest')).toBe('glm-5-3');
    } finally {
      metricsModule.setLlmMatches({});
    }
  });

  it('GDPval score lookups still work through the canonical slug', () => {
    expect(metricsModule.lookupGdp('mistral/zai-glm-latest')).toBe(1645.36);
    expect(metricsModule.lookupGdp('mistral/zai-glm-5-3')).toBe(1645.36);
  });
});

// ── dedup BEFORE the cost gates ────────────────────────────────────────

/** Mirrors Router.dedupByModelIdentity's provider:slug keying (the real
 * function is exercised through the Router tests below; applyGroupFilters
 * itself only takes an injected dedupFn). */
const dedupBySlug = (refs: string[]): string[] => {
  const best = new Map<string, string>();
  for (const ref of refs) {
    const slug = metricsModule.getMatchedSlug(ref);
    const key = slug ? `${ref.split('/')[0]}:${slug}` : ref;
    const current = best.get(key);
    if (current === undefined) {
      best.set(key, ref);
    } else {
      // Prefer the variant whose id normalizes to the canonical slug
      // (vendor prefixes stripped, same rule as Router.isBetterModelVariant).
      const canon = (r: string) => {
        const s = metricsModule.getMatchedSlug(r);
        return s !== null && normalizeModelId(r.split('/')[1]) === normalizeModelId(s) ? 1 : 0;
      };
      if (canon(ref) > canon(current)) best.set(key, ref);
    }
  }
  return Array.from(best.values());
};

describe('applyGroupFilters: dedup runs BEFORE the cost gates', () => {
  it('capped group drops the whole cluster — the honest canonical price exceeds the cap', () => {
    const g: Group = { method: 'best', max_cost: 0 } as any;
    const out = applyGroupFilters(CLUSTER_REFS, g, CFG, true, dedupBySlug);
    // The canonical representative (zai-glm-5-3, $1.4) is what the cost gate
    // sees; it exceeds max_cost 0 → cluster gone. The fake-$0 aliases must
    // NOT sneak through as the surviving variant.
    expect(out).toEqual([]);
  });

  it('uncapped group keeps exactly the canonical representative', () => {
    const g: Group = { method: 'best' } as any;
    const out = applyGroupFilters(CLUSTER_REFS, g, CFG, true, dedupBySlug);
    expect(out).toEqual(['mistral/zai-glm-5-3']);
  });
});

// ── Router end-to-end (live resolve + display getTopModels) ─────────────

describe('Router: cluster collapses to the honest canonical model', () => {
  const cache: Cache = {
    gdpval_scores: SCORES,
    available_models: [
      { provider: 'mistral', id: 'zai-glm-5-3', cost_per_m: 1.4 },
      { provider: 'mistral', id: 'zai-glm-latest', cost_per_m: 0 },
      { provider: 'mistral', id: 'zai-glm-5', cost_per_m: 0 },
    ],
  } as any;
  const router = new Router(CFG, cache, new Map());

  it('live resolve: candidates are the canonical model only, alias never selected', () => {
    const res = router.resolve('uncapped');
    expect(res).not.toBeNull();
    expect(res!.candidates).toEqual(['mistral/zai-glm-5-3']);
    expect(res!.selected).toBe('mistral/zai-glm-5-3');
  });

  it('capped group resolves to null (no fake-$0 alias survives the cap)', () => {
    const res = router.resolve('capped');
    expect(res).toBeNull();
  });

  it('display getTopModels shows the canonical model once, at its honest rank', () => {
    const { models: top } = router.getTopModels('uncapped', 5);
    const refs = top.map((t) => t.ref);
    expect(refs).toContain('mistral/zai-glm-5-3');
    expect(refs).not.toContain('mistral/zai-glm-latest');
    expect(refs).not.toContain('mistral/zai-glm-5');
  });
});

// ── Persist path: cluster collapse BEFORE filterModelsForGroup ───────────
// The generated dynamic config (router-config.dynamic.json, written at
// session start) had its own instance of the same bug: filterModelsForGroup
// cost-filters BEFORE collectGroupModels dedups, so in max_cost-0 groups the
// honest registry-priced twin was dropped first and the fake-priced alias
// (cost_per_m-0 scan placeholder) survived as the cluster representative —
// trivial/simple/scout/fallback listed mistral/zai-glm-5 at $0.0.

describe('persist path: collapse clusters before the cost filter', () => {
  const withMeta = (ref: string, cost: number | 'unknown', isFree = false): ModelWithMetadata => ({
    ref,
    gdpval: metricsModule.lookupGdp(ref) ?? 50,
    cost,
    price: typeof cost === 'number' ? { input: cost, output: cost * 2 } : undefined,
    isFreeModel: isFree,
    contextWindow: 128_000,
  });

  // Rank order deliberately puts the aliases first — the cluster rep must
  // still be the canonical variant.
  const cluster = [
    withMeta('mistral/zai-glm-latest', 0),
    withMeta('mistral/zai-glm-5', 0),
    withMeta('mistral/zai-glm-5-3', 1.4),
  ];

  it('collapseSameSlugClusters keeps the canonical representative', () => {
    const reps = collapseSameSlugClusters(cluster);
    expect(reps.map((m) => m.ref)).toEqual(['mistral/zai-glm-5-3']);
  });

  it('a max_cost-0 group then contains NO zai at all (honest cluster dropped)', () => {
    const g: Group = { method: 'best', max_cost: 0 } as any;
    const out = filterModelsForGroup(collapseSameSlugClusters(cluster), g, CFG);
    expect(out.map((m) => m.ref)).toEqual([]);
  });

  it('an uncapped group keeps the honest canonical model', () => {
    const g: Group = { method: 'best' } as any;
    const out = filterModelsForGroup(collapseSameSlugClusters(cluster), g, CFG);
    expect(out.map((m) => m.ref)).toEqual(['mistral/zai-glm-5-3']);
  });

  it('cross-provider same-slug variants are NOT collapsed here (phase-2 collectGroupModels handles those)', () => {
    const cross = [
      withMeta('mistral/glm-5-2', 0.6),
      withMeta('openrouter/z-ai/glm-5.2:free', 0, true),
    ];
    const reps = collapseSameSlugClusters(cross);
    expect(reps.map((m) => m.ref)).toEqual(cross.map((m) => m.ref));
  });
});
