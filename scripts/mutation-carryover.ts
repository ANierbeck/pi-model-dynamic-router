// Carries triage verdicts from earlier ledger datasets
// (docs/mutation-data/nightly-*.json) over to a new Stryker report, so a
// nightly triage only has to look at mutants nobody has ruled on yet.
//
// A mutant is keyed by its SOURCE, not by its report line or id (both shift
// with every edit): file, mutator, replacement, the exact mutated text and
// the trimmed line plus its two neighbours. Any edit on or next to a mutant
// therefore makes it NEW — a human looks again — while untouched code keeps
// its verdict. Ledger rows need the `original` and `context` columns for
// that; `--backfill` adds them from the report the ledger was triaged on
// (do it while that nightly artifact is still downloadable — 90 days).
//
// Actions per undetected mutant (Survived + NoCoverage):
//   ledgered — carried EQUIVALENT verdict, nothing to do
//   recheck  — the ledger had it KILLED (REAL-KILLED / SUITE-KILLED); it is
//              undetected again, so it is a recurring false survivor (perTest
//              coverage attribution) or a weakened test — run
//              scripts/mutation-recheck.ts on it
//   triage   — NEW, a REMOVED mutant that is back, or conflicting verdicts
//
// Usage:
//   node scripts/mutation-carryover.ts <mutation.json> --ledger a.json[,b.json] [--out rows.json]
//     (ledgers in chronological order; a later ledger wins for the same key)
//   node scripts/mutation-carryover.ts --backfill <triaged-report.json> <ledger.json>

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

interface Pos { line: number; column: number }
export interface ReportMutant {
  id: string;
  mutatorName: string;
  replacement?: string;
  status?: string;
  location: { start: Pos; end: Pos };
}
export interface Report { files: Record<string, { source: string; mutants: ReportMutant[] }> }
export interface Ledger { columns: string[]; rows: unknown[][]; [k: string]: unknown }

export interface CarryRow {
  file: string;
  line: number;
  id: string;
  status: string;
  mutator: string;
  replacement: string;
  original: string;
  context: string;
  verdict: string;
  from?: string;
  why?: string;
  action: 'ledgered' | 'recheck' | 'triage';
}

const KILLED_VERDICTS = new Set(['REAL-KILLED', 'SUITE-KILLED']);
const LEDGERED_VERDICTS = new Set(['EQUIVALENT']);

function offset(lines: string[], pos: Pos): number {
  let o = 0;
  for (let i = 0; i < pos.line - 1; i++) o += lines[i].length + 1;
  return o + pos.column - 1;
}

/** The exact mutated text and the trimmed line with both neighbours ('' past the edges). */
export function mutantContext(source: string, m: ReportMutant): { original: string; context: string } {
  const lines = source.split('\n');
  const original = source.slice(offset(lines, m.location.start), offset(lines, m.location.end));
  const at = (n: number) => (n >= 1 && n <= lines.length ? lines[n - 1].trim() : '');
  const l = m.location.start.line;
  return { original, context: [at(l - 1), at(l), at(l + 1)].join('\n') };
}

function key(file: string, mutator: string, replacement: string, original: string, context: string): string {
  return JSON.stringify([file, mutator, replacement, original, context]);
}

/** Adds (or refreshes) the `original` + `context` columns from the report the ledger was triaged on. */
export function backfillLedger(report: Report, ledger: Ledger): Ledger {
  const ci = (c: string) => ledger.columns.indexOf(c);
  const fileI = ci('file');
  const idI = ci('id');
  const columns = ledger.columns.filter((c) => c !== 'original' && c !== 'context');
  const keep = columns.map((c) => ci(c));
  const rows = ledger.rows.map((r) => {
    const file = String(r[fileI]);
    const id = String(r[idI]);
    const entry = report.files[file];
    const m = entry?.mutants.find((x) => x.id === id);
    if (!entry || !m) throw new Error(`ledger row ${file}#${id} is not in the report — wrong report for this ledger?`);
    const { original, context } = mutantContext(entry.source, m);
    return [...keep.map((i) => r[i]), original, context];
  });
  return { ...ledger, columns: [...columns, 'original', 'context'], rows };
}

/**
 * Ledger file format: one row per line, so a re-triage diff shows exactly
 * the mutants whose verdict changed.
 */
export function formatLedger(ledger: Ledger): string {
  const { rows, ...head } = ledger;
  const headJson = JSON.stringify(head);
  return `${headJson.slice(0, -1)},"rows":[\n${rows.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`;
}

