// test/group-filter-boundaries.test.ts — nightly R1 triage (2026-10-07),
// routing.ts applyGroupFilters. The gates are the incident class of this
// router (13/148 scoring collapse, dead candidates in cheap groups), yet the
// nightly found every threshold boundary, every "gate absent = pass-through"
// guard and the dedup opt-in unpinned. Everything here drives the pure
// function through injected lookups, so the assertions are about the gate
// rules only.
//
//   - no gate configured → pass-through (unscored refs included)
//   - thresholds are INCLUSIVE: min_gdpval, min_gdpval_pct, max_gdpval,
//     max_cost, max_cost_per_m, min_context_length
//   - max_gdpval is strict null-fails: an unscored ref is dropped by a positive cap
//   - min_gdpval_pct: 0 is "no gate", an unscored ref survives it
//   - max_cost > 0: a free ref passes even with an unknown cost; a priced
//     pay_per_token ref under the cap passes; unknown + pay_per_token drops
//   - max_cost_per_m: an incomplete price drops
//   - dedup runs only when requested AND a dedup function exists
//   - onDrop reports the gate that removed each ref (the /router debug line)

import { describe, it, expect } from 'vitest';
import { applyGroupFilters, type GroupFilterLookups } from '../src/routing.ts';
import type { Config, Group } from '../src/types.ts';

const CFG = {
  model_groups: {},
  model_metrics: {},
  providers: {
    cheap: { billing: 'pay_per_token' },
    sub: { billing: 'subscription' },
  },
} as any as Config;

type Row = {
  gdp?: number | null;
  cost?: number | 'unknown';
  price?: { input: number | 'unknown'; output: number | 'unknown' } | null;
  cw?: number | null;
  free?: boolean;
};

function lookups(rows: Record<string, Row>): GroupFilterLookups {
  const row = (ref: string): Row => rows[ref] ?? {};
  return {
    gdp: (ref) => row(ref).gdp ?? null,
    cost: (ref) => row(ref).cost ?? 'unknown',
    price: (ref) => row(ref).price ?? null,
    contextWindow: (ref) => row(ref).cw ?? null,
    isFree: (ref) => row(ref).free ?? false,
  };
}

const run = (refs: string[], g: Partial<Group>, rows: Record<string, Row>) =>
  applyGroupFilters(refs, { method: 'best', ...g } as Group, CFG, false, undefined, lookups(rows));

describe('applyGroupFilters — no gate configured', () => {
  it('passes every ref through, unscored and unpriced ones included', () => {
    const refs = ['cheap/a', 'sub/b', 'cheap/c'];
    expect(run(refs, {}, {})).toEqual(refs);
  });

  it('min_gdpval_pct: 0 is no gate — an unscored ref survives it', () => {
    const refs = ['cheap/scored', 'cheap/unscored'];
    expect(run(refs, { min_gdpval_pct: 0 }, { 'cheap/scored': { gdp: 100 } })).toEqual(refs);
  });
});

describe('applyGroupFilters — thresholds are inclusive', () => {
  it('min_gdpval keeps a ref scoring exactly the floor', () => {
    const out = run(['cheap/at', 'cheap/below'], { min_gdpval: 500 }, { 'cheap/at': { gdp: 500 }, 'cheap/below': { gdp: 499.9 } });
    expect(out).toEqual(['cheap/at']);
  });

  it('min_gdpval_pct keeps a ref exactly at pct x pool max', () => {
    const out = run(
      ['cheap/top', 'cheap/at', 'cheap/below'],
      { min_gdpval_pct: 50 },
      { 'cheap/top': { gdp: 1000 }, 'cheap/at': { gdp: 500 }, 'cheap/below': { gdp: 499 } },
    );
    expect(out).toEqual(['cheap/top', 'cheap/at']);
  });

  it('max_gdpval keeps a ref scoring exactly the cap', () => {
    const out = run(['cheap/at', 'cheap/above'], { max_gdpval: 900 }, { 'cheap/at': { gdp: 900 }, 'cheap/above': { gdp: 900.1 } });
    expect(out).toEqual(['cheap/at']);
  });

  it('max_gdpval fails an UNSCORED ref (strict null-fails, not null -> 0)', () => {
    const out = run(['cheap/scored', 'cheap/unscored'], { max_gdpval: 900 }, { 'cheap/scored': { gdp: 800 } });
    expect(out).toEqual(['cheap/scored']);
  });

  it('max_cost keeps a priced ref costing exactly the cap', () => {
    const out = run(['cheap/at', 'cheap/above'], { max_cost: 2 }, { 'cheap/at': { cost: 2 }, 'cheap/above': { cost: 2.5 } });
    expect(out).toEqual(['cheap/at']);
  });

  it('max_cost_per_m keeps a ref priced exactly at the cap', () => {
    const out = run(
      ['cheap/at', 'cheap/above'],
      { max_cost_per_m: 3 },
      { 'cheap/at': { price: { input: 3, output: 9 } }, 'cheap/above': { price: { input: 3.5, output: 9 } } },
    );
    expect(out).toEqual(['cheap/at']);
  });

  it('min_context_length keeps a ref with exactly the required window', () => {
    const out = run(['cheap/at', 'cheap/below'], { min_context_length: 128000 }, { 'cheap/at': { cw: 128000 }, 'cheap/below': { cw: 127999 } });
    expect(out).toEqual(['cheap/at']);
  });
});

