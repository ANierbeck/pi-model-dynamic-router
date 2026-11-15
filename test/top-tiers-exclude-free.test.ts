// Owner decision 2026-11-15 (user-config review): the top-tier groups design and
// planning ship `exclude_models: ["*:free"]` — free-tier refs never reach the
// top tiers regardless of their capability-column values. simple keeps
// max_cost: 0 (free models belong there), standard/code_complex unchanged.
// Promoted from the owner's router-config.user.json.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { freshCapabilityFilters } from './helpers/capability-filters.ts';

const SHIPPED = JSON.parse(
  fs.readFileSync(new URL('../router-config.json', import.meta.url), 'utf-8')
) as any;

const FREE = 'openrouter/some/cool-model:free';
const PAID = 'mistral/mistral-large-4';

const BASE_CONFIG = {
  model_groups: {},
  model_metrics: {
    [FREE]: { cost_per_m: 0, throughput_tps: 100, avg_latency_ms: 1000 },
    [PAID]: { cost_per_m: 0.4, throughput_tps: 80, avg_latency_ms: 900 },
  },
  providers: {},
  gdpval_builtin: { 'some-cool-model': 1850, 'mistral-large-4': 1800 },
  best_quality_window: 0.05,
} as any;

describe('shipped config: design and planning exclude :free', () => {
  it('both top-tier groups ship exclude_models ["*:free"]', () => {
    expect(SHIPPED.model_groups.design.exclude_models).toEqual(['*:free']);
    expect(SHIPPED.model_groups.planning.exclude_models).toEqual(['*:free']);
  });

  it('simple keeps max_cost: 0 (free models belong there), standard/code_complex unchanged', () => {
    expect(SHIPPED.model_groups.simple.max_cost).toBe(0);
    expect(SHIPPED.model_groups.standard.exclude_models ?? []).not.toContain('*:free');
    expect(SHIPPED.model_groups.code_complex.exclude_models ?? []).not.toContain('*:free');
  });
});

describe('routing effect', () => {
  beforeEach(() => vi.resetModules());

  it('a :free model with a top capability score is OUT of planning and design, IN simple', async () => {
    const groups = {
      simple: SHIPPED.model_groups.simple,
      standard: SHIPPED.model_groups.standard,
      code_complex: SHIPPED.model_groups.code_complex,
      design: SHIPPED.model_groups.design,
      planning: SHIPPED.model_groups.planning,
    };
    // the free model has the best reasoning score — without the exclusion it
    // would win planning; the glob must keep it out anyway
    const profiles = {
      'some-cool-model': { reasoning: 80, briefcase: 1900 },
      'mistral-large-4': { reasoning: 50, briefcase: 1800 },
    };
    const { routing, cfg } = await freshCapabilityFilters(profiles, groups, BASE_CONFIG);
    const all = [FREE, PAID];
    expect(routing.applyGroupFilters(all, groups.planning, cfg)).toEqual([PAID]);
    expect(routing.applyGroupFilters(all, groups.design, cfg)).toEqual([PAID]);
    expect(routing.applyGroupFilters(all, groups.simple, cfg)).toContain(FREE);
  });

  it('a paid model still enters planning by its reasoning score', async () => {
    const groups = { planning: SHIPPED.model_groups.planning };
    const profiles = { 'mistral-large-4': { reasoning: 50 } };
    const { routing, cfg } = await freshCapabilityFilters(profiles, groups, BASE_CONFIG);
    expect(routing.applyGroupFilters([FREE, PAID], groups.planning, cfg)).toEqual([PAID]);
  });
});
