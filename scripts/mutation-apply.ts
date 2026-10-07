// Applies ONE mutant from a Stryker JSON report to the working tree, runs the
// given vitest files, prints KILLED/SURVIVED, and ALWAYS restores the file.
// Why: AGENTS.md §4 demands red-first evidence for every regression test,
// and reproducing a nightly survivor by hand means hunting its exact
// line/column. The report carries each mutant's location + replacement, so
// the exact nightly mutation can be re-applied mechanically.
//
// The mutation locations refer to the source the nightly mutated (embedded in
// the report). The script refuses to run when the working-tree file differs
// from that embedded source at the mutated range.
//
// Usage: node scripts/mutation-apply.ts <mutation.json> <file> <line> <mutatorName> [nth] -- <vitest files...>
//   `nth` (default 0) disambiguates several mutants of the same mutator on one line.
// Safety: aborts when the target file has uncommitted changes (the restore is
// `git checkout -- <file>`).

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

interface Mutant {
  id: string;
  mutatorName: string;
  replacement?: string;
  status: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
}

function offsetOf(source: string, line: number, column: number): number {
  const lines = source.split('\n');
  let off = 0;
  for (let i = 0; i < line - 1; i++) off += lines[i].length + 1;
  return off + column - 1;
}

function main(argv: string[]): number {
  const sep = argv.indexOf('--');
  const [report, file, lineArg, mutator, nthArg] = argv.slice(0, sep < 0 ? argv.length : sep);
  const tests = sep < 0 ? [] : argv.slice(sep + 1);
  if (!report || !file || !lineArg || !mutator || tests.length === 0) {
    process.stderr.write('usage: node scripts/mutation-apply.ts <mutation.json> <file> <line> <mutatorName> [nth] -- <vitest files...>\n');
    return 2;
  }
  const entry = (JSON.parse(readFileSync(report, 'utf8')) as { files: Record<string, { source: string; mutants: Mutant[] }> }).files[file];
  const matches = entry.mutants.filter((m) => m.location.start.line === Number(lineArg) && m.mutatorName === mutator);
  const mutant = matches[Number(nthArg ?? 0)];
  if (!mutant) {
    process.stderr.write(`no ${mutator} mutant on ${file}:${lineArg} (nth ${nthArg ?? 0}, ${matches.length} found)\n`);
    return 2;
  }
  if (execFileSync('git', ['status', '--porcelain', '--', file]).toString().trim()) {
    process.stderr.write(`ABORT: ${file} has uncommitted changes\n`);
    return 2;
  }
  const current = readFileSync(file, 'utf8');
  const start = offsetOf(current, mutant.location.start.line, mutant.location.start.column);
  const end = offsetOf(current, mutant.location.end.line, mutant.location.end.column);
  const original = current.slice(start, end);
  const embedded = entry.source;
  if (embedded.slice(offsetOf(embedded, mutant.location.start.line, mutant.location.start.column), offsetOf(embedded, mutant.location.end.line, mutant.location.end.column)) !== original) {
    process.stderr.write('ABORT: working tree differs from the mutated source at this range\n');
    return 2;
  }
  process.stdout.write(`mutant ${mutant.id} (${mutator}) ${file}:${lineArg}: ${JSON.stringify(original.slice(0, 80))} -> ${JSON.stringify((mutant.replacement ?? '').slice(0, 80))}\n`);
  writeFileSync(file, current.slice(0, start) + (mutant.replacement ?? '') + current.slice(end));
  // Ctrl-C during the synchronous test run skips `finally`; restore on signals too.
  const restore = () => execFileSync('git', ['checkout', '-q', '--', file]);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { restore(); process.exit(130); });
  try {
    const run = spawnSync('npx', ['vitest', 'run', '--silent=true', ...tests], { encoding: 'utf8' });
    const tail = (run.stdout + run.stderr).split('\n').filter((l) => /Tests |Test Files /.test(l)).join(' | ');
    // A run that printed no summary (CLI error) must not read as a kill.
    const verdict = !tail ? 'ERROR (no vitest summary)' : run.status === 0 ? 'SURVIVED' : 'KILLED';
    process.stdout.write(`${verdict}: ${tail}\n`);
  } finally {
    restore();
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
