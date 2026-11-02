// Target layout of the 5-group plan (docs/plans/2026-10-25-category-group-mismatch.md,
// Step 2): the target layout as a pure config transform, and the category →
// target group mapping (D4, D5, D7). Synthetic fixtures only. The replay driver
// is not written yet; see docs/research/2026-10-27-pool-replay.md.

import { describe, it, expect } from 'vitest';
import { targetLayout, targetGroupFor } from '../scripts/pool-replay.ts';

const shipped = {
  model_groups: {
    scout: { method: 'tiered', billing_preference: 'cloud_first', max_cost: 0, min_gdpval: 0, fallback_groups: ['fallback'] },
    operational: { method: 'tiered', min_gdpval: 300, max_cost: 2.0, fallback_groups: ['standard', 'scout'] },
    tactical: { method: 'best', min_gdpval: 1630, max_gdpval: 1700, score_by: 'coding', fallback_groups: ['strategic'] },
    planning: { method: 'best', min_gdpval: 1700, score_by: 'briefcase', fallback_groups: ['strategic', 'tactical'] },
    strategic: { method: 'best', min_gdpval: 700 },
    standard: { method: 'tiered', min_gdpval: 500, max_cost: 5.0 },
    dynamic: { method: 'dynamic' },
  },
} as any;

describe('targetLayout', () => {
  const t = targetLayout(shipped);

  it('ships exactly the five category groups plus dynamic', () => {
    expect(Object.keys(t.model_groups).sort()).toEqual(['code_complex', 'design', 'planning', 'simple', 'standard', 'dynamic'].sort());
  });

  it('standard is operational\'s definition (the old standard group is replaced)', () => {
    expect(t.model_groups.standard).toEqual({ ...shipped.model_groups.operational, fallback_groups: [] });
  });

  it('simple is scout\'s definition: the equivalence note found them identical', () => {
    expect(t.model_groups.simple).toEqual({ ...shipped.model_groups.scout, fallback_groups: [] });
  });

  it('code_complex is tactical\'s definition', () => {
    expect(t.model_groups.code_complex).toEqual({ ...shipped.model_groups.tactical, fallback_groups: [] });
  });

  it('planning keeps the 1700 floor; design is planning with the 1600 floor (D5)', () => {
    expect(t.model_groups.planning).toEqual({ ...shipped.model_groups.planning, fallback_groups: [] });
    expect(t.model_groups.design).toEqual({ ...shipped.model_groups.planning, min_gdpval: 1600, fallback_groups: [] });
  });

  it('keeps dynamic as it is', () => {
    expect(t.model_groups.dynamic).toEqual(shipped.model_groups.dynamic);
  });

  it('does not mutate the shipped config', () => {
    expect(shipped.model_groups.standard.min_gdpval).toBe(500);
    expect(shipped.model_groups.planning.min_gdpval).toBe(1700);
    expect(Object.keys(shipped.model_groups)).toContain('strategic');
  });
});

describe('targetGroupFor', () => {
  it('maps each category to the group that carries its name (D4, D7)', () => {
    expect(targetGroupFor('simple')).toBe('simple');
    expect(targetGroupFor('code_simple')).toBe('simple');
    expect(targetGroupFor('standard')).toBe('standard');
    expect(targetGroupFor('code_complex')).toBe('code_complex');
    expect(targetGroupFor('design')).toBe('design');
    expect(targetGroupFor('planning')).toBe('planning');
  });

  it('continue is not replayed here: D6 depends on the predecessor, which the join does not carry', () => {
    expect(targetGroupFor('continue')).toBeNull();
  });
});
