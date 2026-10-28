// Pool-content comparison of the 5-group plan (docs/plans/2026-10-25-category-group-mismatch.md,
// Step 3): what a group's pool would contain under the target layout, compared with the pool
// the router actually computed at decision time. Pure functions over parsed router.log lines;
// synthetic data only. Compares pool CONTENT and head, never "who served" (failover decides that,
// docs/research/2026-10-28-route-calibration.md).

import { describe, it, expect } from 'vitest';
import { parseRoutingLine, type RoutingLine } from '../scripts/route-pool-log.ts';
import { universeAsOf, admit, rankBy, diffPools } from '../scripts/pool-delta.ts';

const T0 = Date.parse('2026-10-27T14:00:00.000Z');
const at = (sec: number) => T0 + sec * 1000;
const L = (sec: number, group: string, proc: string, pool: string): RoutingLine =>
  parseRoutingLine(
    `${new Date(at(sec)).toISOString()}  [${proc}] [routing] group=${group} method=best candidates: ${pool} || excluded: (none)`,
  )!;

describe('universeAsOf — every model the groups showed at decision time', () => {
  const lines = [
    L(0, 'planning', 'p/1', '1. a/x gdp=1800 cost=1'),
    L(10, 'planning', 'p/1', '1. a/x gdp=1801 cost=1 | 2. a/y gdp=1750 cost=1'),
    L(5, 'tactical', 'p/1', '1. a/z gdp=1650 cost=1'),
    L(8, 'tactical', 'p/2', '1. a/other gdp=1900 cost=1'), // later than p/1's tactical line: wins if the process is ignored
    L(50, 'tactical', 'p/1', '1. a/later gdp=1999 cost=1'),
  ];

  it('unions the latest line of each group of the process at or before the time', () => {
    const refs = universeAsOf(lines, 'p/1', at(20)).map((c) => c.ref).sort();
    expect(refs).toEqual(['a/x', 'a/y', 'a/z']);
  });

  it('takes the metrics from the latest line when a ref repeats across groups', () => {
    const more = [...lines, L(12, 'tactical', 'p/1', '1. a/x gdp=1802 cost=1')];
    const x = universeAsOf(more, 'p/1', at(20)).find((c) => c.ref === 'a/x')!;
    expect(x.gdp).toBe(1802);
  });

  it('ignores lines after the time and other processes', () => {
    const refs = universeAsOf(lines, 'p/1', at(1)).map((c) => c.ref);
    expect(refs).toEqual(['a/x']);
  });
});

describe('admit — the GDPval floor gates admission', () => {
  const pool = [
    { ref: 'a/hi', gdp: 1700, cost: 1, flags: [] },
    { ref: 'a/at', gdp: 1600, cost: 1, flags: [] },
    { ref: 'a/lo', gdp: 1599.9, cost: 1, flags: [] },
    { ref: 'a/none', gdp: null, cost: 1, flags: [] },
  ];

  it('keeps models at or above the floor; an unknown GDPval never passes', () => {
    expect(admit(pool, 1600).map((c) => c.ref)).toEqual(['a/hi', 'a/at']);
  });
});

describe('rankBy — descending score, GDPval breaks ties', () => {
  const pool = [
    { ref: 'a/glm', gdp: 1650, cost: 1, flags: [] },
    { ref: 'a/son', gdp: 1838, cost: 1, flags: [] },
    { ref: 'a/hai', gdp: 1620, cost: 1, flags: [] },
    { ref: 'a/tie', gdp: 1700, cost: 1, flags: [] },
  ];
  const scores: Record<string, number> = { 'a/glm': 1509, 'a/son': 1823, 'a/hai': 1578, 'a/tie': 1509 };

  it('orders by the score, not by GDPval', () => {
    expect(rankBy(pool, (r) => scores[r]).map((c) => c.ref)).toEqual(['a/son', 'a/hai', 'a/tie', 'a/glm']);
  });
});

describe('diffPools', () => {
  it('reports added, removed and an unchanged head', () => {
    expect(diffPools(['a', 'b'], ['a', 'b', 'c'])).toEqual({
      added: ['c'],
      removed: [],
      headChanged: false,
      currentHead: 'a',
      targetHead: 'a',
    });
  });

  it('reports a changed head and removed entries', () => {
    expect(diffPools(['a', 'b'], ['c', 'b'])).toEqual({
      added: ['c'],
      removed: ['a'],
      headChanged: true,
      currentHead: 'a',
      targetHead: 'c',
    });
  });

  it('an empty pool has a null head; empty vs empty is no change', () => {
    expect(diffPools([], [])).toEqual({ added: [], removed: [], headChanged: false, currentHead: null, targetHead: null });
    expect(diffPools([], ['a']).headChanged).toBe(true);
  });
});
