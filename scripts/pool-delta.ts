// Pool-content comparison for the 5-group plan (docs/plans/2026-10-25-category-group-mismatch.md,
// Step 3). Pure functions over parsed router.log lines (scripts/route-pool-log.ts): the universe of
// models the groups showed at decision time, the admission floor, the score ranking and the diff
// between two pools. Pool CONTENT and head only — never "who served", which the failover walk
// decides (docs/research/2026-10-28-route-calibration.md).

import type { PoolCandidate, RoutingLine } from './route-pool-log.ts';

/**
 * Every candidate the groups of process `proc` showed at time `at`: the latest
 * routing line of each group at or before `at`, unioned by ref. When a ref
 * appears in several groups, the metrics come from the most recent line.
 *
 * Lower bound, not the full registry: a group only lists what passed ITS gates
 * (e.g. operational caps the cost), so a model every shown group rejected is
 * not in the universe.
 */
export function universeAsOf(lines: RoutingLine[], proc: string, at: number): PoolCandidate[] {
  const latestPerGroup = new Map<string, RoutingLine>();
  for (const l of lines) {
    if (l.proc !== proc || l.ts > at) continue;
    const seen = latestPerGroup.get(l.group);
    if (!seen || l.ts > seen.ts) latestPerGroup.set(l.group, l);
  }
  const byRef = new Map<string, { c: PoolCandidate; ts: number }>();
  for (const l of latestPerGroup.values()) {
    for (const c of l.candidates) {
      const seen = byRef.get(c.ref);
      if (!seen || l.ts > seen.ts) byRef.set(c.ref, { c, ts: l.ts });
    }
  }
  return [...byRef.values()].map((v) => v.c);
}

/** Models at or above the GDPval floor; an unknown GDPval never passes. */
export function admit(pool: PoolCandidate[], floor: number): PoolCandidate[] {
  return pool.filter((c) => c.gdp !== null && c.gdp >= floor);
}

/** Descending score; GDPval breaks ties (a stable order for the rest). */
export function rankBy(pool: PoolCandidate[], scoreOf: (ref: string) => number): PoolCandidate[] {
  return [...pool].sort((a, b) => scoreOf(b.ref) - scoreOf(a.ref) || (b.gdp ?? 0) - (a.gdp ?? 0));
}

export interface PoolDiff {
  added: string[];
  removed: string[];
  headChanged: boolean;
  currentHead: string | null;
  targetHead: string | null;
}

export function diffPools(current: string[], target: string[]): PoolDiff {
  const cur = new Set(current);
  const tgt = new Set(target);
  const currentHead = current[0] ?? null;
  const targetHead = target[0] ?? null;
  return {
    added: target.filter((r) => !cur.has(r)),
    removed: current.filter((r) => !tgt.has(r)),
    headChanged: currentHead !== targetHead,
    currentHead,
    targetHead,
  };
}
