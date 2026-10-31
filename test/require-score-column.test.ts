// test/require-score-column.test.ts
// `require_score_column`: a group that ranks by a capability column can also
// REFUSE models that have no value in it ("a model that does not support this
// does not belong in this category", owner 2026-10-31). Default off — the
// ranking rule stays "unprofiled models rank last" (owner 2026-10-26).
//
// Safety valve: when NO model has a value for the column (the scrape never
// ran, failed, or the payload drifted) the gate stands down. Otherwise a
// stale or offline install would have an empty planning group while the
// built-in GDPval floor could still serve it.
//
// Every test gets fresh module state (the metrics mirror of the capability
// profiles is additive across setCache calls, so "no data anywhere" cannot be
// staged in a shared module).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const OPUS = 'claude-bridge/claude-opus-5-5';
const SONNET = 'claude-bridge/claude-sonnet-5-5';
const NEWCOMER = 'claude-bridge/claude-newcomer-9';

const BASE_CONFIG = {
  model_groups: {},
  model_metrics: {
    [OPUS]: { cost_per_m: 2e-6, throughput_tps: 100, avg_latency_ms: 1000 },
    [SONNET]: { cost_per_m: 1.5e-6, throughput_tps: 100, avg_latency_ms: 1000 },
    [NEWCOMER]: { cost_per_m: 1e-6, throughput_tps: 100, avg_latency_ms: 1000 },
  },
  providers: {},
  // GDPval order is the REVERSE of the reasoning order (newcomer > sonnet >
  // opus): only the column, never the GDPval fallback, can put opus first.
  gdpval_builtin: { 'claude-opus-5-5': 1900, 'claude-sonnet-5-5': 1950, 'claude-newcomer-9': 2000 },
  best_quality_window: 0.05,
} as any;

async function fresh(profiles: Record<string, any>, groups: Record<string, any>) {
  vi.resetModules();
  const metrics = await import('../src/metrics.js');
  const routing = await import('../src/routing.js');
  const dyn = await import('../src/dynamic-config.js');
  const cfg = { ...BASE_CONFIG, model_groups: groups };
  metrics.setConfig(cfg);
  metrics.setCache({ available_models: [], capability_profiles: profiles } as any);
  metrics.setModelRegistry({ find: () => undefined } as any);
  return { metrics, routing, dyn, cfg };
}

const PLANNING = { method: 'best', min_gdpval: 1700, score_by: 'reasoning', fallback_groups: [] };

