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
// Mechanism: a dedicated `planning` group with min_gdpval 1700 — above
// glm-5-3 (1644) and mistral-medium-3.5 (933), below claude-sonnet-5-5
// (1844) and claude-opus-5-5 (1900). The floor — not a provider exclusion —
// is the guarantee: a future GPT/Gemini flagship scoring above 1700
// auto-qualifies without config changes. Escalation (Claude window empty,
// all planning models failed) goes strategic → tactical → glm as the
// emergency fallback, per the group's fallback_groups.

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
    strategic: repoCfg.model_groups!.strategic,
    tactical: repoCfg.model_groups!.tactical,
  },
  model_metrics: {
    'claude-bridge/claude-opus-5-5': { cost_per_m: 1.5e-6, throughput_tps: 100, avg_latency_ms: 1000 },
    'claude-bridge/claude-sonnet-5-5': { cost_per_m: 1.5e-6, throughput_tps: 100, avg_latency_ms: 1000 },
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

describe('shipped config: the planning group exists and is top-tier-only by floor', () => {
  it('router-config.json defines planning with min_gdpval >= 1700 and method best', () => {
    const g = repoCfg.model_groups!.planning;
    expect(g).toBeDefined();
    expect(g.method).toBe('best');
    expect(g.min_gdpval!).toBeGreaterThanOrEqual(1700);
  });

  it('escalation chain never dead-ends: fallback_groups are declared', () => {
    const g = repoCfg.model_groups!.planning;
    expect(g.fallback_groups).toBeDefined();
    expect(g.fallback_groups!.length).toBeGreaterThan(0);
    expect(g.fallback_groups![0]).toBe('strategic');
  });
});

describe('CATEGORY_TO_GROUP: design and planning route to the planning group', () => {
  it('design → planning (not tactical)', () => {
    expect(CATEGORY_TO_GROUP.design).toBe('planning');
  });
  it('planning → planning (not tactical)', () => {
    expect(CATEGORY_TO_GROUP.planning).toBe('planning');
  });
  it('code_complex stays tactical (glm free tank keeps the coding daily load)', () => {
    expect(CATEGORY_TO_GROUP.code_complex).toBe('tactical');
  });
});

describe('planning group filtering: glm and mistral-medium are FLAT OUT', () => {
  it('the floor admits only sonnet/opus; glm (1644) and medium (933) fail', () => {
    const filtered = applyGroupFilters(ALL, testConfig.model_groups!.planning, testConfig);
    expect(filtered).toContain('claude-bridge/claude-sonnet-5-5');
    expect(filtered).toContain('claude-bridge/claude-opus-5-5');
    expect(filtered).not.toContain('mistral/zai-glm-5-3');
    expect(filtered).not.toContain('mistral/mistral-medium-3.5');
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
