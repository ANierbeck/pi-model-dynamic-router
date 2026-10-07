// Lists the undetected mutants (Survived + NoCoverage) of a Stryker JSON
// report grouped by source line — the working view for survivor triage
// (docs/mutation-triage.md). The raw mutation.json is a 2-3 MB blob that
// must not be committed, so this script is the reusable way to turn a
// nightly artifact into a triage worklist.
//
// Per line: the original source text, then every undetected mutator with its
// replacement and status. Mutation `replacement` is shown truncated so
// BlockStatement mutants stay readable. The nightly artifact embeds the exact
// source it mutated; `--source-dir <dir>` writes those copies out so they can
// be diffed against the current tree (obsolete-mutant check).
//
// Usage: node scripts/mutation-survivors.ts <mutation.json> [--file src/x.ts] [--source-dir <dir>]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

interface Mutant {
  id: string;
  mutatorName: string;
  replacement?: string;
  status: string;
  coveredBy?: string[];
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
}
interface FileEntry { source: string; mutants: Mutant[] }

const MAX_REPLACEMENT = 60;

export function groupUndetectedByLine(entry: FileEntry): Map<number, Mutant[]> {
  const byLine = new Map<number, Mutant[]>();
  for (const m of entry.mutants) {
    if (m.status !== 'Survived' && m.status !== 'NoCoverage') continue;
    const line = m.location.start.line;
    byLine.set(line, [...(byLine.get(line) ?? []), m]);
  }
  return new Map([...byLine.entries()].sort((a, b) => a[0] - b[0]));
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_REPLACEMENT ? `${flat.slice(0, MAX_REPLACEMENT)}…` : flat;
}

function main(argv: string[]): number {
  const args = [...argv];
  const take = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    return args.splice(i, 2)[1];
  };
  const onlyFile = take('--file');
  const sourceDir = take('--source-dir');
  const reportPath = args[0];
  if (!reportPath) {
    process.stderr.write('usage: node scripts/mutation-survivors.ts <mutation.json> [--file src/x.ts] [--source-dir <dir>]\n');
    return 2;
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { files: Record<string, FileEntry> };
  for (const [file, entry] of Object.entries(report.files)) {
    if (onlyFile && file !== onlyFile) continue;
    if (sourceDir) {
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, basename(file)), entry.source);
    }
    const lines = entry.source.split('\n');
    for (const [line, mutants] of groupUndetectedByLine(entry)) {
      process.stdout.write(`${file}:${line}  ${lines[line - 1]?.trim() ?? ''}\n`);
      for (const m of mutants) {
        process.stdout.write(`    ${m.status === 'NoCoverage' ? 'NC' : 'SV'} ${m.mutatorName} -> ${shorten(m.replacement ?? '')}\n`);
      }
    }
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