describe('require_score_column in applyGroupFilters (live and display path)', () => {
  beforeEach(() => vi.resetModules());

  it('off by default: a model without the value stays in the pool', async () => {
    const { routing, cfg } = await fresh(
      { 'claude-opus-5-5': { reasoning: 56 }, 'claude-sonnet-5-5': { reasoning: 46 } },
      { planning: PLANNING },
    );
    const kept = routing.applyGroupFilters([OPUS, SONNET, NEWCOMER], PLANNING as any, cfg);
    expect(kept).toContain(NEWCOMER);
  });

  it('on: a model without a value in the group column is dropped, and the gate is named', async () => {
    const group = { ...PLANNING, require_score_column: true };
    const { routing, cfg } = await fresh(
      { 'claude-opus-5-5': { reasoning: 56 }, 'claude-sonnet-5-5': { reasoning: 46 } },
      { planning: group },
    );
    const dropped: Array<[string, string]> = [];
    const kept = routing.applyGroupFilters([OPUS, SONNET, NEWCOMER], group as any, cfg, false, undefined, undefined, (r, g) => dropped.push([r, g]));
    expect(kept).toEqual([OPUS, SONNET]);
    expect(dropped).toEqual([[NEWCOMER, 'require_score_column']]);
  });

  it('on: the column is the group\'s own — a briefcase-only value does not satisfy a reasoning group', async () => {
    const group = { ...PLANNING, require_score_column: true };
    const { routing, cfg } = await fresh(
      { 'claude-opus-5-5': { reasoning: 56 }, 'claude-newcomer-9': { briefcase: 1700 } },
      { planning: group },
    );
    expect(routing.applyGroupFilters([OPUS, NEWCOMER], group as any, cfg)).toEqual([OPUS]);
  });

  it('on, but NO model anywhere has the column: the gate stands down', async () => {
    const group = { ...PLANNING, require_score_column: true };
    const { routing, cfg } = await fresh({ 'claude-opus-5-5': { briefcase: 1800 } }, { planning: group });
    expect(routing.applyGroupFilters([OPUS, SONNET], group as any, cfg)).toEqual([OPUS, SONNET]);
  });

  it('on, with a gdpval group (no capability column): nothing to require, nothing dropped', async () => {
    const group = { method: 'best', min_gdpval: 1700, require_score_column: true, fallback_groups: [] };
    const { routing, cfg } = await fresh({ 'claude-opus-5-5': { reasoning: 56 } }, { standard: group });
    expect(routing.applyGroupFilters([OPUS, NEWCOMER], group as any, cfg)).toEqual([OPUS, NEWCOMER]);
  });

  it('the live router resolves planning to the profiled models only', async () => {
    const group = { ...PLANNING, require_score_column: true };
    const { routing, cfg } = await fresh(
      { 'claude-opus-5-5': { reasoning: 56 }, 'claude-sonnet-5-5': { reasoning: 46 } },
      { planning: group },
    );
    const cache = {
      available_models: [
        { provider: 'claude-bridge', id: 'claude-opus-5-5' },
        { provider: 'claude-bridge', id: 'claude-sonnet-5-5' },
        { provider: 'claude-bridge', id: 'claude-newcomer-9' },
      ],
      capability_profiles: { 'claude-opus-5-5': { reasoning: 56 }, 'claude-sonnet-5-5': { reasoning: 46 } },
    } as any;
    const res = new routing.Router(cfg, cache, new Map()).resolve('planning');
    expect(res?.candidates).not.toContain(NEWCOMER);
    expect(res?.selected).toBe(OPUS);
  });
});

describe('require_score_column in the persist path (generated dynamic config)', () => {
  beforeEach(() => vi.resetModules());

  const model = (ref: string, gdpval: number) =>
    ({ ref, gdpval, cost: 1, price: null, contextWindow: 1_000_000, isFreeModel: false }) as any;

  it('filterModelsForGroup applies the same gate as the live path', async () => {
    const group = { ...PLANNING, require_score_column: true };
    const { dyn, cfg } = await fresh(
      { 'claude-opus-5-5': { reasoning: 56 }, 'claude-sonnet-5-5': { reasoning: 46 } },
      { planning: group },
    );
    const kept = dyn.filterModelsForGroup([model(OPUS, 1900), model(SONNET, 1950), model(NEWCOMER, 2000)], group as any, cfg);
    expect(kept.map((m: any) => m.ref)).toEqual([OPUS, SONNET]);
  });

  it('sortModelsForGroup ranks by reasoning with unprofiled models last', async () => {
    const { dyn, cfg, metrics } = await fresh(
      { 'claude-opus-5-5': { reasoning: 56 }, 'claude-sonnet-5-5': { reasoning: 46 } },
      { planning: PLANNING },
    );
    // GDPval order is the REVERSE of the expected one (newcomer > sonnet >
    // opus), so only the column can produce [opus, sonnet, newcomer].
    const sorted = dyn.sortModelsForGroup(
      [model(NEWCOMER, 2000), model(SONNET, 1950), model(OPUS, 1900)],
      PLANNING as any,
      cfg,
      metrics.calculateScore,
    );
    expect(sorted.map((m: any) => m.ref)).toEqual([OPUS, SONNET, NEWCOMER]);
  });
});


// ── min_score: a floor on the group's own capability column ───────────────
// Owner decision 2026-10-31: GDPval alone let a fast "Flash" model into
// planning (GDPval 1746, but Intelligence Index 32 and Omniscience 0.9 — the
// reasoning blend ranks it near last). Floors admit on GDPval; this adds the
// missing floor on the column the group actually ranks by.

