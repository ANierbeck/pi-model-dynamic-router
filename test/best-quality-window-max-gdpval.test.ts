// test/best-quality-window-max-gdpval.test.ts
// Guards the tier-routing restoration (ADR-0023, owner decision 2026-10-04).
//
// LIVE EVIDENCE (router.log 2026-10-04): 65 prompts routed to tactical, 0 to
// strategic — gdpval compression at the top (claude-opus-5-5 1900,
// claude-sonnet-5-5 1844, zai-glm-5-3 1644: a 3%/11% spread) plus the
// `best` method's converge-on-the-max behavior made opus-5-5 the winner of
// EVERY non-trivial prompt. The intended tier design (free Mistral
// subscription tank carries the daily load, Claude reserved for heavy work)
// was dead — and since all claude-bridge models share ONE 5h window
// (provider-level limit), the whole Claude provider burned down by ~08:50
// while the flat-fee Mistral tank sat unused.
//
// Two mechanisms, both requested by the owner (combining the gdpval cap with
// cost-awareness within a group):
//   1. `max_gdpval` — a per-group HARD upper tier boundary (symmetric to
//      min_gdpval): tactical capped at 1700 admits glm-5-3 (1644) and keeps
//      opus/sonnet for strategic.
//   2. `best_quality_window` — within X% of the group's best score all
//      candidates are EQUALLY GOOD; the CHEAPEST is picked first, cost ties
//      break to the LOWER score (least overkill). In strategic (no cap):
//      opus (1900) and sonnet (1844) are within 5%, both subscription-priced
//      equal → sonnet first. In tactical, glm dominates its pool alone.
//
// Test fixtures mirror the production scores from the 2026-10-04 scan
// cache; claude-bridge models carry the sunk-cost price (1.5e-6) like the
// real config, glm-5-3 resolves a registry price like production.

import { describe, it, expect, beforeAll } from 'vitest';
import { Router, applyGroupFilters } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

const testConfig: Config = {
  model_groups: {
    tactical: {
      method: 'best',
      min_gdpval: 600,
      max_gdpval: 1700,
      fallback_groups: ['strategic'],
    },
    strategic: {
      method: 'best',
      min_gdpval: 700,
      fallback_groups: [],
    },
  },
  model_metrics: {
    // Production-shaped sunk-cost pricing: every claude-bridge peer costs
    // the same 1.5e-6 — cost alone CANNOT differentiate sonnet from opus;
    // only the least-overkill tiebreak can.
    'claude-bridge/claude-opus-5-5': { cost_per_m: 1.5e-6, gdpval: 1900, throughput_tps: 100, avg_latency_ms: 1000 },
    'claude-bridge/claude-sonnet-5-5': { cost_per_m: 1.5e-6, gdpval: 1844, throughput_tps: 100, avg_latency_ms: 1000 },
    'mistral/zai-glm-5-3': { cost_per_m: 1.4, gdpval: 1644, throughput_tps: 60, avg_latency_ms: 1200 },
    'mistral/mistral-medium-3.5': { cost_per_m: 0.4, gdpval: 933, throughput_tps: 80, avg_latency_ms: 900 },
  },
  providers: {},
  // Scores go into gdpval_builtin (slug-keyed): applyGroupFilters reads
  // GDPval via lookupGdp, which resolves ONLY the gdpval map built from
  // gdpval_builtin + cache.gdpval_scores — NOT from model_metrics[ref].gdpval.
  gdpval_builtin: {
    'claude-opus-5-5': 1900,
    'claude-sonnet-5-5': 1844,
    'zai-glm-5-3': 1644,
    'mistral-medium-3.5': 933,
    'glm-twin': 1650,
  },
  best_quality_window: 0.05,
} as any;

const cache: Cache = { available_models: [] } as any;

beforeAll(() => {
  metricsModule.setConfig(testConfig);
  metricsModule.setCache(cache);
  metricsModule.setModelRegistry({ find: () => undefined } as any);
});

const TACTICAL_POOL = [
  'claude-bridge/claude-opus-5-5',
  'claude-bridge/claude-sonnet-5-5',
  'mistral/zai-glm-5-3',
  'mistral/mistral-medium-3.5',
];

describe('max_gdpval — hard upper tier boundary (applyGroupFilters)', () => {
  it('drops models ABOVE the cap and keeps those below (tactical: opus/sonnet out, glm/medium in)', () => {
    const filtered = applyGroupFilters(TACTICAL_POOL, testConfig.model_groups!.tactical, testConfig);
    expect(filtered).toContain('mistral/zai-glm-5-3');
    expect(filtered).toContain('mistral/mistral-medium-3.5');
    expect(filtered).not.toContain('claude-bridge/claude-opus-5-5');
    expect(filtered).not.toContain('claude-bridge/claude-sonnet-5-5');
  });

  it('leaves an uncapped group (strategic) untouched by the boundary', () => {
    const filtered = applyGroupFilters(TACTICAL_POOL, testConfig.model_groups!.strategic, testConfig);
    expect(filtered).toContain('claude-bridge/claude-opus-5-5');
    expect(filtered).toContain('claude-bridge/claude-sonnet-5-5');
    expect(filtered).toContain('mistral/zai-glm-5-3');
  });

  it('absent/0 cap = no upper bound (previous behavior preserved)', () => {
    const g = { ...testConfig.model_groups!.tactical, max_gdpval: 0 };
    const filtered = applyGroupFilters(TACTICAL_POOL, g, testConfig);
    expect(filtered).toHaveLength(4);
  });
});

