// Produce a Stryker-format mutation report (all mutants, status NoCoverage)
// for ONE file, so scripts/mutation-recheck.ts can run them against the full
// suite. The nightly Stryker run only reports the mutants its own test run
// left undetected; to triage a REGION (a function, a slice) we need every
// mutant of the region, including the ones the nightly already killed — the
// region may have grown since, and the killed-by-attribution can be wrong
// (the reason mutation-recheck.ts exists).
//
// The instrumenter is normally built by Stryker's DI container; a bare one
// only needs a logger (typed-inject provides the rest).

import { createInstrumenter } from '@stryker-mutator/instrumenter';
import { commonTokens } from '@stryker-mutator/api/plugin';
import type { Logger } from '@stryker-mutator/api/logging';
import { createInjector } from 'typed-inject';
import { readFileSync, writeFileSync } from 'node:fs';
import { invokedDirectly } from './lib/cli.ts';

/** A mutant in the JSON-report convention that mutation-recheck.ts consumes. */
export interface ReportMutant {
  id: string;
  mutatorName: string;
  replacement: string | undefined;
  status: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
}

/** The report schema mutation-recheck.ts reads (schemaVersion 3.0.0). */
export interface OneFileReport {
  files: Record<string, { language: string; source: string; mutants: ReportMutant[] }>;
  schemaVersion: string;
  thresholds: { high: number; low: number; break: number };
  testFiles: unknown[];
  projectRoot: string;
}

/**
 * Instruments one in-memory file and returns its mutants in the JSON-report
 * convention: 1-based lines AND 1-based columns, the same convention the
 * real Stryker report uses and that scripts/lib/cli.ts `offsetOf()` — the
 * function mutation-recheck.ts applies mutants with — expects.
 */
export async function instrumentOne(name: string, source: string): Promise<ReportMutant[]> {
  const logger: Logger = {
    debug(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
    trace(): void {},
    fatal(): void {},
    isDebugEnabled: (): boolean => false,
    isInfoEnabled: (): boolean => false,
    isTraceEnabled: (): boolean => false,
    isWarnEnabled: (): boolean => false,
    isErrorEnabled: (): boolean => false,
    isFatalEnabled: (): boolean => false,
  };
  // BaseContext wants both the logger and its factory; the instrumenter only
  // reads the logger, so the factory is a no-op.
  const injector = createInjector()
    .provideValue(commonTokens.getLogger, (): Logger => logger)
    .provideValue(commonTokens.logger, logger);
  const instrumenter = injector.injectFunction(createInstrumenter);
  const result = await instrumenter.instrument([{ name, mutate: true, content: source }], {
    plugins: null,
    excludedMutations: [],
    ignorers: [],
  });
  // Convert the instrumenter's INTERNAL 0-based positions to the JSON-report
  // convention: 1-based lines AND 1-based columns. mutation-recheck.ts
  // applies mutants with offsetOf(), which is 1-based in both axes — a
  // 0-based passthrough shifts every mutant one line up and one column
  // left (slice 2 incident, 2026-11-05; pinned by
  // test/mutation-instrument-one.test.ts).
  return result.mutants.map((m) => ({
    id: m.id,
    mutatorName: m.mutatorName,
    replacement: m.replacement,
    status: 'NoCoverage',
    location: {
      start: { line: m.location.start.line + 1, column: m.location.start.column + 1 },
      end: { line: m.location.end.line + 1, column: m.location.end.column + 1 },
    },
  }));
}

/** Builds the full one-file report for a source file on disk. */
export async function buildReport(file: string, projectRoot: string): Promise<OneFileReport> {
  const source = readFileSync(file, 'utf8');
  const mutants = await instrumentOne(file, source);
  return {
    files: { [file]: { language: 'typescript', source, mutants } },
    schemaVersion: '3.0.0',
    thresholds: { high: 80, low: 60, break: 0 },
    testFiles: [],
    projectRoot,
  };
}

if (invokedDirectly(import.meta.url)) {
  const [file, out] = process.argv.slice(2);
  if (!file || !out) {
    process.stderr.write('usage: node scripts/mutation-instrument-one.ts <file> <out.json>\n');
    process.exit(2);
  }
  const report = await buildReport(file, process.cwd());
  writeFileSync(out, JSON.stringify(report));
  process.stdout.write(`${file}: ${report.files[file].mutants.length} mutants -> ${out}\n`);
}
