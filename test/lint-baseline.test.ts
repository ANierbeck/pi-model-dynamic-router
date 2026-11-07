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
import type { ESLint } from 'eslint';
import {
  compareLintFindingsToBaseline,
  refusedBaselineEntries,
  toEntries,
} from '../scripts/lint-gate.ts';

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
const CEILING_FINDINGS = 732;

const baseline = JSON.parse(
  readFileSync(join(process.cwd(), 'scripts/lint-baseline.json'), 'utf8')
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
        `${entry.file} ${entry.rule}: count ${entry.count}`
      ).toBe(true);
    }
  });

  it('stays at or below the ceiling', () => {
    expect(
      total(baseline.entries),
      'a cleanup lowers the baseline, never raises it'
    ).toBeLessThanOrEqual(CEILING_FINDINGS);
  });

  it('the ceiling moves with the baseline (no silent headroom)', () => {
    expect(
      total(baseline.entries),
      'lower scripts/lint-baseline.json and CEILING_FINDINGS in the same change'
    ).toBe(CEILING_FINDINGS);
  });
});

/** Minimal ESLint result shape; only the fields the gate reads. */
const result = (file: string, messages: Array<{ ruleId: string | null; fatal?: boolean }>) =>
  ({ filePath: file, messages }) as unknown as ESLint.LintResult;

describe('toEntries', () => {
  it('aggregates per (file, rule) and strips the root prefix with POSIX separators', () => {
    const entries = toEntries(
      [
        result('/r/src/a.ts', [
          { ruleId: 'no-empty' },
          { ruleId: 'no-empty' },
          { ruleId: 'no-var' },
        ]),
        result('/r/test/b.ts', [{ ruleId: 'no-empty' }]),
      ],
      '/r'
    );
    expect(entries).toEqual([
      { file: 'src/a.ts', rule: 'no-empty', count: 2 },
      { file: 'src/a.ts', rule: 'no-var', count: 1 },
      { file: 'test/b.ts', rule: 'no-empty', count: 1 },
    ]);
  });

  it('separates a real parse error from an unused eslint-disable directive', () => {
    // Both have ruleId null. Bucketing them together would let a genuine parse
    // error hide behind a baselined directive warning.
    const entries = toEntries(
      [result('/r/src/a.ts', [{ ruleId: null, fatal: true }, { ruleId: null }])],
      '/r'
    );
    expect(entries).toEqual([
      { file: 'src/a.ts', rule: 'eslint-directive', count: 1 },
      { file: 'src/a.ts', rule: 'fatal', count: 1 },
    ]);
  });

  it('sorts in UTF-16 code-unit order, matching the canonical check', () => {
    // localeCompare would order a_b before a-b; the canonical test uses
    // Array.prototype.sort(), so the writer must agree with it.
    const entries = toEntries(
      ['src/a_b.ts', 'src/a-b.ts', 'src/aB.ts', 'src/ab.ts'].map((f) =>
        result(`/r/${f}`, [{ ruleId: 'x' }])
      ),
      '/r'
    );
    expect(entries.map((e) => e.file)).toEqual([
      'src/a-b.ts',
      'src/aB.ts',
      'src/a_b.ts',
      'src/ab.ts',
    ]);
  });
});

describe('compareLintFindingsToBaseline', () => {
  it('accepts findings that match the baseline exactly', () => {
    expect(
      compareLintFindingsToBaseline(
        [{ file: 'a.ts', rule: 'r', count: 2 }],
        [{ file: 'a.ts', rule: 'r', count: 2 }]
      )
    ).toEqual([]);
  });

  it('reports a finding above its baseline entry as NEW', () => {
    const violations = compareLintFindingsToBaseline(
      [{ file: 'a.ts', rule: 'r', count: 3 }],
      [{ file: 'a.ts', rule: 'r', count: 2 }]
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('NEW r in a.ts: 3 (baseline 2)');
  });

  it('reports a finding with no baseline entry as NEW against 0', () => {
    const violations = compareLintFindingsToBaseline([{ file: 'a.ts', rule: 'r', count: 1 }], []);
    expect(violations[0]).toContain('NEW r in a.ts: 1 (baseline 0)');
  });

  it('reports a lowered count as stale, so a cleanup cannot leave headroom', () => {
    const violations = compareLintFindingsToBaseline(
      [{ file: 'a.ts', rule: 'r', count: 1 }],
      [{ file: 'a.ts', rule: 'r', count: 3 }]
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('stale and must be LOWERED');
    expect(violations[0]).toContain('baseline 3, found 1');
  });

  it('reports a vanished entry as stale and to be removed', () => {
    const violations = compareLintFindingsToBaseline([], [{ file: 'a.ts', rule: 'r', count: 2 }]);
    expect(violations[0]).toContain('stale and must be REMOVED');
  });
});

describe('--write refuses to baseline a parse error', () => {
  // A file that stops parsing is one 'fatal' entry. Writing it into the baseline
  // would let the next normal run pass with the file unchecked (round-2 review of #96).
  it('reports a fatal entry as refused', () => {
    const found = [
      { file: 'src/a.ts', rule: 'fatal', count: 1 },
      { file: 'src/b.ts', rule: 'no-unused-vars', count: 2 },
    ] as any;
    expect(refusedBaselineEntries(found).map((e: any) => e.file)).toEqual(['src/a.ts']);
  });

  it('refuses nothing when every finding is a rule finding', () => {
    expect(
      refusedBaselineEntries([{ file: 'src/b.ts', rule: 'no-unused-vars', count: 2 }] as any)
    ).toEqual([]);
  });
});
