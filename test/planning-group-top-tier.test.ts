// test/planning-group-top-tier.test.ts
// Guards the design/planning top-tier-only routing (owner decision
// 2026-10-04, ADR-0023 follow-up).
//
// Problem: `design`/`planning` categories mapped to `tactical`, which after
// ADR-0023 is the glm-5-3 free-tank group — planning and architecture work
// would land on the cheapest qualifying model instead of the best available
// one. The owner's requirement: planning tasks must reach ONLY top-tier
// models (Claude's best today; any provider's future top-tier models).
//
// Mechanism, as of the owner decision of 2026-11-15: a dedicated `planning`
// group gated by the REASONING column (`score_by: reasoning`,
// `require_score_column`, `min_score: 35`), not by a GDPval floor. The old
// floor (min_gdpval 1700) kept glm-5-3 (1644) and mistral-medium-3.5 (933)
// out, but it also excluded the best reasoning model in the cache
// (claude-fable-5-2: reasoning 70.5, GDPval 1546) — the floor, not the
// ranking, decided membership. The column gate is now the guarantee: a
// model without a reasoning value, or below 35, stays out whatever its
// GDPval. Escalation (Claude window empty, all planning models failed) goes
// strategic → tactical → glm as the emergency fallback, per the group's
// fallback_groups.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Router, applyGroupFilters } from '../src/routing.js';
import { CATEGORY_TO_GROUP } from '../src/content-classifier.js';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoCfg = JSON.parse(readFileSync(join(repoRoot, 'router-config.json'), 'utf-8')) as Config;

// Production-shaped scores (2026-10-04 scan cache) and sunk-cost prices.
const testConfig: Config = {
  model_groups: {
    planning: repoCfg.model_groups!.planning,
    design: repoCfg.model_groups!.design,
    code_complex: repoCfg.model_groups!.code_complex,
  },
  model_metrics: {
    'claude-bridge/claude-opus-5-5': {
      cost_per_m: 1.5e-6,
      throughput_tps: 100,
      avg_latency_ms: 1000,
    },
    'claude-bridge/claude-sonnet-5-5': {
      cost_per_m: 1.5e-6,
      throughput_tps: 100,
      avg_latency_ms: 1000,
    },
    'mistral/zai-glm-5-3': { cost_per_m: 1.4, throughput_tps: 60, avg_latency_ms: 1200 },
    'mistral/mistral-medium-3.5': { cost_per_m: 0.4, throughput_tps: 80, avg_latency_ms: 900 },
  },
  providers: {},
  // Scores via gdpval_builtin: applyGroupFilters resolves GDPval through
  // lookupGdp (the gdpval map), not through model_metrics[ref].gdpval.
  gdpval_builtin: {
    'claude-opus-5-5': 1900,
    'claude-sonnet-5-5': 1844,
    'zai-glm-5-3': 1644,
    'mistral-medium-3.5': 933,
  },
  best_quality_window: 0.05,
} as any;

const cache: Cache = { available_models: [] } as any;
const ALL = [
  'claude-bridge/claude-opus-5-5',
  'claude-bridge/claude-sonnet-5-5',
  'mistral/zai-glm-5-3',
  'mistral/mistral-medium-3.5',
];

beforeAll(() => {
  metricsModule.setConfig(testConfig);
  metricsModule.setCache(cache);
  metricsModule.setModelRegistry({ find: () => undefined } as any);
});

describe('shipped config: the planning group exists and is top-tier-only by reasoning', () => {
  it('router-config.json defines planning with the reasoning gates and no GDPval floor', () => {
    const g = repoCfg.model_groups!.planning;
    expect(g).toBeDefined();
    expect(g.method).toBe('best');
    expect(g.min_gdpval).toBeUndefined();
    expect(g.score_by).toBe('reasoning');
    expect(g.require_score_column).toBe(true);
    expect(g.min_score).toBe(35);
  });

  it('escalation chain never dead-ends: fallback_groups are declared', () => {
    const g = repoCfg.model_groups!.planning;
    expect(g.fallback_groups).toBeDefined();
    expect(g.fallback_groups!.length).toBeGreaterThan(0);
    expect(g.fallback_groups![0]).toBe('code_complex');
  });
});

describe('CATEGORY_TO_GROUP: design and planning are the two top groups (D5)', () => {
  it('design → design (its own group at floor 1600)', () => {
    expect(CATEGORY_TO_GROUP.design).toBe('design');
  });
  it('planning → planning (top tier only, floor 1700)', () => {
    expect(CATEGORY_TO_GROUP.planning).toBe('planning');
  });
  it('code_complex stays in its own band group (glm free tank keeps the coding daily load)', () => {
    expect(CATEGORY_TO_GROUP.code_complex).toBe('code_complex');
  });
});

describe('design group filtering (D5): the 1600 floor admits the wider upper band', () => {
  it('sonnet/opus pass; glm (1644) passes too — the planning 1700 floor is what keeps it out', () => {
    const filtered = applyGroupFilters(ALL, testConfig.model_groups!.design, testConfig);
    expect(filtered).toContain('claude-bridge/claude-sonnet-5-5');
    expect(filtered).toContain('claude-bridge/claude-opus-5-5');
    expect(filtered).toContain('mistral/zai-glm-5-3');
    expect(filtered).not.toContain('mistral/mistral-medium-3.5');
  });
});

describe('planning group filtering: glm and mistral-medium are FLAT OUT', () => {
  it('the reasoning gate admits only sonnet/opus; glm and medium stay out', () => {
    // The gate needs reasoning values to act on: with none anywhere it stands
    // down (require-score-column.test.ts pins that safety valve), so this test
    // supplies the production-shaped column. glm and medium are below 35.
    metricsModule.setCache({
      available_models: [],
      capability_profiles: {
        'claude-opus-5-5': { reasoning: 58.4 },
        'claude-sonnet-5-5': { reasoning: 46.1 },
        'zai-glm-5-3': { reasoning: 18.5 },
        'mistral-medium-3.5': { reasoning: 22 },
      },
    } as any);
    const filtered = applyGroupFilters(ALL, testConfig.model_groups!.planning, testConfig);
    expect(filtered).toContain('claude-bridge/claude-sonnet-5-5');
    expect(filtered).toContain('claude-bridge/claude-opus-5-5');
    expect(filtered).not.toContain('mistral/zai-glm-5-3');
    expect(filtered).not.toContain('mistral/mistral-medium-3.5');
    metricsModule.setCache(cache);
  });
});

describe('planning group selection: sonnet primary, opus escalation (best window)', () => {
  it('sortBy best puts sonnet-5-5 first (equal cost, least overkill within the 5% window)', () => {
    const router = new Router(testConfig, cache, new Map());
    const pool = applyGroupFilters(ALL, testConfig.model_groups!.planning, testConfig);
    const sorted = router.sortBy(pool, 'best');
    expect(sorted[0]).toBe('claude-bridge/claude-sonnet-5-5');
    expect(sorted[1]).toBe('claude-bridge/claude-opus-5-5');
  });
});
