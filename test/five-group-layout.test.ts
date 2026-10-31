// The five-group layout (docs/plans/2026-10-25-category-group-mismatch.md,
// D1-D7, owner decisions 2026-10-25..27). One group per category target,
// named like the category, plus the special groups dynamic / bulk_reader /
// code_writer. The removed groups (trivial, scout, operational, tactical,
// strategic, complex, fallback, and the old standard) are gone; the three
// exits of the former `fallback` group and the tool follow-up step point at
// `simple` (D4); `continue` without a real predecessor goes to `standard`
// (D6); `strategic` is re-pointed to `planning` (D2).
//
// Failover chains are derived mechanically from the old ones: rename
// (operational→standard, tactical→code_complex, scout/fallback→simple),
// removed groups map to their D2/D4 target, self references and duplicates
// drop, order is kept.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORY_TO_GROUP, getGroupForCategory } from '../src/content-classifier.ts';
import { FALLBACK_GROUP_ORDER, getFallbackGroup, Router } from '../src/routing.ts';
import { SessionEscalation } from '../src/escalation.ts';
import { delegationSettings } from '../src/delegation.ts';
import type { Config, Group } from '../src/types.ts';

const shipped = JSON.parse(readFileSync(join(__dirname, '../router-config.json'), 'utf-8')) as Config;
const groups = shipped.model_groups as Record<string, Group>;

const REMOVED = ['trivial', 'scout', 'operational', 'tactical', 'strategic', 'complex', 'fallback'];

describe('category → group mapping (D4, D6, D7)', () => {
  it('every category selects the group named like it; code_simple joins simple; continue → standard', () => {
    expect(CATEGORY_TO_GROUP).toEqual({
      simple: 'simple',
      code_simple: 'simple',
      standard: 'standard',
      code_complex: 'code_complex',
      design: 'design',
      planning: 'planning',
      continue: 'standard',
    });
  });

  it('an unknown category falls to simple (the cheap group), not to a removed group', () => {
    expect(getGroupForCategory('no-such-category')).toBe('simple');
  });
});

describe('shipped groups', () => {
  it('are the five category groups plus the special groups — nothing else', () => {
    expect(Object.keys(groups).sort()).toEqual(
      ['bulk_reader', 'code_complex', 'code_writer', 'design', 'dynamic', 'planning', 'simple', 'standard'],
    );
  });

  it('none of the removed names survives as a group', () => {
    for (const name of REMOVED) expect(groups[name], name).toBeUndefined();
  });

  it('simple: free/cloud-first pool (the old scout), standard: the old operational rule', () => {
    expect(groups.simple).toMatchObject({ method: 'tiered', max_cost: 0, min_gdpval: 0, billing_preference: 'local_before_payg' });
    expect(groups.standard).toMatchObject({ method: 'tiered', min_gdpval: 300, max_cost: 2.0 });
  });

  it('code_complex is the old tactical band; planning keeps 1700 and reasons; design is planning at 1600 on Briefcase (D5)', () => {
    expect(groups.code_complex).toMatchObject({ method: 'best', min_gdpval: 1630, max_gdpval: 1700, score_by: 'coding' });
    // planning ranks by the reasoning blend since 2026-10-31 (owner decision);
    // the floor stays 1700 and models without a value are refused.
    expect(groups.planning).toMatchObject({ method: 'best', min_gdpval: 1700, score_by: 'reasoning', require_score_column: true });
    expect(groups.design).toMatchObject({ method: 'best', min_gdpval: 1600, score_by: 'briefcase' });
  });

  it('failover chains: the old ones, renamed, removed groups mapped, self/duplicates dropped', () => {
    expect(groups.simple.fallback_groups).toEqual(['standard']);
    expect(groups.standard.fallback_groups).toEqual(['simple']);
    expect(groups.code_complex.fallback_groups).toEqual(['planning', 'standard', 'simple']);
    expect(groups.design.fallback_groups).toEqual(['planning', 'code_complex', 'standard', 'simple']);
    expect(groups.planning.fallback_groups).toEqual(['code_complex', 'standard', 'simple']);
    expect(groups.bulk_reader.fallback_groups).toEqual(['standard', 'simple']);
    expect(groups.code_writer.fallback_groups).toEqual(['standard', 'simple']);
  });

  it('every chain entry exists, no group lists itself', () => {
    for (const [name, g] of Object.entries(groups)) {
      for (const fb of g.fallback_groups ?? []) {
        expect(groups[fb], `${name} → ${fb}`).toBeDefined();
        expect(fb, name).not.toBe(name);
      }
    }
  });

  it('delegation protects the top groups (planning was missing — TODO "found on the way")', () => {
    expect(shipped.delegation?.expensive_groups).toEqual(['planning', 'code_complex']);
    expect(delegationSettings({ delegation: { enabled: true } } as Config).expensive_groups).toEqual(['planning', 'code_complex']);
  });
});

describe('code constants follow the layout', () => {
  it('the global fallback order is coarse → cheap over the new names only', () => {
    expect([...FALLBACK_GROUP_ORDER]).toEqual(['planning', 'design', 'code_complex', 'standard', 'simple']);
  });

  it('without a configured chain, the global order walks to the next group', () => {
    const bare: Record<string, Group> = {
      planning: { method: 'best' } as Group,
      design: { method: 'best' } as Group,
      code_complex: { method: 'best' } as Group,
      standard: { method: 'tiered' } as Group,
      simple: { method: 'tiered' } as Group,
    };
    expect(getFallbackGroup('planning', bare, new Set())).toBe('design');
    expect(getFallbackGroup('standard', bare, new Set())).toBe('simple');
    expect(getFallbackGroup('simple', bare, new Set())).toBeNull();
  });

  it('escalation climbs standard → code_complex → planning', () => {
    const esc = new SessionEscalation();
    expect(esc.level).toBe('standard');
  });
});

describe('detectGroup falls to the cheapest group when no score matches', () => {
  it('picks simple (floor 0) for a model without GDPval', () => {
    const cfg = { ...shipped } as Config;
    const router = new Router(cfg, { available_models: [] } as any, new Map());
    expect(router.detectGroup('prov/unknown-model')).toBe('simple');
  });
});
