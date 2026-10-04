// Summarizes a Stryker mutation-testing JSON report for the nightly run
// (.github/workflows/mutation-nightly.yml) into a markdown block for the
// GitHub job summary.
//
// The mutation-testing report schema carries no aggregate metrics — only
// files -> mutants[].status — so the summary is computed here with Stryker's
// own score definition: detected (Killed + Timeout) divided by valid mutants
// (detected + Survived + NoCoverage). CompileError/RuntimeError, Ignored and
// Pending are not valid mutants and do not enter the score.
//
// Usage: node scripts/mutation-summary.ts [reports/mutation/mutation.json]

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface MutationSummary {
  total: number;
  killed: number;
  timedOut: number;
  survived: number;
  noCoverage: number;
  errors: number;
  ignored: number;
  /** Detected / valid mutants, in percent with one decimal. 0 when there are no valid mutants. */
  score: number;
  /** Undetected (Survived + NoCoverage) mutants per file, most first; files with none omitted. */
  survivorsByFile: Record<string, number>;
}

export function summarizeMutationReport(report: unknown): MutationSummary {
  const s: MutationSummary = {
    total: 0, killed: 0, timedOut: 0, survived: 0, noCoverage: 0, errors: 0, ignored: 0,
    score: 0, survivorsByFile: {},
  };
  const files = (report as { files?: Record<string, { mutants?: { status?: string }[] }> } | null)?.files;
  if (!files || typeof files !== 'object') return s;

  const undetected: [string, number][] = [];
  for (const [file, entry] of Object.entries(files)) {
    let fileUndetected = 0;
    for (const m of entry?.mutants ?? []) {
      s.total++;
      switch (m?.status) {
        case 'Killed': s.killed++; break;
        case 'Timeout': s.timedOut++; break;
        case 'Survived': s.survived++; fileUndetected++; break;
        case 'NoCoverage': s.noCoverage++; fileUndetected++; break;
        case 'CompileError':
        case 'RuntimeError': s.errors++; break;
        default: s.ignored++; // Ignored, Pending, unknown
      }
    }
    if (fileUndetected) undetected.push([file, fileUndetected]);
  }

  const detected = s.killed + s.timedOut;
  const valid = detected + s.survived + s.noCoverage;
  s.score = valid ? Math.round((1000 * detected) / valid) / 10 : 0;
  undetected.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  s.survivorsByFile = Object.fromEntries(undetected);
  return s;
}

export function formatSummary(s: MutationSummary): string {
  const lines = [
    '## Nightly mutation testing',
    '',
    `Mutation score: ${s.score}%`,
    '',
    `Mutants: ${s.total} | killed: ${s.killed} | timeout: ${s.timedOut} | survived: ${s.survived}` +
      ` | no coverage: ${s.noCoverage} | errors: ${s.errors} | ignored: ${s.ignored}`,
  ];
  const files = Object.entries(s.survivorsByFile);
  if (files.length) {
    lines.push('', '| File | Undetected mutants |', '|---|---|');
    for (const [file, n] of files) lines.push(`| ${file} | ${n} |`);
  }
  return lines.join('\n') + '\n';
}

function main(argv: string[]): number {
  const file = argv[0] ?? 'reports/mutation/mutation.json';
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    process.stdout.write(`## Nightly mutation testing\n\nNo mutation report at ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 0; // report-only: a missing report must not fail the summary step
  }
  process.stdout.write(formatSummary(summarizeMutationReport(report)));
  return 0;
}

// Same direct-invocation guard as scripts/secret-scan.ts: importing the
// module (tests) must never run main().
function invokedDirectly(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exit(main(process.argv.slice(2)));
