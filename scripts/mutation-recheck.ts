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
// A kill is only counted when it is CONFIRMED: the failing test file named by
// vitest is re-run ALONE against the same mutated copy (it must fail there)
// and ALONE against the unmutated baseline (it must pass there). This rejects
// kills by tests that cannot load the mutated module and kills caused by
// shared-state races between the parallel jobs (nightly R1 review I1: a test
// deleting a fixed shared tmp dir "killed" 14 mutants it could never see).
// Confirmation runs in a SERIAL pass after the worker pool has drained, so a
// lone-file failure cannot be a parallel-load artifact either (R1 re-review
// m2). Unconfirmed kills are reported as "unconfirmed" with the rejected
// files.
//
// With --tests <comma-separated test files> only those files run per mutant
// (the second use: "which survivors do the NEW tests kill?").
//
// Usage: node scripts/mutation-recheck.ts <mutation.json> --tree <dir> --out <results.json> [--jobs 4] [--max-workers 3] [--tests a.test.ts,b.test.ts]
// Output: JSON array of { file, line, id, mutatorName, replacement, result: "killed"|"survived"|"stale"|"timeout"|"unconfirmed", killer?, rejected? }

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
  result: 'killed' | 'survived' | 'stale' | 'timeout' | 'unconfirmed';
  killer?: string;
  rejected?: string[];
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

// Live vitest children, so a signal can kill them before the scratch dir is
// removed (R1 re-review m4: orphaned runs kept writing into a deleted dir).
const liveChildren = new Set<ReturnType<typeof spawn>>();

function runVitest(dir: string, maxWorkers: string, tests: string[], bail = true): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['vitest', 'run', '--silent=true', ...(bail ? ['--bail=1'] : []), `--maxWorkers=${maxWorkers}`, ...tests], { cwd: dir });
    liveChildren.add(child);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      liveChildren.delete(child);
      clearTimeout(timer);
      resolve({ code, out, timedOut: signal === 'SIGKILL' });
    });
  });
}

function failingFiles(out: string): string[] {
  return [...new Set([...out.matchAll(/FAIL\s+(\S+\.test\.ts)/g)].map((m) => m[1]))];
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

  const treeDir: string = tree;
  const outFile: string = outPath;
  const scratch = join(tmpdir(), `mutation-recheck-${process.pid}`);
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { for (const c of liveChildren) c.kill('SIGKILL'); cleanup(); process.exit(130); });
  try {
    return await recheck();
  } finally {
    cleanup();
  }

  async function recheck(): Promise<number> {
  const results: Result[] = [];
  // A red unmutated tree would report every mutant as "killed" — verify the
  // baseline first (nightly R1 lesson: a node_modules symlink pointing at a
  // partial directory produced "435 killed" without a single real run).
  const baselineDir = join(scratch, 'baseline');
  cpSync(treeDir, baselineDir, { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) });
  symlinkSync(realpathSync(join(treeDir, 'node_modules')), join(baselineDir, 'node_modules'));
  const baseline = await runVitest(baselineDir, maxWorkers, tests);
  if (baseline.code !== 0) {
    process.stderr.write(`ABORT: the unmutated tree is not green:\n${baseline.out.slice(-1500)}\n`);
    return 2;
  }
  // Per test file, run alone on the unmutated baseline (cached): a killer
  // that is not green on its own cannot be trusted as a killer.
  const greenAlone = new Map<string, Promise<boolean>>();
  const isGreenAlone = (file: string): Promise<boolean> => {
    if (!greenAlone.has(file)) greenAlone.set(file, runVitest(baselineDir, maxWorkers, [file], false).then((r) => r.code === 0 && !r.timedOut));
    return greenAlone.get(file)!;
  };
  /** First candidate file that fails ALONE on the mutated copy and is green alone on the baseline. */
  const confirm = async (dir: string, candidates: string[]): Promise<{ killer?: string; rejected: string[] }> => {
    const rejected: string[] = [];
    for (const file of candidates) {
      const alone = (await isGreenAlone(file)) ? await runVitest(dir, maxWorkers, [file], false) : undefined;
      if (alone && !alone.timedOut && alone.code !== 0 && failingFiles(alone.out).includes(file)) return { killer: file, rejected };
      rejected.push(file);
    }
    return { rejected };
  };
  const pending: Array<{ base: Omit<Result, 'result'>; dir: string; file: string; mutated: string; original: string; bailOut: string; timedOut: boolean }> = [];
  const worker = async (n: number): Promise<void> => {
    const dir = join(scratch, `w${n}`);
    cpSync(treeDir, dir, { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) });
    symlinkSync(realpathSync(join(treeDir, 'node_modules')), join(dir, 'node_modules'));
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
      const mutated = original.slice(0, start) + (mutant.replacement ?? '') + original.slice(end);
      writeFileSync(join(dir, file), mutated);
      try {
        const run = await runVitest(dir, maxWorkers, tests);
        if (!run.timedOut && run.code === 0) {
          results.push({ ...base, result: 'survived' });
        } else {
          // NOT confirmed here: the other workers are still running full
          // suites, so a lone-file failure could still be a load artifact.
          // The serial pass after the pool drains re-applies the mutant and
          // confirms the kill without any parallel load (R1 re-review m2).
          pending.push({ base, dir, file, mutated, original, bailOut: run.out, timedOut: run.timedOut });
        }
      } finally {
        writeFileSync(join(dir, file), original);
      }
      if (results.length % 25 === 0) process.stderr.write(`${results.length} rechecked\n`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, (_, n) => worker(n)));
  // Serial kill confirmation, after the pool drained: a lone-file failure on
  // a mutated copy is now free of parallel-load timing.
  for (const p of pending) {
    const dir = p.dir;
    writeFileSync(join(dir, p.file), p.mutated);
    try {
      // bail=1 names only the first failing file; if it does not confirm,
      // widen to every failing file of a full (non-bail) run.
      let { killer, rejected } = await confirm(dir, failingFiles(p.bailOut));
      if (!killer) {
        const full = await runVitest(dir, maxWorkers, tests, false);
        const more = failingFiles(full.out).filter((f) => !rejected.includes(f));
        const second = await confirm(dir, more);
        killer = second.killer;
        rejected = [...rejected, ...second.rejected];
      }
      const result: Result['result'] = killer ? 'killed' : p.timedOut ? 'timeout' : 'unconfirmed';
      results.push({ ...p.base, result, ...(killer ? { killer } : {}), ...(rejected.length ? { rejected } : {}) });
    } finally {
      writeFileSync(join(dir, p.file), p.original);
    }
  }
  writeFileSync(outFile, JSON.stringify(results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line), null, 1));
  const tally = results.reduce<Record<string, number>>((acc, r) => ((acc[r.result] = (acc[r.result] ?? 0) + 1), acc), {});
  process.stdout.write(`${JSON.stringify(tally)}\n`);
  return 0;
  }
}

process.exit(await main(process.argv.slice(2)));
