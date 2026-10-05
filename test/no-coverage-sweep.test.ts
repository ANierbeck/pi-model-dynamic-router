// test/no-coverage-sweep.test.ts — Task 5 of the mutation-survivor triage
// (docs/plans/2026-10-04-mutation-survivor-triage.md): the NoCoverage
// clusters of nightly report #1, one focused section per cluster. These
// functions/branches had NEVER been executed by any test:
//
//   isVirtualGroupRef (140 mutants — the single largest cluster),
//   applyGroupFilters' min_gdpval_pct gate, detectGroup's no-score fallback
//   list, getTopModels' display pipeline (isLastStep semantics — the display
//   path deliberately differs from resolveGroup), effCost's full chain
//   (subscription discount, cost multiplier, local, provider estimate,
//   $0.000020 default), updateMetrics' EMA updates, billingTier's free-model
//   paths, and loadModelMap's valid/broken YAML handling.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Router, isVirtualGroupRef, applyGroupFilters } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

// ── Cluster 1: isVirtualGroupRef (140 NoCoverage mutants) ──────────────────

describe('isVirtualGroupRef — full truth table', () => {
  const groups = new Set(['trivial', 'simple']);

  it('a ref without a slash is never virtual', () => {
    expect(isVirtualGroupRef('trivial', groups)).toBe(false);
  });

  it('a provider that is not a group name is never virtual', () => {
    expect(isVirtualGroupRef('openai/gpt-x', groups)).toBe(false);
    expect(isVirtualGroupRef('openai/openai', groups)).toBe(false);
  });

  it('group/self is the virtual group ref', () => {
    expect(isVirtualGroupRef('trivial/trivial', groups)).toBe(true);
  });

  it('group/group:use-static is the static pin ref', () => {
    expect(isVirtualGroupRef('simple/simple:use-static', groups)).toBe(true);
  });

  it('group with any OTHER model id is a real model, not virtual', () => {
    expect(isVirtualGroupRef('trivial/simple', groups)).toBe(false);
    expect(isVirtualGroupRef('trivial/trivial:use-other', groups)).toBe(false);
    expect(isVirtualGroupRef('trivial/simple:use-static', groups)).toBe(false);
  });
});

// ── Shared fixtures for the routing-path clusters ──────────────────────────

const testConfig: Config = {
  model_groups: {
    disp: {
      method: 'pipeline',
      pipeline: [
        { method: 'max_gdpval', top_k: 2 },
        { method: 'min_cost', top_k: 1 }, // last step: display NEVER truncates here
      ],
    },
    pctgrp: { method: 'best', min_gdpval_pct: 50 },
  },
  model_metrics: {
    'provx/aaa': { gdpval: 300, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 2 },
    'provx/bbb': { gdpval: 200, throughput_tps: 20, avg_latency_ms: 200, cost_per_m: 1 },
    'provx/ccc': { gdpval: 100, throughput_tps: 30, avg_latency_ms: 300, cost_per_m: 3 },
    'swp/pct-top': { gdpval: 1000, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 1 },
    'swp/pct-mid': { gdpval: 600, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 1 },
    'swp/pct-low': { gdpval: 400, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 1 },
    'swp/unscored-x': { throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 1 },
    'umx/model': { gdpval: 100, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 1 },
    'subx/m-cost2': { gdpval: 100, throughput_tps: 10, avg_latency_ms: 100, cost_per_m: 2 },
  },
  providers: {
    subx: { billing: 'subscription' },
    pcprov: { billing: 'pay_per_token', cost_per_m: 0.5 },
    ftx: { billing: 'pay_per_token', free_models: ['ftx/free-b', 'bare-c'] },
    prc: { billing: 'pay_per_token' },
  },
  // max_cost-0 group exercising the isFree lookup's registry-price path
  freegrp: { method: 'best', max_cost: 0 },
  gdpval_builtin: {
    'pct-top': 1000,
    'pct-mid': 600,
    'pct-low': 400,
  },
} as any;

const cache: Cache = {
  available_models: [
    { id: 'aaa', provider: 'provx', cost_per_m: 2 },
    { id: 'bbb', provider: 'provx', cost_per_m: 1 },
    { id: 'ccc', provider: 'provx', cost_per_m: 3 },
    { id: 'free-d', provider: 'fdx', cost_per_m: 0 },
    { id: 'zfree', provider: 'prc', cost_per_m: 0 },
  ],
  openrouter_pricing: {
    'prc/zfree': { input: 0, output: 0 },
    'prc/paidy': { input: 3, output: 3 },
  },
} as any;

