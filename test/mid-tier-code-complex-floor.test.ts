// test/mid-tier-code-complex-floor.test.ts
//
// Phase 1.4 mid-tier ranking rule (owner decision 2026-10-12, plan
// docs/plans/2026-10-11-category-model-alignment.md §1.4, option
// "C-tactical ~1630"): the `tactical` group (serves the code_complex
// category and the no-history fallback category) gets a hard quality
// floor ABOVE the confirmed free-tail top (ling-3-1-flash 1617.9,
// CONFIRMED real AA row by the Task-0 identity audit) and BELOW the flat
// Mistral subscription tank (zai-glm-5-3 ~1650). Effect: hard code work
// and history-less prompts run on the subscription tank instead of the
// free tail, while standard/simple/exploration keep the free tail and
// design/planning keep the strategic window.
//
// The floor value is drift-tuned (simulation F3: scores move between
// scrapes — ling scored 1621.75 on 10-09 and 1617.9 on 10-10):
//   1630 > every observed ling value (1617.9 / 1621.75)
//   1630 < every observed glm-5-3 value (1650.73 / 1652.93)
// It must be re-checked when either score drifts across it.
//
// Evidence for the behaviour change (delegate simulation 2026-10-12,
// /tmp/catplan/sim-report-A-D.md, replica valid 845/845 sweeps +
// 97/97 prompts): today the free tail wins tactical in 67-80% of
// sweeps (ling within the 5% best-quality window of glm, cost tie →
// least-overkill tiebreak picks the LOWER score). With the floor, glm
// is the only candidate in [1630, 1700] and wins ~100% — when it is
// exhausted/unhealthy, tactical falls through to its fallback chain
// (strategic → sonnet), never to the free tail.
//
// All assertions were observed RED against the unfixed implementation
// (min_gdpval 600) before the config change landed (AGENTS.md §4).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { Router, applyGroupFilters } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

const SHIPPED_CONFIG: Config = JSON.parse(readFileSync('router-config.json', 'utf-8'));

// Production-shaped fixture: the CONFIRMED free-tail top and the
// subscription tank, both carrying the scan's free-tier placeholder cost
// (simulation F1: both sort into tier 0, so cost CANNOT separate them —
// only the floor can).
const testConfig: Config = {
  ...SHIPPED_CONFIG,
  model_metrics: {
    'openrouter/inclusionai/ling-3.1-flash': { cost_per_m: 0, gdpval: 1617.9, throughput_tps: 100, avg_latency_ms: 500 },
    'mistral/zai-glm-5-3': { cost_per_m: 0, gdpval: 1650.73, throughput_tps: 60, avg_latency_ms: 1200 },
  },
  gdpval_builtin: {
    'ling-3-1-flash': 1617.9,
    'zai-glm-5-3': 1650.73,
    'future-free-1655': 1655,
  },
} as any;

const cache: Cache = { available_models: [] } as any;

beforeAll(() => {
  metricsModule.setConfig(testConfig);
  metricsModule.setCache(cache);
  metricsModule.setModelRegistry({ find: () => undefined } as any);
});

const POOL = ['openrouter/inclusionai/ling-3.1-flash', 'mistral/zai-glm-5-3'];

describe('mid-tier floor (Phase 1.4, owner decision 2026-10-12)', () => {
  it('the shipped tactical floor sits above the free tail (config pin)', () => {
    const tactical = SHIPPED_CONFIG.model_groups!.tactical;
    expect(tactical.min_gdpval).toBeGreaterThanOrEqual(1630);
    // The floor must stay below the subscription tank's observed range too,
    // otherwise tactical falls through to strategic on EVERY prompt.
    expect(tactical.min_gdpval).toBeLessThanOrEqual(1640);
  });

  it('the floor excludes the free tail from the tactical pool (applyGroupFilters)', () => {
    const filtered = applyGroupFilters(POOL, SHIPPED_CONFIG.model_groups!.tactical, testConfig);
    expect(filtered).toContain('mistral/zai-glm-5-3');
    expect(filtered).not.toContain('openrouter/inclusionai/ling-3.1-flash');
  });

  it('the subscription tank wins tactical even under the 5% window (sortBy best)', () => {
    // Before the floor: both in the window of 1650.73 (floor 1568.19),
    // cost ties at 0 → the least-overkill tiebreak picked the LOWER score
    // (ling) — the free tail won the mid tier. With the floor, ling is
    // filtered before sorting and glm is the pool.
    const router = new Router(testConfig, cache, new Map());
    const filtered = applyGroupFilters(POOL, SHIPPED_CONFIG.model_groups!.tactical, testConfig);
    const sorted = router.sortBy(filtered, 'best');
    expect(sorted[0]).toBe('mistral/zai-glm-5-3');
  });

  it('a model that beats the floor on merit stays admissible (no free-tail-only rule)', () => {
    // The floor is a quality gate, not a vendor gate: a hypothetical
    // free model scoring 1650 would pass it (derivation, not a model
    // list — ADR-0025).
    const pool = ['openrouter/hypothetical/future-free-1655'];
    const filtered = applyGroupFilters(pool, SHIPPED_CONFIG.model_groups!.tactical, testConfig);
    expect(filtered).toContain('openrouter/hypothetical/future-free-1655');
  });
});
