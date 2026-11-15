// `planning` is gated by reasoning, not by a GDPval floor (owner decision
// 2026-11-15). Before this change the group required `min_gdpval: 1700`, so the
// model with the best reasoning score in the cache (70.51) was excluded for
// having GDPval 1545.68 — the floor, not the ranking, decided membership. The
// floor is gone; `score_by: reasoning`, `require_score_column` and `min_score`
// remain, so the group is still the reasoning tier and not "every model".

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';

const SHIPPED = JSON.parse(
  fs.readFileSync(new URL('../router-config.json', import.meta.url), 'utf-8')
) as any;

const FABLE = 'claude-bridge/claude-fable-5-2'; // GDP 1546, reasoning 70.5
const OPUS = 'claude-bridge/claude-opus-5-5'; // GDP 1900, reasoning 58.4
const WEAK = 'claude-bridge/claude-weak-9'; // GDP 1900, reasoning 30

const BASE_CONFIG = {
  model_groups: {},
  model_metrics: {
    [FABLE]: { cost_per_m: 8e-6, throughput_tps: 100, avg_latency_ms: 1000 },
    [OPUS]: { cost_per_m: 2e-6, throughput_tps: 100, avg_latency_ms: 1000 },
    [WEAK]: { cost_per_m: 1e-6, throughput_tps: 100, avg_latency_ms: 1000 },
  },
  providers: {},
  gdpval_builtin: { 'claude-fable-5-2': 1545.68, 'claude-opus-5-5': 1900, 'claude-weak-9': 1900 },
  best_quality_window: 0.05,
} as any;

async function fresh(profiles: Record<string, any>, groups: Record<string, any>) {
  vi.resetModules();
  const metrics = await import('../src/metrics.js');
  const routing = await import('../src/routing.js');
  const cfg = { ...BASE_CONFIG, model_groups: groups };
  metrics.setConfig(cfg);
  metrics.setCache({ available_models: [], capability_profiles: profiles } as any);
  metrics.setModelRegistry({ find: () => undefined } as any);
  return { routing, cfg };
}

describe('the shipped planning group', () => {
  it('has no GDPval floor and keeps the reasoning gates', () => {
    const planning = SHIPPED.model_groups.planning;
    expect(planning.min_gdpval).toBeUndefined();
    expect(planning).toMatchObject({
      method: 'best',
      score_by: 'reasoning',
      require_score_column: true,
      min_score: 35,
    });
  });

  it('does not describe a GDPval floor it no longer has', () => {
    expect(SHIPPED.model_groups.planning.description).not.toMatch(/GDPval\s*>=/);
  });
});

describe('planning admits by reasoning, not by GDPval', () => {
  beforeEach(() => vi.resetModules());

  it('admits the best reasoning model even below the old 1700 floor', async () => {
    const planning = SHIPPED.model_groups.planning;
    const { routing, cfg } = await fresh(
      { 'claude-fable-5-2': { reasoning: 70.51 }, 'claude-opus-5-5': { reasoning: 58.38 } },
      { planning }
    );
    expect(routing.applyGroupFilters([FABLE, OPUS], planning, cfg)).toEqual([FABLE, OPUS]);
  });

  it('still refuses a high-GDPval model below the reasoning floor', async () => {
    const planning = SHIPPED.model_groups.planning;
    const { routing, cfg } = await fresh(
      { 'claude-fable-5-2': { reasoning: 70.51 }, 'claude-weak-9': { reasoning: 30 } },
      { planning }
    );
    const dropped: Array<[string, string]> = [];
    const kept = routing.applyGroupFilters(
      [FABLE, WEAK],
      planning,
      cfg,
      false,
      undefined,
      undefined,
      (r, g) => dropped.push([r, g])
    );
    expect(kept).toEqual([FABLE]);
    expect(dropped).toEqual([[WEAK, 'min_score']]);
  });
});
