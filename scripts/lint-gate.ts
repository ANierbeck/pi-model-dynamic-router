#!/usr/bin/env node
// Lint gate: runs ESLint and compares the findings against a ratcheting
// baseline (scripts/lint-baseline.json). The baseline may only shrink; a
// finding above its entry fails the run, and an entry below it is stale and has
// to be lowered in the same change.
//
// Same shape as the two ratchets this repo already has: ADR-0025
// (scripts/hardcoded-model-baseline.json) and the redundancy report
// (scripts/redundancy-baseline.json). See docs/plans/2026-11-04-lint-gate.md.
//
// Usage: node scripts/lint-gate.ts [--write]
//   --write  regenerate the baseline from the current findings
import { ESLint } from 'eslint';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LintEntry {
  /** Repo-relative path with POSIX separators. */
  file: string;
  rule: string;
  count: number;
}

export interface LintBaseline {
  note: string;
  entries: LintEntry[];
}

const BASELINE_PATH = 'scripts/lint-baseline.json';
const TARGETS = ['src', 'index.ts', 'scripts', 'test'];
const SEP = '\u0000';

/** Aggregate ESLint results into canonical (file, rule) counts. */
export function toEntries(results: ESLint.LintResult[], root: string): LintEntry[] {
  const counts = new Map<string, number>();
  for (const result of results) {
    const file = result.filePath.slice(root.length + 1).split('\\').join('/');
    for (const message of result.messages) {
      const key = `${file}${SEP}${message.ruleId ?? 'fatal'}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [file, rule] = key.split(SEP);
      return { file, rule, count };
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
}

/**
 * Two violation kinds, the same contract as the ADR-0025 guard's
 * compareToBaseline (scripts/scan-hardcoded-models.ts): a finding above its
 * baseline entry is NEW, a finding below it means the entry is stale and has to
 * be lowered. Kept separate rather than shared: that one aggregates line
 * numbers per literal and formats a different message, so a common helper would
 * need four callbacks for two call sites.
 */
export function compareLintFindingsToBaseline(found: LintEntry[], baseline: LintEntry[]): string[] {
  const remaining = new Map(baseline.map((e) => [`${e.file}${SEP}${e.rule}`, e.count]));
  const violations: string[] = [];
  for (const entry of found) {
    const key = `${entry.file}${SEP}${entry.rule}`;
    const allowed = remaining.get(key) ?? 0;
    if (entry.count > allowed) {
      violations.push(`NEW ${entry.rule} in ${entry.file}: ${entry.count} (baseline ${allowed})`);
    } else if (entry.count < allowed) {
      // A lowered count is a cleanup that forgot to lower the baseline. Left
      // unchecked it would silently hand out headroom for a future regression.
      violations.push(
        `BASELINE entry is stale and must be LOWERED: ${entry.rule} in ${entry.file} ` +
          `(baseline ${allowed}, found ${entry.count})`,
      );
    }
    remaining.delete(key);
  }
  for (const [key, count] of remaining) {
    const [file, rule] = key.split(SEP);
    violations.push(
      `BASELINE entry is stale and must be REMOVED: ${rule} in ${file} (${count}, no findings left)`,
    );
  }
  return violations;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const write = process.argv.includes('--write');
  const results = await new ESLint({ cwd: root }).lintFiles(TARGETS);
  const found = toEntries(results, root);
  const total = found.reduce((sum, entry) => sum + entry.count, 0);

  if (write) {
    const baseline: LintBaseline = {
      note: 'Ratcheting lint baseline (docs/plans/2026-11-04-lint-gate.md). Only shrinks.',
      entries: found,
    };
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`wrote ${BASELINE_PATH}: ${found.length} entries, ${total} findings`);
    return;
  }

  const baseline = JSON.parse(readFileSync(join(root, BASELINE_PATH), 'utf8')) as LintBaseline;
  const violations = compareLintFindingsToBaseline(found, baseline.entries);
  if (violations.length > 0) {
    console.error(violations.slice(0, 50).join('\n'));
    if (violations.length > 50) console.error(`... and ${violations.length - 50} more`);
    console.error(`\n${violations.length} violation(s). Fix them, or lower ${BASELINE_PATH}.`);
    process.exit(1);
  }
  console.log(`lint gate ok: ${total} findings, all baselined`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