interface Verdict { verdicts: Set<string>; why: string; from: string }

function indexLedger(name: string, ledger: Ledger, into: Map<string, Verdict>): void {
  const ci = (c: string) => ledger.columns.indexOf(c);
  const [fileI, mutI, repI, origI, ctxI, catI, whyI] = ['file', 'mutator', 'replacement', 'original', 'context', 'category', 'why'].map(ci);
  // Never fall back to line numbers: a ledger without the source columns
  // would silently match nothing and report every mutant as NEW.
  if (origI < 0 || ctxI < 0) throw new Error(`ledger ${name} has no original/context columns — run --backfill first`);
  const local = new Map<string, Verdict>();
  for (const r of ledger.rows) {
    const k = key(String(r[fileI]), String(r[mutI]), String(r[repI] ?? ''), String(r[origI]), String(r[ctxI]));
    const v = local.get(k) ?? { verdicts: new Set<string>(), why: whyI >= 0 ? String(r[whyI] ?? '') : '', from: name };
    v.verdicts.add(String(r[catI]));
    local.set(k, v);
  }
  for (const [k, v] of local) into.set(k, v); // a later ledger wins
}

export function carryOver(report: Report, ledgers: Array<{ name: string; ledger: Ledger }>): CarryRow[] {
  const known = new Map<string, Verdict>();
  for (const { name, ledger } of ledgers) indexLedger(name, ledger, known);
  const out: CarryRow[] = [];
  for (const [file, entry] of Object.entries(report.files)) {
    for (const m of entry.mutants) {
      if (m.status !== 'Survived' && m.status !== 'NoCoverage') continue;
      const { original, context } = mutantContext(entry.source, m);
      const replacement = m.replacement ?? '';
      const hit = known.get(key(file, m.mutatorName, replacement, original, context));
      const base = { file, line: m.location.start.line, id: m.id, status: m.status, mutator: m.mutatorName, replacement, original, context };
      if (!hit) {
        out.push({ ...base, verdict: 'NEW', action: 'triage' });
        continue;
      }
      // Conflicting verdicts join to e.g. 'EQUIVALENT/REAL-KILLED', which is in
      // neither set and therefore lands in triage instead of a guess.
      const verdict = [...hit.verdicts].sort().join('/');
      const action = LEDGERED_VERDICTS.has(verdict) ? 'ledgered' : KILLED_VERDICTS.has(verdict) ? 'recheck' : 'triage';
      out.push({ ...base, verdict, from: hit.from, why: hit.why, action });
    }
  }
  return out;
}

function main(argv: string[]): number {
  const args = [...argv];
  const take = (flag: string, n = 1): string[] | undefined => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args.splice(i, n + 1).slice(1);
  };
  const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
  const backfill = take('--backfill', 2);
  if (backfill) {
    const [reportPath, ledgerPath] = backfill;
    writeFileSync(ledgerPath, formatLedger(backfillLedger(readJson(reportPath), readJson(ledgerPath))));
    process.stdout.write(`backfilled original + context into ${ledgerPath}\n`);
    return 0;
  }
  const ledgerArg = take('--ledger')?.[0];
  const outPath = take('--out')?.[0];
  const reportPath = args[0];
  if (!reportPath || !ledgerArg) {
    process.stderr.write('usage: node scripts/mutation-carryover.ts <mutation.json> --ledger a.json[,b.json] [--out rows.json]\n'
      + '       node scripts/mutation-carryover.ts --backfill <triaged-report.json> <ledger.json>\n');
    return 2;
  }
  const ledgers = ledgerArg.split(',').map((p) => ({ name: p, ledger: readJson(p) as Ledger }));
  const rows = carryOver(readJson(reportPath), ledgers);
  if (outPath) writeFileSync(outPath, JSON.stringify(rows, null, 1) + '\n');
  const count = (a: string) => rows.filter((r) => r.action === a).length;
  process.stdout.write(`${rows.length} undetected: ${count('ledgered')} ledgered, ${count('recheck')} recheck, ${count('triage')} triage\n`);
  for (const r of rows.filter((x) => x.action !== 'ledgered')) {
    process.stdout.write(`  [${r.action}] ${r.file}:${r.line} #${r.id} ${r.mutator} ${JSON.stringify(r.original.slice(0, 50))} -> ${JSON.stringify(r.replacement.slice(0, 50))} (${r.verdict})\n`);
  }
  return 0;
}

function invokedDirectly(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exit(main(process.argv.slice(2)));
