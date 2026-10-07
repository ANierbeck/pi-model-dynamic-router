// test/min-cost-ordering.test.ts — nightly R1 triage (2026-10-07),
// routing.ts cost-ordering comparators: sortByMinCost, the within-tier cost
// ordering of sortByBillingPreference, and the best_quality_window pool
// comparator.
//
// The existing fixtures (sort-by-methods.test.ts) kept ordering assertions
// that V8's sort happened to satisfy under several broken comparators (a
// comparator is called with a size-dependent argument order, so a
// direction/branch bug can hide behind one lucky input order). Every
// assertion here therefore runs over ALL permutations of the input and
// requires the SAME output — only a correct, antisymmetric comparator
// passes. Covered:
//
//   - sortByMinCost: known costs ascend, cost ties → higher GDPval first,
//     unknown-cost refs go to the END and order among themselves by GDPval
//     DESC (this both-unknown branch had NoCoverage)
//   - sortByBillingPreference: inside ONE billing tier, cheaper first
//     (tier ranks were pinned, the within-tier cost order was not), unknown
//     last, unknown-vs-unknown by GDPval DESC
//   - best_quality_window pool: cheapest first, unknown cost last,
//     unknown-vs-unknown by GDPval ASC (least overkill)
//
// Permutations alone are not enough either: V8's binary-insertion sort only
// ever calls cmp(laterElement, earlierElement), so the OTHER argument order
// (cmp(unknown, known) must be > 0) is never exercised by a small array and
// its branch can be deleted unnoticed. The pairwise tests therefore capture
// the comparator handed to Array.prototype.sort and require, for EVERY
// ordered pair, sign(cmp(a, b)) to agree with the expected order.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Router } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.ts';
import type { Config, Cache } from '../src/types.ts';

const testConfig: Config = {
  model_groups: {},
  best_quality_window: 0.05,
  model_metrics: {
    // payg refs on an unregistered provider: cost_per_m is the only price.
    // Cost and GDPval are ANTI-correlated on purpose.
    'ordx/cheap-weak': { gdpval: 500, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 1 },
    'ordx/mid': { gdpval: 700, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 2 },
    'ordx/pricey-strong': { gdpval: 900, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 3 },
    'ordx/tie-strong': { gdpval: 800, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 2 },
    // no cost_per_m → unresolvable → 'unknown'
    'ordx/unk-weak': { gdpval: 600, throughput_tps: 100, avg_latency_ms: 1000 },
    'ordx/unk-strong': { gdpval: 850, throughput_tps: 100, avg_latency_ms: 1000 },

    // best_quality_window pool: all within 5% of the 1000 leader.
    'winx/top': { gdpval: 1000, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 1 },
    'winx/cheap': { gdpval: 970, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 0.2 },
    'winx/mid': { gdpval: 990, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 0.5 },
    'winx/unk-strong': { gdpval: 985, throughput_tps: 100, avg_latency_ms: 1000 },
    'winx/unk-weak': { gdpval: 975, throughput_tps: 100, avg_latency_ms: 1000 },
    'winx/outside': { gdpval: 700, throughput_tps: 100, avg_latency_ms: 1000, cost_per_m: 0.001 },
  },
  providers: {},
} as any;

const cache: Cache = { available_models: [] } as any;

beforeAll(() => {
  metricsModule.setConfig(testConfig);
  metricsModule.setCache(cache);
  metricsModule.setGdpval({});
  metricsModule.setModelMap({}, []);
  metricsModule.setModelRegistry({ find: () => undefined } as any);
});

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

function expectOrderForEveryPermutation(refs: string[], expected: string[], sort: (r: string[]) => string[]) {
  for (const perm of permutations(refs)) {
    expect(sort(perm), `input order ${perm.join(',')}`).toEqual(expected);
  }
}

const router = () => new Router(testConfig, cache, new Map());