// Registry: the 'unknown' sentinel price for the effCost chain.
const registry = {
  find: (provider: string, id: string) => {
    if (provider === 'unkprov' && id === 'um') {
      return { id, provider, cost: { input: 'unknown', output: 'unknown' } };
    }
    return undefined;
  },
};

beforeAll(() => {
  metricsModule.setConfig(testConfig);
  metricsModule.setCache(cache);
  metricsModule.setModelRegistry(registry as any);
});

// ── Cluster 2: applyGroupFilters min_gdpval_pct gate ──────────────────────

describe('applyGroupFilters — min_gdpval_pct percentile gate', () => {
  const REFS = ['swp/pct-top', 'swp/pct-mid', 'swp/pct-low'];

  it('keeps models within pct% of the BEST score (50% of 1000 → ≥ 500)', () => {
    const filtered = applyGroupFilters(REFS, testConfig.model_groups!.pctgrp!, testConfig);
    expect(filtered).toEqual(['swp/pct-top', 'swp/pct-mid']);
  });

  it('pct gate off (0/null) keeps everything', () => {
    const g = { ...testConfig.model_groups!.pctgrp!, min_gdpval_pct: 0 };
    expect(applyGroupFilters(REFS, g, testConfig)).toEqual(REFS);
  });

  it('all-unscored pools pass through the pct gate untouched', () => {
    const filtered = applyGroupFilters(['swp/unscored-x'], testConfig.model_groups!.pctgrp!, testConfig);
    expect(filtered).toEqual(['swp/unscored-x']);
  });
});

// ── Cluster 3: detectGroup's no-score fallback list ─────────────────────────

describe('detectGroup — unscored refs fall back to the first tier without a min', () => {
  it('returns the first of [scout, operational, …] with no min_gdpval requirement', () => {
    const cfg = { model_groups: { scout: { method: 'best' } } } as any;
    const router = new Router(cfg, cache, new Map());
    expect(router.detectGroup('zzq/qq-999')).toBe('scout');
  });

  it('skips tiers WITH a positive min and picks the next unrestricted one', () => {
    const cfg = {
      model_groups: { scout: { method: 'best', min_gdpval: 500 }, operational: { method: 'best' } },
    } as any;
    const router = new Router(cfg, cache, new Map());
    expect(router.detectGroup('zzq/qq-999')).toBe('operational');
  });
});

// ── Cluster 4a: the shared isFree lookup (routing.ts L135) ─────────────────

describe('applyGroupFilters max_cost 0 — isFree via the pricing cache', () => {
  it('a {0,0} pricing-cache entry is free and admitted; priced and unpriced refs drop', () => {
    const filtered = applyGroupFilters(
      ['prc/zfree', 'prc/paidy', 'prc/other'],
      testConfig.freegrp as any,
      testConfig,
    );
    expect(filtered).toEqual(['prc/zfree']);
  });
});

// ── Cluster 4: getTopModels display pipeline (isLastStep semantics) ────────

describe('getTopModels — display pipeline: last step NEVER truncates', () => {
  it('non-last steps truncate by top_k; the last step ignores its top_k', () => {
    const router = new Router(testConfig, cache, new Map());
    const r = router.getTopModels('disp', 10);
    // Step 1: max_gdpval → [aaa, bbb, ccc], top_k 2 → [aaa, bbb].
    // Step 2 (last): min_cost → [bbb, aaa]; its top_k 1 is IGNORED on display.
    expect(r.total).toBe(2);
    expect(r.models.map((m) => m.ref)).toEqual(['provx/bbb', 'provx/aaa']);
  });
});

// ── Cluster 5: effCost chain ───────────────────────────────────────────────