describe('best_quality_window — cheapest-within-equivalence selection (sortBy best)', () => {
  const router = new Router(testConfig, cache, new Map());

  it('strategic (no cap): sonnet beats opus — equal cost, least overkill wins', () => {
    const sorted = router.sortBy(TACTICAL_POOL, 'best');
    // Window floor = 1900 * 0.95 = 1805 → pool {opus, sonnet}; costs tie at
    // 1.5e-6 → LOWER gdpval first: sonnet (1844) before opus (1900).
    expect(sorted[0]).toBe('claude-bridge/claude-sonnet-5-5');
    expect(sorted[1]).toBe('claude-bridge/claude-opus-5-5');
    // Outside the window → behind the pool, by score.
    expect(sorted[2]).toBe('mistral/zai-glm-5-3');
    expect(sorted[3]).toBe('mistral/mistral-medium-3.5');
  });

  it('a genuinely cheaper model in the window wins on cost alone', () => {
    // glm at 1644 vs a 1644-scoring PAYG-free model: the free model is
    // cheaper and equally scored → it must come first.
    const cfg2 = {
      ...testConfig,
      model_metrics: {
        ...testConfig.model_metrics,
        'openrouter/glm-twin:free': { cost_per_m: 0, gdpval: 1650, throughput_tps: 50, avg_latency_ms: 800 },
      },
    } as any;
    metricsModule.setConfig(cfg2);
    const r2 = new Router(cfg2, cache, new Map());
    const sorted = r2.sortBy(['mistral/zai-glm-5-3', 'openrouter/glm-twin:free'], 'best');
    expect(sorted[0]).toBe('openrouter/glm-twin:free'); // $0 < $1.4
  });

  it('unknown-cost models sort to the END of the equivalence pool', () => {
    // An unscored-cost model with a window-eligible score must not win the
    // pool just because its score is high.
    const cfg2 = {
      ...testConfig,
      model_metrics: {
        'claude-bridge/claude-opus-5-5': { gdpval: 1900, throughput_tps: 100, avg_latency_ms: 1000 },
        'claude-bridge/claude-sonnet-5-5': { cost_per_m: 1.5e-6, gdpval: 1844, throughput_tps: 100, avg_latency_ms: 1000 },
      },
    } as any;
    metricsModule.setConfig(cfg2);
    const r2 = new Router(cfg2, cache, new Map());
    const sorted = r2.sortBy(['claude-bridge/claude-opus-5-5', 'claude-bridge/claude-sonnet-5-5'], 'best');
    expect(sorted[0]).toBe('claude-bridge/claude-sonnet-5-5');
    expect(sorted[1]).toBe('claude-bridge/claude-opus-5-5');
  });

  it('window = 0 restores pure score ordering (previous behavior)', () => {
    const cfg0 = { ...testConfig, best_quality_window: 0 } as any;
    metricsModule.setConfig(cfg0);
    const r0 = new Router(cfg0, cache, new Map());
    const sorted = r0.sortBy(TACTICAL_POOL, 'best');
    expect(sorted[0]).toBe('claude-bridge/claude-opus-5-5'); // max score wins again
  });

  it('a pool with a single member is returned in score order (no window reshuffle)', () => {
    // tactical-shaped pool AFTER the cap: only glm and medium survive; the
    // 5% window of glm (1562) contains glm alone → plain score order.
    const capped = applyGroupFilters(TACTICAL_POOL, testConfig.model_groups!.tactical, testConfig);
    metricsModule.setConfig(testConfig);
    const r = new Router(testConfig, cache, new Map());
    const sorted = r.sortBy(capped, 'best');
    expect(sorted[0]).toBe('mistral/zai-glm-5-3'); // the free tank carries tactical
    expect(sorted[1]).toBe('mistral/mistral-medium-3.5');
  });
});

describe('end-to-end tier routing (the owner\'s actual complaint)', () => {
  it('tactical resolves to glm-5-3 first; opus only reachable via strategic', () => {
    metricsModule.setConfig(testConfig);
    const router = new Router(testConfig, cache, new Map());
    const tactical = router.sortBy(
      applyGroupFilters(TACTICAL_POOL, testConfig.model_groups!.tactical, testConfig),
      'best'
    );
    const strategic = router.sortBy(
      applyGroupFilters(TACTICAL_POOL, testConfig.model_groups!.strategic, testConfig),
      'best'
    );
    expect(tactical[0]).toBe('mistral/zai-glm-5-3'); // free tank carries the daily load
    expect(strategic[0]).toBe('claude-bridge/claude-sonnet-5-5'); // cheapest-within-window of the top tier
    expect(strategic).toContain('claude-bridge/claude-opus-5-5'); // opus stays reachable as escalation
  });
});
