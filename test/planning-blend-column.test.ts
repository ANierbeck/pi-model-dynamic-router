// test/planning-blend-column.test.ts
// The `reasoning` capability column: planning ranks by a blend of three AA
// columns that together describe "think hard about a problem" — the
// Intelligence Index (composite), Omniscience (knowledge accuracy net of
// hallucination) and HLE Diamond (hardest questions). Owner decision
// 2026-10-31: equal thirds, HLE Diamond (not plain HLE), a model missing one
// of the three gets NO blend (missing data beats wrong data, Sourcery PR #69).
//
// Why a new column instead of the Briefcase Elo planning used before: on the
// 2026-10-31 scrape Briefcase put Sonnet 5.5 (1813.57) ahead of Opus 5.5
// (1800.51) while Omniscience (30.5 vs 48.1) and HLE Diamond (0.533 vs 0.679)
// say the opposite — and planning is the depth tier. Values below are cut from
// that scrape.

import { describe, it, expect, beforeAll } from 'vitest';
import { extractCapabilityProfiles } from '../src/scan-runner.js';
import { Router as RoutingRouter } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import { describeBestMethod } from '../src/rank-explain.js';
import { isCapabilityColumn, CAPABILITY_COLUMNS } from '../src/types.js';
import { readFileSync } from 'node:fs';

// initialModels shape (live since 2026-10-13); one record per case.
function rec(slug: string, fields: Record<string, number | null>): string {
  const body = Object.entries(fields)
    .map(([k, v]) => `"${k}":${v === null ? 'null' : v}`)
    .join(',');
  return (
    `{"id":"2f3c4dc9-a450-4303-8697-0237257cf${String(slug.length).padStart(3, '0')}","slug":"${slug}",` +
    `"name":"${slug} (Max)","shortName":"${slug}","creator":{"id":"x","slug":"c","name":"C","color":"#000"},${body}}`
  );
}

const PAGE = [
  '{"slug":"gdpval-aa","initialModels":[',
  rec('opus-like', { intelligenceIndex: 58.4, omniscience: 48.1, hleDiamond: 0.679, briefcaseElo: 1800.51 }),
  ',',
  rec('sonnet-like', { intelligenceIndex: 54.2, omniscience: 30.5, hleDiamond: 0.533, briefcaseElo: 1813.57 }),
  ',',
  rec('no-hle-diamond', { intelligenceIndex: 59.4, omniscience: 53.5, hleDiamond: null, briefcaseElo: 1610.19 }),
  ',',
  rec('negative-omniscience', { intelligenceIndex: 20, omniscience: -8, hleDiamond: 0.2 }),
  ',',
  rec('measured-zero', { intelligenceIndex: 0, omniscience: 0, hleDiamond: 0 }),
  ',',
  rec('unrelated-model', { briefcaseElo: 1500 }),
  ']}',
].join('');

describe('extractCapabilityProfiles: reasoning blend', () => {
  const profiles = extractCapabilityProfiles(PAGE);

  it('is the mean of Intelligence Index, Omniscience and 100 x HLE Diamond (equal thirds)', () => {
    // (58.4 + 48.1 + 67.9) / 3 = 58.1333…
    expect(profiles['opus-like']?.reasoning).toBeCloseTo(58.13, 2);
    // (54.2 + 30.5 + 53.3) / 3 = 46.0
    expect(profiles['sonnet-like']?.reasoning).toBeCloseTo(46.0, 2);
  });

  it('rounds to two decimals so the value is stable across the cache JSON boundary', () => {
    const v = profiles['opus-like']?.reasoning as number;
    expect(Math.round(v * 100) / 100).toBe(v);
  });

  it('a model missing ANY of the three gets no blend, but keeps its other columns', () => {
    expect(profiles['no-hle-diamond']?.reasoning).toBeUndefined();
    expect(profiles['no-hle-diamond']?.briefcase).toBe(1610.19);
  });

  it('a negative Omniscience (hallucination exceeds accuracy) is data, not absence', () => {
    // (20 - 8 + 20) / 3 = 10.67
    expect(profiles['negative-omniscience']?.reasoning).toBeCloseTo(10.67, 2);
  });

  it('a measured 0 on all three is data: reasoning 0, not "no value"', () => {
    expect(profiles['measured-zero']?.reasoning).toBe(0);
  });

  it('a record carrying none of the three leaves the column absent', () => {
    expect(profiles['unrelated-model']?.reasoning).toBeUndefined();
  });
});

describe('column helpers', () => {
  it('reasoning is a capability column next to briefcase and coding', () => {
    expect([...CAPABILITY_COLUMNS].sort()).toEqual(['briefcase', 'coding', 'reasoning']);
    expect(isCapabilityColumn('reasoning')).toBe(true);
    expect(isCapabilityColumn('gdpval')).toBe(false);
    expect(isCapabilityColumn(undefined)).toBe(false);
  });

  it('describeBestMethod names the real sort key', () => {
    expect(describeBestMethod('reasoning', 0.05)).toBe('best by reasoning · 5% window');
  });
});