describe('effCost — the full chain', () => {
  it('model_metrics cost 2 on a subscription provider → 1 (0.5 discount)', () => {
    expect(metricsModule.effCost('subx/m-cost2')).toBe(1);
  });

  it('cost_mux multiplies after the discount', () => {
    metricsModule.setCache({ ...(cache as any), cost_mux: { subx: 2 } });
    try {
      expect(metricsModule.effCost('subx/m-cost2')).toBe(2);
    } finally {
      metricsModule.setCache(cache);
    }
  });

  it('local providers are free', () => {
    expect(metricsModule.effCost('ollama/lm-x')).toBe(0);
  });

  it('a registry price of unknown propagates the unknown sentinel', () => {
    expect(metricsModule.effCost('unkprov/um')).toBe('unknown');
  });

  // getM() heals every ref's cost_per_m to a defined value, so refs without
  // a price resolve to 'unknown' — the historical provider-estimate and
  // $0.000020-default fallbacks in effCost were unreachable and removed.
  it('unpriced refs are unknown (never the provider estimate or the default)', () => {
    expect(metricsModule.effCost('pcprov/pm-x')).toBe('unknown');
    expect(metricsModule.effCost('ghostprov/gm-x')).toBe('unknown');
  });

  it('the getM invariant that made those fallbacks dead: cost_per_m is always defined', () => {
    expect(metricsModule.getM('pcprov/pm-x').cost_per_m).toBe('unknown');
    expect(metricsModule.getM('ollama/lm-x').cost_per_m).toBe(0);
    expect(metricsModule.getM('provx/aaa').cost_per_m).toBe(2);
  });
});

// ── Cluster 6: updateMetrics EMA ────────────────────────────────────────────

describe('updateMetrics — exponential moving averages', () => {
  it('blends latency and throughput with α = 0.3 and persists benchmarks', () => {
    metricsModule.updateMetrics('umx/model', 400, 500, 2000);
    const m = metricsModule.getM('umx/model');
    expect(m.avg_latency_ms).toBeCloseTo(1000 * 0.7 + 400 * 0.3, 5); // 820
    expect(m.throughput_tps).toBeCloseTo(100 * 0.7 + (500 / 2000) * 1000 * 0.3, 5); // 145
    expect((cache as any).benchmarks?.['umx/model']).toBeCloseTo(145, 5);
  });

  it('a zero-duration sample updates latency but NOT throughput', () => {
    metricsModule.updateMetrics('umx/model', 100, 0, 0);
    const m = metricsModule.getM('umx/model');
    expect(m.avg_latency_ms).toBeCloseTo(820 * 0.7 + 100 * 0.3, 5);
    expect(m.throughput_tps).toBeCloseTo(145, 5);
  });
});

// ── Cluster 7: billingTier free-model paths ────────────────────────────────

describe('billingTier — every free-model detection path', () => {
  it(':free tag → tier 0', () => {
    expect(metricsModule.billingTier('ftx/free-a:free')).toBe(0);
  });

  it('free_models list: qualified ref, bare id → tier 0; others → tier 3', () => {
    expect(metricsModule.billingTier('ftx/free-b')).toBe(0); // exact qualified entry
    expect(metricsModule.billingTier('ftx/bare-c')).toBe(0); // bare-id entry
    expect(metricsModule.billingTier('ftx/not-free')).toBe(3);
  });

  it('discovered cost_per_m 0 → tier 0', () => {
    expect(metricsModule.billingTier('fdx/free-d')).toBe(0);
  });

  it('local → 2, subscription → 1, default → 3', () => {
    expect(metricsModule.billingTier('ollama/anything')).toBe(2);
    expect(metricsModule.billingTier('subx/m-cost2')).toBe(1);
    expect(metricsModule.billingTier('provx/aaa')).toBe(3);
  });
});

// ── Cluster 8: loadModelMap valid/broken YAML ─────────────────────────────

describe('loadModelMap — valid map loads, broken YAML disables overrides loudly', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelmap-'));
  });

  afterAll(() => {
    metricsModule.setModelMap({}, []); // restore a clean map for other suites
  });

  it('a valid map: exact entries, wildcards, longest-prefix-first', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'model-map.yaml'),
      'mm-x: mm-slug\nw-*: w-short-slug\nw-long*: w-long-slug\n',
    );
    metricsModule.loadModelMap(tmpDir);
    expect(metricsModule.mapLookup('mistral/mm-x')).toBe('mm-slug');
    // Longest prefix wins regardless of file order: 'w-long' beats 'w-'.
    expect(metricsModule.mapLookup('mistral/w-long-thing')).toBe('w-long-slug');
    expect(metricsModule.mapLookup('mistral/w-short-thing')).toBe('w-short-slug');
  });

  it('a broken YAML clears the map and wildcards (overrides disabled, not stale)', () => {
    fs.writeFileSync(path.join(tmpDir, 'model-map.yaml'), '{ unparseable');
    metricsModule.loadModelMap(tmpDir);
    expect(metricsModule.mapLookup('mistral/mm-x')).toBeUndefined();
    expect(metricsModule.mapLookup('mistral/w-long-thing')).toBeUndefined();
  });
});
