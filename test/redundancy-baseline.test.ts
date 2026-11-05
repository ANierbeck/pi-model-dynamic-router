// Ratchet gate for scripts/redundancy-report.ts
// (docs/plans/2026-10-29-repo-hygiene.md, Phase 0). Same pattern as the
// hard-coded-model baseline (AGENTS.md §9): the measured counts may only go
// DOWN. A count above its baseline is new redundancy (a stale group name in a
// shipped doc, a new top-level file, a copied helper, more set-up
// boilerplate); a count below it means a cleanup landed, and the baseline is
// lowered in the same change so the gain cannot silently grow back.
//
// Never raise a baseline entry to make a PR green. CEILING below is the
// second lock: the baseline file may not exceed it, so raising the JSON alone
// fails. Cleanup phases lower BOTH. Phase 1 targets rootOutsideAllowlist 0,
// Phase 2 targets staleNames 0.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, collectInput, type Counts } from '../scripts/redundancy-report.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CEILING: Counts = {
  staleNames: 0,
  rootOutsideAllowlist: 0,
  plansWithoutStatus: 23,
  plansMissingFromIndex: 0,
  duplicateFunctions: 0,
  repeatedBlocks: 43,
  ollamaMockFiles: 27,
};

const baseline = JSON.parse(readFileSync(resolve(root, 'scripts/redundancy-baseline.json'), 'utf8')) as {
  note: string;
  counts: Counts;
};
const measured = analyze(collectInput(root)).counts;
const keys = Object.keys(CEILING) as (keyof Counts)[];

describe('redundancy baseline', () => {
  it('has an entry for exactly the counts the report produces', () => {
    expect(Object.keys(baseline.counts).sort()).toEqual([...keys].sort());
  });

  it.each(keys)('%s: the baseline and the ceiling move together', (key) => {
    // Equality, not <=. With only an upper bound, a cleanup could lower the
    // JSON while leaving CEILING at the old value — a later increase could then
    // pass by raising the JSON back up to the stale ceiling (Sourcery
    // 2026-11-03). Both locks are lowered in the same change, or neither is.
    expect(baseline.counts[key]).toBe(CEILING[key]);
  });

  it.each(keys)('%s: no new redundancy above the baseline', (key) => {
    expect(measured[key], `${key} grew from ${baseline.counts[key]} to ${measured[key]} — run: node scripts/redundancy-report.ts`).toBeLessThanOrEqual(
      baseline.counts[key]
    );
  });

  it.each(keys)('%s: a cleanup lowers the baseline in the same change', (key) => {
    expect(
      measured[key],
      `${key} is ${measured[key]}, baseline says ${baseline.counts[key]} — lower scripts/redundancy-baseline.json and CEILING`
    ).toBeGreaterThanOrEqual(baseline.counts[key]);
  });
});