// ── Ranking: the column must be able to reverse Briefcase's pick ──────────

const CONFIG = {
  model_groups: {
    planning: { method: 'best', min_gdpval: 1700, score_by: 'reasoning', fallback_groups: [] },
  },
  model_metrics: {
    'claude-bridge/claude-opus-5-5': { cost_per_m: 2.0e-6, throughput_tps: 100, avg_latency_ms: 1000 },
    'claude-bridge/claude-sonnet-5-5': { cost_per_m: 1.5e-6, throughput_tps: 100, avg_latency_ms: 1000 },
    'claude-bridge/claude-haiku-5-5': { cost_per_m: 1.0e-6, throughput_tps: 100, avg_latency_ms: 1000 },
  },
  providers: {},
  gdpval_builtin: { 'claude-opus-5-5': 1900, 'claude-sonnet-5-5': 1844, 'claude-haiku-5-5': 1720 },
  best_quality_window: 0.05,
} as any;

const PROFILES = {
  'claude-opus-5-5': { briefcase: 1800.51, reasoning: 56.02 },
  // Sonnet is CHEAPER and ahead on Briefcase: only the reasoning column can
  // put Opus first (56.02 vs 46.6 is far outside the 5 % window).
  'claude-sonnet-5-5': { briefcase: 1813.57, reasoning: 46.6 },
  // Haiku has no reasoning value: it must rank after every profiled model.
  'claude-haiku-5-5': { briefcase: 1575.9 },
};

describe('ranking by the reasoning column', () => {
  let router: any;
  beforeAll(() => {
    metricsModule.setConfig(CONFIG);
    metricsModule.setCache({ available_models: [], capability_profiles: PROFILES } as any);
    metricsModule.setModelRegistry({ find: () => undefined } as any);
    router = new RoutingRouter(CONFIG, { available_models: [], capability_profiles: PROFILES } as any, new Map());
  });

  it('lookupCapability resolves the column; absent is null, never 0', () => {
    expect(metricsModule.lookupCapability('claude-bridge/claude-opus-5-5', 'reasoning')).toBe(56.02);
    expect(metricsModule.lookupCapability('claude-bridge/claude-haiku-5-5', 'reasoning')).toBeNull();
  });

  it('calculateScore uses the column when present and the GDPval fallback when not', () => {
    expect(metricsModule.calculateScore('claude-bridge/claude-opus-5-5', 'reasoning')).toBe(56.02);
    expect(metricsModule.calculateScore('claude-bridge/claude-haiku-5-5', 'reasoning')).toBe(1720);
  });

  it('puts Opus ahead of the cheaper Sonnet — the opposite of the Briefcase order', () => {
    const refs = ['claude-bridge/claude-sonnet-5-5', 'claude-bridge/claude-opus-5-5'];
    expect(router.sortBy(refs, 'best', 'reasoning')[0]).toBe('claude-bridge/claude-opus-5-5');
    expect(router.sortBy(refs, 'best', 'briefcase')[0]).toBe('claude-bridge/claude-sonnet-5-5');
  });

  it('ranks a model without the column after every profiled one', () => {
    const sorted = router.sortBy(
      ['claude-bridge/claude-haiku-5-5', 'claude-bridge/claude-sonnet-5-5', 'claude-bridge/claude-opus-5-5'],
      'best',
      'reasoning',
    );
    expect(sorted).toEqual([
      'claude-bridge/claude-opus-5-5',
      'claude-bridge/claude-sonnet-5-5',
      'claude-bridge/claude-haiku-5-5',
    ]);
  });

  it('resolveGroup threads score_by end to end: planning picks Opus', () => {
    const cache = {
      available_models: [
        { provider: 'claude-bridge', id: 'claude-opus-5-5' },
        { provider: 'claude-bridge', id: 'claude-sonnet-5-5' },
      ] as any,
      capability_profiles: PROFILES,
    } as any;
    const r = new RoutingRouter(CONFIG, cache, new Map());
    expect(r.resolve('planning')?.selected).toBe('claude-bridge/claude-opus-5-5');
  });
});

// ── Shipped defaults ──────────────────────────────────────────────────────

describe('shipped config: planning reasons, design stays on Briefcase', () => {
  const cfg = JSON.parse(readFileSync(new URL('../router-config.json', import.meta.url), 'utf8'));

  it('planning scores by reasoning and drops models that have no such value', () => {
    expect(cfg.model_groups.planning.score_by).toBe('reasoning');
    expect(cfg.model_groups.planning.require_score_column).toBe(true);
  });

  it('design keeps Briefcase and does not filter on it (owner decision 2026-10-31)', () => {
    expect(cfg.model_groups.design.score_by).toBe('briefcase');
    expect(cfg.model_groups.design.require_score_column).toBeUndefined();
  });

  it('the GDPval floor on planning is untouched (columns order, floors admit)', () => {
    expect(cfg.model_groups.planning.min_gdpval).toBe(1700);
  });
});
