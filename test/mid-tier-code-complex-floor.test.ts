// test/mid-tier-code-complex-floor.test.ts
//
// Phase 1.4 mid-tier ranking rule (owner decision 2026-10-12, plan
// docs/plans/2026-10-11-category-model-alignment.md §1.4, option
// "C-tactical ~1630"): the `code_complex` group (serves the code_complex
// category and the no-history fallback category) gets a hard quality
// floor ABOVE the confirmed free-tail top (ling-3-1-flash 1617.9,
// CONFIRMED real AA row by the Task-0 identity audit) and BELOW the flat
// Mistral subscription tank (zai-glm-5-3 ~1650). Effect: hard code work
// and history-less prompts run on the subscription tank instead of the
// free tail, while standard/simple/exploration keep the free tail and
// design/planning keep the top-tier window.
//
// The floor value is drift-tuned (simulation F3: scores move between
// scrapes — ling scored 1621.75 on 10-09 and 1617.9 on 10-10):
//   1630 > every observed ling value (1617.9 / 1621.75)
//   1630 < every observed glm-5-3 value (1650.73 / 1652.93)
// It must be re-checked when either score drifts across it.
//
// Evidence for the behaviour change (delegate simulation 2026-10-12,
// /tmp/catplan/sim-report-A-D.md, replica valid 845/845 sweeps +
// 97/97 prompts): today the free tail wins code_complex in 67-80% of
// sweeps (ling within the 5% best-quality window of glm, cost tie →
// least-overkill tiebreak picks the LOWER score). With the floor, glm
// is the only candidate in [1630, 1700] and wins ~100% — when it is
// exhausted/unhealthy, code_complex falls through to its fallback chain
// (planning → sonnet), never to the free tail.
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
  it('the shipped code_complex floor sits above the free tail (config pin)', () => {
    const code_complex = SHIPPED_CONFIG.model_groups!.code_complex;
    expect(code_complex.min_gdpval).toBeGreaterThanOrEqual(1630);
    // The floor must stay below the subscription tank's observed range too,
    // otherwise code_complex falls through to planning on EVERY prompt.
    expect(code_complex.min_gdpval).toBeLessThanOrEqual(1640);
  });

  it('the floor excludes the free tail from the code_complex pool (applyGroupFilters)', () => {
    const filtered = applyGroupFilters(POOL, SHIPPED_CONFIG.model_groups!.code_complex, testConfig);
    expect(filtered).toContain('mistral/zai-glm-5-3');
    expect(filtered).not.toContain('openrouter/inclusionai/ling-3.1-flash');
  });

  it('the subscription tank wins code_complex even under the 5% window (sortBy best)', () => {
    // NON-VACUOUS pool (Sourcery PR #67 round): two candidates survive the
    // floor (glm 1650.73 and a hypothetical free 1655). Window floor =
    // 1655 * 0.95 = 1572.25 → both in; costs tie at 0 → the least-overkill
    // tiebreak picks the LOWER score → glm. A broken sortBy that ignores
    // 'best' would rank the 1655 model first, so this actually exercises
    // the window semantics.
    const router = new Router(testConfig, cache, new Map());
    const pool = [...POOL, 'openrouter/hypothetical/future-free-1655'];
    const filtered = applyGroupFilters(pool, SHIPPED_CONFIG.model_groups!.code_complex, testConfig);
    expect(filtered).toHaveLength(2); // ling excluded, both above-floor models kept
    const sorted = router.sortBy(filtered, 'best');
    expect(sorted[0]).toBe('mistral/zai-glm-5-3');
  });

  it('an unhealthy primary falls through the chain to a healthy candidate (owner-approved promise)', () => {
    // The owner-approved Phase 1.4 rule: "when the tank is capped/krank,
    // code_complex falls through the chain" — NOT to the failing tank.
    // demoteUnhealthy keeps unhealthy models in the pool, so a singleton
    // tactical pool would keep serving the broken tank; resolve() must
    // prefer the first HEALTHY selection across the fallback chain. Health
    // self-decays (HEALTH_DECAY_MS 15 min), so the tank returns to duty on
    // its own — no death spiral.
    const unhealthyCache = {
      available_models: [
        { id: 'inclusionai/ling-3.1-flash', provider: 'openrouter', cost_per_m: 0 },
        { id: 'zai-glm-5-3', provider: 'mistral', cost_per_m: 0 },
      ],
      model_health: { 'mistral/zai-glm-5-3': { fails: 3, last_fail: Date.now() } },
    } as any;
    const router = new Router(testConfig, unhealthyCache, new Map());
    const res = router.resolve('code_complex');
    expect(res).not.toBeNull();
    expect(res!.selected).not.toBe('mistral/zai-glm-5-3');
  });

  it('with no healthy alternative anywhere, the unhealthy primary is still served (fail-open)', () => {
    const unhealthyCache = {
      available_models: [
        { id: 'inclusionai/ling-3.1-flash', provider: 'openrouter', cost_per_m: 0 },
        { id: 'zai-glm-5-3', provider: 'mistral', cost_per_m: 0 },
      ],
      model_health: {
        'mistral/zai-glm-5-3': { fails: 3, last_fail: Date.now() },
        'openrouter/inclusionai/ling-3.1-flash': { fails: 3, last_fail: Date.now() },
      },
    } as any;
    const router = new Router(testConfig, unhealthyCache, new Map());
    const res = router.resolve('code_complex');
    // Everything is broken → better a failing model than none (in-turn
    // failover still handles the rest).
    expect(res?.selected).toBe('mistral/zai-glm-5-3');
  });

  it('a model that beats the floor on merit stays admissible (no free-tail-only rule)', () => {
    // The floor is a quality gate, not a vendor gate: a hypothetical
    // free model scoring 1650 would pass it (derivation, not a model
    // list — ADR-0025).
    const pool = ['openrouter/hypothetical/future-free-1655'];
    const filtered = applyGroupFilters(pool, SHIPPED_CONFIG.model_groups!.code_complex, testConfig);
    expect(filtered).toContain('openrouter/hypothetical/future-free-1655');
  });
});
