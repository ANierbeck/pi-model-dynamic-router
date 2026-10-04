// Pins the nightly mutation summary (scripts/mutation-summary.ts).
//
// The first workflow draft read `report.metrics` from
// reports/mutation/mutation.json — a field the mutation-testing report
// schema does not have (it carries files -> mutants[].status only), so
// every night would have summarized "0 mutants, 0%". The summary is now
// computed from the mutant statuses with Stryker's own score definition:
// detected (Killed + Timeout) / valid (detected + Survived + NoCoverage);
// CompileError/RuntimeError/Ignored/Pending are not valid mutants.

import { describe, expect, it } from 'vitest';
import { summarizeMutationReport, formatSummary } from '../scripts/mutation-summary.ts';

const mutant = (status: string) => ({ status });

const report = {
  schemaVersion: '2',
  thresholds: { high: 80, low: 60 },
  files: {
    'src/metrics.ts': {
      language: 'typescript',
      source: '',
      mutants: [mutant('Killed'), mutant('Killed'), mutant('Survived'), mutant('Timeout'), mutant('Ignored')],
    },
    'src/routing.ts': {
      language: 'typescript',
      source: '',
      mutants: [mutant('Killed'), mutant('Survived'), mutant('Survived'), mutant('NoCoverage'), mutant('CompileError')],
    },
  },
};

describe('mutation-summary', () => {
  it('counts statuses from files -> mutants, not from a non-existent metrics field', () => {
    const s = summarizeMutationReport(report);
    expect(s.total).toBe(10);
    expect(s.killed).toBe(3);
    expect(s.timedOut).toBe(1);
    expect(s.survived).toBe(3);
    expect(s.noCoverage).toBe(1);
    expect(s.errors).toBe(1);
    expect(s.ignored).toBe(1);
  });

  it("uses Stryker's score definition: detected / (detected + undetected)", () => {
    // detected = 3 killed + 1 timeout = 4; undetected = 3 survived + 1 no-coverage = 4
    expect(summarizeMutationReport(report).score).toBe(50);
  });

  it('reports survivors per file so triage knows where to start', () => {
    const s = summarizeMutationReport(report);
    expect(s.survivorsByFile).toEqual({ 'src/routing.ts': 3, 'src/metrics.ts': 1 });
    // Sorted descending: the file with the most undetected mutants first.
    expect(Object.keys(s.survivorsByFile)[0]).toBe('src/routing.ts');
  });

  it('an empty or malformed report yields a 0-mutant summary instead of throwing', () => {
    expect(summarizeMutationReport({}).total).toBe(0);
    expect(summarizeMutationReport({}).score).toBe(0);
    expect(summarizeMutationReport(null).total).toBe(0);
  });

  it('formats a markdown summary with score and per-file survivors', () => {
    const md = formatSummary(summarizeMutationReport(report));
    expect(md).toContain('Mutation score: 50%');
    expect(md).toContain('| src/routing.ts | 3 |');
  });
});
