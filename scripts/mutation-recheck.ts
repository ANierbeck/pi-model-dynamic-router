// Re-checks the undetected mutants (Survived + NoCoverage) of a Stryker JSON
// report against the FULL vitest suite, N mutants in parallel.
//
// Why: the nightly runs with coverageAnalysis "perTest", which only executes
// the tests the coverage pass attributed to a mutant. When that attribution
// misses the test that actually pins a line (observed in nightly R1: a
// mutant listed as covered by ONE unrelated test, while the dedicated test
// file kills it), the mutant is reported "Survived" although the suite
// detects it — a false survivor. Triage effort and the headline score are
// inflated by exactly those. This script separates false survivors (killed
// by the full suite) from the genuinely alive ones.
//
// The mutated tree is a pristine COPY (--tree, e.g. `git archive HEAD`
// extracted to a scratch dir), never the working repo. Each worker gets its
// own copy with node_modules symlinked. A mutant is applied by byte range
// (location from the report); the range text must match the copy, otherwise
// the mutant is reported as "stale" instead of being run.
//
// With --tests <comma-separated test files> only those files run per mutant
// (the second use: "which survivors do the NEW tests kill?").
//
// Usage: node scripts/mutation-recheck.ts <mutation.json> --tree <dir> --out <results.json> [--jobs 4] [--max-workers 3] [--tests a.test.ts,b.test.ts]
// Output: JSON array of { file, line, id, mutatorName, replacement, result: "killed"|"survived"|"stale"|"timeout", killer? }

import { cpSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Mutant {
  id: string;
  mutatorName: string;
  replacement?: string;
  status: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
}

interface Result {
  file: string;
  line: number;
  id: string;
  mutatorName: string;
  replacement: string;
  result: 'killed' | 'survived' | 'stale' | 'timeout';
  killer?: string;
}

const RUN_TIMEOUT_MS = 180_000;

function offsetOf(source: string, line: number, column: number): number {
  const lines = source.split('\n');
  let off = 0;
  for (let i = 0; i < line - 1; i++) off += lines[i].length + 1;
  return off + column - 1;
}

function flag(args: string[], name: string, fallback?: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
}

function runVitest(dir: string, maxWorkers: string, tests: string[]): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['vitest', 'run', '--silent=true', '--bail=1', `--maxWorkers=${maxWorkers}`, ...tests], { cwd: dir });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut: signal === 'SIGKILL' });
    });
  });
}

async function main(argv: string[]): Promise<number> {
  const reportPath = argv[0];
  const tree = flag(argv, '--tree');
  const outPath = flag(argv, '--out');
  const jobs = Number(flag(argv, '--jobs', '4'));
  const maxWorkers = flag(argv, '--max-workers', '3')!;
  const tests = (flag(argv, '--tests') ?? '').split(',').filter(Boolean);
  if (!reportPath || !tree || !outPath) {
    process.stderr.write('usage: node scripts/mutation-recheck.ts <mutation.json> --tree <dir> --out <results.json> [--jobs 4] [--max-workers 3] [--tests a.test.ts,b.test.ts]\n');
    return 2;
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { files: Record<string, { source: string; mutants: Mutant[] }> };
  const queue: { file: string; mutant: Mutant }[] = [];
  for (const [file, entry] of Object.entries(report.files)) {
    for (const mutant of entry.mutants) {
      if (mutant.status === 'Survived' || mutant.status === 'NoCoverage') queue.push({ file, mutant });
    }
  }

  const scratch = join(tmpdir(), `mutation-recheck-${process.pid}`);
  const results: Result[] = [];
  // A red unmutated tree would report every mutant as "killed" — verify the
  // baseline first (nightly R1 lesson: a node_modules symlink pointing at a
  // partial directory produced "435 killed" without a single real run).
  const baselineDir = join(scratch, 'baseline');
  cpSync(tree, baselineDir, { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) });
  symlinkSync(realpathSync(join(tree, 'node_modules')), join(baselineDir, 'node_modules'));
  const baseline = await runVitest(baselineDir, maxWorkers, tests);
  if (baseline.code !== 0) {
    process.stderr.write(`ABORT: the unmutated tree is not green:\n${baseline.out.slice(-1500)}\n`);
    rmSync(scratch, { recursive: true, force: true });
    return 2;
  }
  const worker = async (n: number): Promise<void> => {
    const dir = join(scratch, `w${n}`);
    cpSync(tree, dir, { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) });
    symlinkSync(realpathSync(join(tree, 'node_modules')), join(dir, 'node_modules'));
    const originals = new Map<string, string>();
    for (const file of Object.keys(report.files)) originals.set(file, readFileSync(join(dir, file), 'utf8'));
    for (let item = queue.shift(); item; item = queue.shift()) {
      const { file, mutant } = item;
      const original = originals.get(file)!;
      const embedded = report.files[file].source;
      const start = offsetOf(original, mutant.location.start.line, mutant.location.start.column);
      const end = offsetOf(original, mutant.location.end.line, mutant.location.end.column);
      const eStart = offsetOf(embedded, mutant.location.start.line, mutant.location.start.column);
      const eEnd = offsetOf(embedded, mutant.location.end.line, mutant.location.end.column);
      const base = { file, line: mutant.location.start.line, id: mutant.id, mutatorName: mutant.mutatorName, replacement: mutant.replacement ?? '' };
      if (original.slice(start, end) !== embedded.slice(eStart, eEnd)) {
        results.push({ ...base, result: 'stale' });
        continue;
      }
      writeFileSync(join(dir, file), original.slice(0, start) + (mutant.replacement ?? '') + original.slice(end));
      try {
        const run = await runVitest(dir, maxWorkers, tests);
        const killer = /FAIL\s+(\S+\.test\.ts)/.exec(run.out)?.[1];
        const result: Result['result'] = run.timedOut ? 'timeout' : run.code === 0 ? 'survived' : 'killed';
        results.push({ ...base, result, ...(killer ? { killer } : {}) });
      } finally {
        writeFileSync(join(dir, file), original);
      }
      if (results.length % 25 === 0) process.stderr.write(`${results.length} rechecked\n`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, (_, n) => worker(n)));
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(outPath, JSON.stringify(results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line), null, 1));
  const tally = results.reduce<Record<string, number>>((acc, r) => ((acc[r.result] = (acc[r.result] ?? 0) + 1), acc), {});
  process.stdout.write(`${JSON.stringify(tally)}\n`);
  return 0;
}

process.exit(await main(process.argv.slice(2)));