describe('sortByMinCost — every input order', () => {
  it('known costs ascend; unknown-cost refs go last, ordered by GDPval DESC', () => {
    expectOrderForEveryPermutation(
      ['ordx/pricey-strong', 'ordx/cheap-weak', 'ordx/mid', 'ordx/unk-weak', 'ordx/unk-strong'],
      ['ordx/cheap-weak', 'ordx/mid', 'ordx/pricey-strong', 'ordx/unk-strong', 'ordx/unk-weak'],
      (r) => router().sortByMinCost(r),
    );
  });

  it('a cost tie breaks to the HIGHER GDPval', () => {
    expectOrderForEveryPermutation(
      ['ordx/mid', 'ordx/tie-strong', 'ordx/cheap-weak'],
      ['ordx/cheap-weak', 'ordx/tie-strong', 'ordx/mid'],
      (r) => router().sortByMinCost(r),
    );
  });
});

describe('sortByBillingPreference — ordering inside one billing tier', () => {
  it('cheaper first, unknown last, unknown-vs-unknown by GDPval DESC (every input order)', () => {
    expectOrderForEveryPermutation(
      ['ordx/pricey-strong', 'ordx/cheap-weak', 'ordx/mid', 'ordx/unk-weak', 'ordx/unk-strong'],
      ['ordx/cheap-weak', 'ordx/mid', 'ordx/pricey-strong', 'ordx/unk-strong', 'ordx/unk-weak'],
      (r) => router().sortByBillingPreference(r),
    );
  });

  it('a cost tie falls to the higher GDPval', () => {
    expectOrderForEveryPermutation(
      ['ordx/mid', 'ordx/tie-strong'],
      ['ordx/tie-strong', 'ordx/mid'],
      (r) => router().sortByBillingPreference(r),
    );
  });
});

describe('sortBy best — best_quality_window pool comparator', () => {
  it('pool: cheapest first, unknown cost last (GDPval ASC among them); outside the window stays behind', () => {
    expectOrderForEveryPermutation(
      ['winx/top', 'winx/cheap', 'winx/mid', 'winx/unk-strong', 'winx/unk-weak', 'winx/outside'],
      ['winx/cheap', 'winx/mid', 'winx/top', 'winx/unk-weak', 'winx/unk-strong', 'winx/outside'],
      (r) => router().sortBy(r, 'best'),
    );
  });
});

type Comparator = (a: string, b: string) => number;

/** The comparator of the LAST Array.prototype.sort call made while `run` executes. */
function lastSortComparator(run: () => void): Comparator {
  const realSort = Array.prototype.sort;
  let captured: Comparator | undefined;
  const spy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (this: unknown[], cmp?: Comparator) {
    if (cmp) captured = cmp;
    return realSort.call(this, cmp);
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  if (!captured) throw new Error('no comparator captured');
  return captured;
}

function expectComparatorAgrees(cmp: Comparator, expected: string[]) {
  for (let i = 0; i < expected.length; i++) {
    for (let j = 0; j < expected.length; j++) {
      if (i === j) continue;
      const sign = Math.sign(cmp(expected[i], expected[j]));
      expect(sign, `cmp(${expected[i]}, ${expected[j]})`).toBe(i < j ? -1 : 1);
    }
  }
}

describe('comparator contract — every ordered pair, not just the sort output', () => {
  const unitExpected = ['ordx/cheap-weak', 'ordx/mid', 'ordx/pricey-strong', 'ordx/unk-strong', 'ordx/unk-weak'];

  it('sortByMinCost', () => {
    const cmp = lastSortComparator(() => router().sortByMinCost([...unitExpected]));
    expectComparatorAgrees(cmp, unitExpected);
  });

  it('sortByBillingPreference (within one tier)', () => {
    const cmp = lastSortComparator(() => router().sortByBillingPreference([...unitExpected]));
    expectComparatorAgrees(cmp, unitExpected);
  });

  it('best_quality_window pool', () => {
    const poolExpected = ['winx/cheap', 'winx/mid', 'winx/top', 'winx/unk-weak', 'winx/unk-strong'];
    const cmp = lastSortComparator(() => router().sortBy([...poolExpected, 'winx/outside'], 'best'));
    expectComparatorAgrees(cmp, poolExpected);
  });
});