describe('applyGroupFilters — max_cost > 0 unknown/free handling', () => {
  it('a free ref passes even when its cost is unknown (pay_per_token provider)', () => {
    const out = run(['cheap/free'], { max_cost: 1 }, { 'cheap/free': { free: true, cost: 'unknown' } });
    expect(out).toEqual(['cheap/free']);
  });

  it('a priced pay_per_token ref under the cap is kept', () => {
    expect(run(['cheap/priced'], { max_cost: 1 }, { 'cheap/priced': { cost: 0.5 } })).toEqual(['cheap/priced']);
  });

  it('unknown cost: subscription is kept (sunk cost), pay_per_token is dropped', () => {
    const out = run(['sub/x', 'cheap/y'], { max_cost: 1 }, {});
    expect(out).toEqual(['sub/x']);
  });
});

describe('applyGroupFilters — max_cost_per_m needs a complete price', () => {
  it('drops a ref without a price, with an unknown input, and with an unknown output', () => {
    const rows: Record<string, Row> = {
      'cheap/none': { price: null },
      'cheap/in-unknown': { price: { input: 'unknown', output: 1 } },
      'cheap/out-unknown': { price: { input: 1, output: 'unknown' } },
      'cheap/ok': { price: { input: 1, output: 1 } },
    };
    expect(run(Object.keys(rows), { max_cost_per_m: 5 }, rows)).toEqual(['cheap/ok']);
  });
});

describe('applyGroupFilters — dedup opt-in', () => {
  const dropFirst = (refs: string[]) => refs.slice(1);
  const g = { method: 'best' } as Group;
  const refs = ['cheap/a', 'cheap/b'];

  it('does not call the dedup function when dedup is not requested', () => {
    expect(applyGroupFilters(refs, g, CFG, false, dropFirst, lookups({}))).toEqual(refs);
  });

  it('dedup defaults to off even when a function is passed', () => {
    expect(applyGroupFilters(refs, g, CFG, undefined, dropFirst, lookups({}))).toEqual(refs);
  });

  it('dedup requested without a function is a no-op, not a crash', () => {
    expect(applyGroupFilters(refs, g, CFG, true, undefined, lookups({}))).toEqual(refs);
  });

  it('dedup requested with a function applies it and reports only the dropped refs', () => {
    const dropped: Array<[string, string]> = [];
    const out = applyGroupFilters(refs, g, CFG, true, dropFirst, lookups({}), (ref, gate) => dropped.push([ref, gate]));
    expect(out).toEqual(['cheap/b']);
    expect(dropped).toEqual([['cheap/a', 'dedup']]);
  });
});

describe('applyGroupFilters — onDrop names the gate that removed the ref', () => {
  const rows: Record<string, Row> = {
    'cheap/ok': { gdp: 600, cost: 1, price: { input: 1, output: 1 }, cw: 200000 },
    'cheap/excluded-prov': { gdp: 600 },
    'banned/prov': { gdp: 600 },
    'cheap/low-gdp': { gdp: 100, cost: 1, price: { input: 1, output: 1 }, cw: 200000 },
    'cheap/high-gdp': { gdp: 950, cost: 1, price: { input: 1, output: 1 }, cw: 200000 },
    'cheap/pricey': { gdp: 600, cost: 99, price: { input: 99, output: 99 }, cw: 200000 },
    'cheap/small-ctx': { gdp: 600, cost: 1, price: { input: 1, output: 1 }, cw: 1000 },
  };

  const dropsFor = (g: Partial<Group>, refs: string[], cfg: Config = CFG): Array<[string, string]> => {
    const dropped: Array<[string, string]> = [];
    applyGroupFilters(refs, { method: 'best', ...g } as Group, cfg, false, undefined, lookups(rows), (r, gate) => dropped.push([r, gate]));
    return dropped;
  };

  it('exclude_providers / exclude_models', () => {
    expect(dropsFor({ exclude_providers: ['banned'] }, ['cheap/ok', 'banned/prov'])).toEqual([['banned/prov', 'exclude_providers']]);
    expect(dropsFor({ exclude_models: ['cheap/ok'] }, ['cheap/ok'])).toEqual([['cheap/ok', 'exclude_models']]);
  });

  it('non_agent', () => {
    const cfg = { ...CFG, non_agent_model_prefixes: ['tiny'] } as Config;
    expect(dropsFor({}, ['cheap/tiny-model', 'cheap/ok'], cfg)).toEqual([['cheap/tiny-model', 'non_agent']]);
  });

  it('min_gdpval / min_gdpval_pct / max_gdpval', () => {
    expect(dropsFor({ min_gdpval: 500 }, ['cheap/low-gdp'])).toEqual([['cheap/low-gdp', 'min_gdpval']]);
    expect(dropsFor({ min_gdpval_pct: 90 }, ['cheap/high-gdp', 'cheap/low-gdp'])).toEqual([['cheap/low-gdp', 'min_gdpval_pct']]);
    expect(dropsFor({ max_gdpval: 900 }, ['cheap/high-gdp'])).toEqual([['cheap/high-gdp', 'max_gdpval']]);
  });

  it('max_cost / max_cost_per_m / min_context_length', () => {
    expect(dropsFor({ max_cost: 5 }, ['cheap/pricey'])).toEqual([['cheap/pricey', 'max_cost']]);
    expect(dropsFor({ max_cost_per_m: 5 }, ['cheap/pricey'])).toEqual([['cheap/pricey', 'max_cost_per_m']]);
    expect(dropsFor({ min_context_length: 100000 }, ['cheap/small-ctx'])).toEqual([['cheap/small-ctx', 'min_context_length']]);
  });
});
