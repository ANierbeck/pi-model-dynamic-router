// Fast ratchet guard for the lint gate (docs/plans/2026-11-04-lint-gate.md).
//
// No ESLint run happens here — that is `npm run lint`, which CI runs as a step
// in the required `test` job. This file pins the baseline's shape and a CEILING
// that must move together with it, exactly like test/redundancy-baseline.test.ts.
// Growing the baseline therefore requires editing a visible constant in this
// file in the same commit, which is what makes the ratchet reviewable.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface LintEntry {
  file: string;
  rule: string;
  count: number;
}

interface LintBaseline {
  note: string;
  entries: LintEntry[];
}

/** Total findings the baseline is allowed to hold. Only ever lowered. */
const CEILING_FINDINGS = 1219;

const baseline = JSON.parse(
  readFileSync(join(process.cwd(), 'scripts/lint-baseline.json'), 'utf8'),
) as LintBaseline;

const total = (entries: LintEntry[]): number => entries.reduce((sum, e) => sum + e.count, 0);

describe('lint baseline ratchet', () => {
  it('is canonical: sorted, unique per (file, rule), positive integer counts', () => {
    const keys = baseline.entries.map((e) => `${e.file}\u0000${e.rule}`);
    expect(keys, 'entries must be sorted by file then rule').toEqual([...keys].sort());
    expect(new Set(keys).size, 'no duplicate (file, rule) entries').toBe(keys.length);
    for (const entry of baseline.entries) {
      expect(
        Number.isInteger(entry.count) && entry.count > 0,
        `${entry.file} ${entry.rule}: count ${entry.count}`,
      ).toBe(true);
    }
  });

  it('stays at or below the ceiling', () => {
    expect(total(baseline.entries), 'a cleanup lowers the baseline, never raises it').toBeLessThanOrEqual(
      CEILING_FINDINGS,
    );
  });

  it('the ceiling moves with the baseline (no silent headroom)', () => {
    expect(
      total(baseline.entries),
      'lower scripts/lint-baseline.json and CEILING_FINDINGS in the same change',
    ).toBe(CEILING_FINDINGS);
  });
});
