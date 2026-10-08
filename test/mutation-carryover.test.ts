// Pins scripts/mutation-carryover.ts — the nightly-to-ledger verdict carry-over.
//
// Nightly R2 (2026-10-08): 111 of the 132 undetected mutants were already
// ruled EQUIVALENT by the R1 ledger; 12 more had been confirmed KILLED by
// the suite — recurring perTest-attribution false survivors. Finding
// that out needed the R1 Stryker artifact (90-day retention) because the
// ledger dataset was keyed by report line + mutant id, both of which shift
// with every edit. The carry-over keys a mutant by its SOURCE instead —
// mutator, replacement, mutated text and the trimmed line plus its two
// neighbours — so any edit near a mutant makes it NEW (conservative: a human
// looks again) while untouched code keeps its verdict across reports.

import { describe, expect, it } from 'vitest';
import { mutantContext, carryOver, backfillLedger, formatLedger, type Ledger } from '../scripts/mutation-carryover.ts';

const SOURCE = [
  'export function f(a: number[]) {',
  '  const xs = a ?? [];',
  '  if (xs.length === 0) return 0;',
  '  return xs[0];',
  '}',
].join('\n');

const loc = (line: number, col: number, endCol: number) => ({
  start: { line, column: col },
  end: { line, column: endCol },
});

// `[]` on line 2 (columns are 1-based, end exclusive).
const ARR = { id: '1', mutatorName: 'ArrayDeclaration', replacement: '["Stryker was here"]', location: loc(2, 19, 21) };
// `xs.length === 0` on line 3.
const COND = { id: '2', mutatorName: 'ConditionalExpression', replacement: 'false', location: loc(3, 7, 22) };

function report(source: string, mutants: Array<Record<string, unknown>>) {
  return { files: { 'src/f.ts': { source, mutants } } };
}

function ledgerFrom(rep: ReturnType<typeof report>, verdicts: Record<string, string>): Ledger {
  const base: Ledger = {
    columns: ['file', 'line', 'id', 'mutator', 'replacement', 'category', 'why'],
    rows: Object.entries(verdicts).map(([id, category]) => {
      const m = rep.files['src/f.ts'].mutants.find((x) => x.id === id)!;
      return ['src/f.ts', (m.location as any).start.line, id, m.mutatorName, m.replacement, category, `why ${id}`];
    }),
  };
  return backfillLedger(rep, base);
}

describe('mutantContext', () => {
  it('returns the exact mutated text and the trimmed line with its neighbours', () => {
    const ctx = mutantContext(SOURCE, ARR as any);
    expect(ctx.original).toBe('[]');
    expect(ctx.context).toBe(['export function f(a: number[]) {', 'const xs = a ?? [];', 'if (xs.length === 0) return 0;'].join('\n'));
  });

  it('first and last lines have an empty neighbour instead of throwing', () => {
    const first = { ...ARR, location: loc(1, 1, 7) };
    expect(mutantContext(SOURCE, first as any).context.split('\n')[0]).toBe('');
    const last = { ...ARR, location: loc(5, 1, 2) };
    expect(mutantContext(SOURCE, last as any).context.split('\n')[2]).toBe('');
  });
});