describe('min_score (floor on the score_by column)', () => {
  beforeEach(() => vi.resetModules());

  const PROFILES = {
    'claude-opus-5-5': { reasoning: 58 },
    'claude-sonnet-5-5': { reasoning: 46 },
    'claude-newcomer-9': { reasoning: 19.5 },
  };
  const group = (extra: Record<string, unknown> = {}) => ({ ...PLANNING, ...extra });

  it('drops a model whose column value is below the floor, and names the gate', async () => {
    const g = group({ min_score: 35 });
    const { routing, cfg } = await fresh(PROFILES, { planning: g });
    const dropped: Array<[string, string]> = [];
    const kept = routing.applyGroupFilters([OPUS, SONNET, NEWCOMER], g as any, cfg, false, undefined, undefined, (r, n) => dropped.push([r, n]));
    expect(kept).toEqual([OPUS, SONNET]);
    expect(dropped).toEqual([[NEWCOMER, 'min_score']]);
  });

  it('a value exactly at the floor passes (>=, like min_gdpval)', async () => {
    const g = group({ min_score: 46 });
    const { routing, cfg } = await fresh(PROFILES, { planning: g });
    expect(routing.applyGroupFilters([OPUS, SONNET, NEWCOMER], g as any, cfg)).toEqual([OPUS, SONNET]);
  });

  it('a model WITHOUT a value fails a positive floor (null fails, like min_gdpval)', async () => {
    const g = group({ min_score: 35 });
    const { routing, cfg } = await fresh({ 'claude-opus-5-5': { reasoning: 58 } }, { planning: g });
    expect(routing.applyGroupFilters([OPUS, SONNET], g as any, cfg)).toEqual([OPUS]);
  });

  it('absent or 0 means no floor', async () => {
    for (const extra of [{}, { min_score: 0 }]) {
      const g = group(extra);
      const { routing, cfg } = await fresh(PROFILES, { planning: g });
      expect(routing.applyGroupFilters([OPUS, SONNET, NEWCOMER], g as any, cfg)).toEqual([OPUS, SONNET, NEWCOMER]);
    }
  });

  it('stands down while NO model has a value for the column (no scrape yet)', async () => {
    const g = group({ min_score: 35 });
    const { routing, cfg } = await fresh({ 'claude-opus-5-5': { briefcase: 1800 } }, { planning: g });
    expect(routing.applyGroupFilters([OPUS, SONNET], g as any, cfg)).toEqual([OPUS, SONNET]);
  });

  it('has no effect on a group that ranks by GDPval (no capability column to compare)', async () => {
    const g = { method: 'best', min_gdpval: 1700, min_score: 35, fallback_groups: [] };
    const { routing, cfg } = await fresh(PROFILES, { standard: g });
    expect(routing.applyGroupFilters([OPUS, NEWCOMER], g as any, cfg)).toEqual([OPUS, NEWCOMER]);
  });

  it('the live router and the generated config both honour it', async () => {
    const g = group({ min_score: 35 });
    const { routing, dyn, cfg } = await fresh(PROFILES, { planning: g });
    const cache = {
      available_models: [
        { provider: 'claude-bridge', id: 'claude-opus-5-5' },
        { provider: 'claude-bridge', id: 'claude-sonnet-5-5' },
        { provider: 'claude-bridge', id: 'claude-newcomer-9' },
      ],
      capability_profiles: PROFILES,
    } as any;
    expect(new routing.Router(cfg, cache, new Map()).resolve('planning')?.candidates).not.toContain(NEWCOMER);
    const m = (ref: string, gdpval: number) => ({ ref, gdpval, cost: 1, price: null, contextWindow: 1_000_000, isFreeModel: false }) as any;
    const kept = dyn.filterModelsForGroup([m(OPUS, 1900), m(SONNET, 1950), m(NEWCOMER, 2000)], g as any, cfg);
    expect(kept.map((x: any) => x.ref)).toEqual([OPUS, SONNET]);
  });
});
