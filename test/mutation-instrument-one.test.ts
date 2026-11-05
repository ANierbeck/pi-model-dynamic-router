// Pins scripts/mutation-instrument-one.ts — the standalone one-file
// instrumenter that feeds scripts/mutation-recheck.ts.
//
// The incident this guards against (2026-11-05, slice 2): the bare
// instrumenter's INTERNAL locations are 0-based (line and column), while
// the Stryker JSON report — and therefore mutation-recheck.ts, which applies
// mutants with scripts/lib/cli.ts `offsetOf()` — uses 1-based lines AND
// 1-based columns. A hand-built report that passed the internal locations
// through shifted every mutant one line up and one column left; the recheck
// then "verified" mangled, wrong-range edits (its staleness guard compares
// the same offsets in identical content, so it cannot catch this), and the
// whole slice-2 recheck result was garbage. This test pins the convention
// with the exact function the recheck uses, so a regression fails here
// instead of silently corrupting a triage round.

import { describe, it, expect } from 'vitest';
import { instrumentOne } from '../scripts/mutation-instrument-one.ts';
import { offsetOf } from '../scripts/lib/cli.ts';

// A small fixture with distinctive, predictable mutation targets:
//  - line 1 (1-based): the string literal 'slice-me' (StringLiteral -> "")
//  - line 4 (1-based): the ternary x > 1 (ConditionalExpression -> true/false)
const FIXTURE = `const marker = 'slice-me';
export function pick(x: number): number {
  // a comment line so the line offsets are unambiguous
  return x > 1 ? x - 1 : x + 1;
}
`;

describe('mutation-instrument-one: report location convention', () => {
  it('reports 1-based lines and columns (the offsetOf/recheck convention)', async () => {
    const mutants = await instrumentOne('fixture.ts', FIXTURE);

    // The slice at offsetOf(start..end) must be EXACTLY the mutated
    // expression — the same byte range mutation-recheck.ts replaces.
    const sliceOf = (m: (typeof mutants)[number]): string =>
      FIXTURE.slice(
        offsetOf(FIXTURE, m.location.start.line, m.location.start.column),
        offsetOf(FIXTURE, m.location.end.line, m.location.end.column)
      );

    // The StringLiteral mutator replaces the literal with an empty
    // double-quoted string (the replacement is `""`, two quote characters).
    const stringMutant = mutants.find(
      (m) => m.mutatorName === 'StringLiteral' && m.replacement === '""'
    );
    expect(stringMutant).toBeDefined();
    // The whole literal, quotes included — not text one line/col off.
    expect(sliceOf(stringMutant!)).toBe("'slice-me'");
    // 1-based line: the literal is on 1-based line 1, not 0-based "line 0".
    expect(stringMutant!.location.start.line).toBe(1);

    const condMutants = mutants.filter((m) => m.mutatorName === 'ConditionalExpression');
    expect(condMutants.length).toBeGreaterThan(0);
    for (const m of condMutants) {
      expect(sliceOf(m)).toBe('x > 1');
      // The ternary's condition is on 1-based line 4.
      expect(m.location.start.line).toBe(4);
    }
  });

  it('multi-line mutants (BlockStatement) also slice exactly — line offsets correct across newlines', async () => {
    const mutants = await instrumentOne('fixture.ts', FIXTURE);
    const block = mutants.find((m) => m.mutatorName === 'BlockStatement');
    expect(block).toBeDefined();
    const start = offsetOf(FIXTURE, block!.location.start.line, block!.location.start.column);
    const end = offsetOf(FIXTURE, block!.location.end.line, block!.location.end.column);
    // The function body braces, lines 2-5 (1-based), exactly — a line
    // off-by-one shifts the start into the signature or the end past the
    // closing brace, and this exact-slice comparison fails.
    expect(FIXTURE.slice(start, end)).toBe(
      `{\n  // a comment line so the line offsets are unambiguous\n  return x > 1 ? x - 1 : x + 1;\n}`
    );
  });
});