describe('backfillLedger', () => {
  it('adds original + context columns from the report the ledger was triaged on', () => {
    const rep = report(SOURCE, [{ ...ARR, status: 'Survived' }]);
    const l = ledgerFrom(rep, { '1': 'EQUIVALENT' });
    expect(l.columns).toContain('original');
    expect(l.columns).toContain('context');
    const row = Object.fromEntries(l.columns.map((c, i) => [c, l.rows[0][i]]));
    expect(row.original).toBe('[]');
    expect(row.context).toContain('const xs = a ?? [];');
  });

  it('is idempotent: backfilling twice does not duplicate the columns', () => {
    const rep = report(SOURCE, [{ ...ARR, status: 'Survived' }]);
    const once = ledgerFrom(rep, { '1': 'EQUIVALENT' });
    const twice = backfillLedger(rep, once);
    expect(twice.columns.filter((c) => c === 'context')).toHaveLength(1);
    expect(twice.rows[0]).toHaveLength(once.rows[0].length);
  });

  it('refuses a ledger row whose id is not in the report (wrong report)', () => {
    const rep = report(SOURCE, [{ ...ARR, status: 'Survived' }]);
    const bad: Ledger = { columns: ['file', 'id', 'category'], rows: [['src/f.ts', '99', 'EQUIVALENT']] };
    expect(() => backfillLedger(rep, bad)).toThrow(/src\/f\.ts#99/);
  });
});

describe('carryOver', () => {
  const old = report(SOURCE, [{ ...ARR, status: 'Survived' }, { ...COND, status: 'Survived' }]);
  const ledger = ledgerFrom(old, { '1': 'EQUIVALENT', '2': 'REAL-KILLED' });

  it('carries a verdict across reports even when ids and line numbers shift', () => {
    // Two lines inserted above: every line number and the ids move.
    const shifted = '// a\n// b\n' + SOURCE;
    const next = report(shifted, [
      { ...ARR, id: '41', location: loc(4, 19, 21), status: 'NoCoverage' },
      { ...COND, id: '42', location: loc(5, 7, 22), status: 'Survived' },
      { ...COND, id: '43', mutatorName: 'EqualityOperator', replacement: 'xs.length !== 0', location: loc(5, 7, 22), status: 'Killed' },
    ]);
    const rows = carryOver(next, [{ name: 'r1', ledger }]);
    // Killed mutants are not part of the worklist.
    expect(rows.map((r) => r.id)).toEqual(['41', '42']);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['41']).toMatchObject({ line: 4, verdict: 'EQUIVALENT', from: 'r1', action: 'ledgered', why: 'why 1' });
    // A mutant the ledger had confirmed killed is undetected again: either a
    // recurring false survivor or a weakened test — it must be rechecked.
    expect(byId['42']).toMatchObject({ verdict: 'REAL-KILLED', from: 'r1', action: 'recheck' });
  });

  it('an edit on the line or a neighbour makes the mutant NEW (needs triage)', () => {
    const edited = SOURCE.replace('  return xs[0];', '  return xs[1];');
    const next = report(edited, [{ ...COND, status: 'Survived' }]);
    expect(carryOver(next, [{ name: 'r1', ledger }])[0]).toMatchObject({ verdict: 'NEW', action: 'triage' });
  });

  it('a different replacement on the same text is a different mutant', () => {
    const next = report(SOURCE, [{ ...COND, replacement: 'true', status: 'Survived' }]);
    expect(carryOver(next, [{ name: 'r1', ledger }])[0].verdict).toBe('NEW');
  });

  it('a later ledger overrides an earlier one for the same key', () => {
    const later = ledgerFrom(old, { '2': 'SUITE-KILLED' });
    const next = report(SOURCE, [{ ...COND, status: 'Survived' }]);
    expect(carryOver(next, [{ name: 'r1', ledger }, { name: 'r2', ledger: later }])[0]).toMatchObject({
      verdict: 'SUITE-KILLED',
      from: 'r2',
      action: 'recheck',
    });
  });

  it('conflicting verdicts for one key inside a single ledger go to triage, not to a guess', () => {
    const dup = { ...ledger, rows: [...ledger.rows, ledger.rows[1].map((v, i) => (ledger.columns[i] === 'category' ? 'EQUIVALENT' : v))] };
    const next = report(SOURCE, [{ ...COND, status: 'Survived' }]);
    expect(carryOver(next, [{ name: 'r1', ledger: dup }])[0]).toMatchObject({ verdict: 'EQUIVALENT/REAL-KILLED', action: 'triage' });
  });

  it('a REMOVED verdict that shows up again is triage (the removal was undone or duplicated)', () => {
    const removed = ledgerFrom(old, { '1': 'REMOVED' });
    const next = report(SOURCE, [{ ...ARR, status: 'Survived' }]);
    expect(carryOver(next, [{ name: 'r1', ledger: removed }])[0]).toMatchObject({ verdict: 'REMOVED', action: 'triage' });
  });

  it('a ledger without the source columns is refused, never matched by line number', () => {
    // Silently matching nothing would report every mutant NEW and send a
    // fully ledgered night back to manual triage.
    const legacy: Ledger = { columns: ['file', 'line', 'id', 'mutator', 'replacement', 'category'], rows: [['src/f.ts', 2, '1', 'ArrayDeclaration', '["Stryker was here"]', 'EQUIVALENT']] };
    const next = report(SOURCE, [{ ...ARR, status: 'Survived' }]);
    expect(() => carryOver(next, [{ name: 'legacy', ledger: legacy }])).toThrow(/legacy.*--backfill/);
  });
});

describe('formatLedger', () => {
  it('writes one row per line and round-trips through JSON.parse', () => {
    const l: Ledger = { _about: 'x', columns: ['a', 'b'], rows: [['1', 2], ['3', 4]] };
    const text = formatLedger(l);
    expect(text.split('\n')).toEqual(['{"_about":"x","columns":["a","b"],"rows":[', '["1",2],', '["3",4]', ']}', '']);
    expect(JSON.parse(text)).toEqual(l);
  });
});
