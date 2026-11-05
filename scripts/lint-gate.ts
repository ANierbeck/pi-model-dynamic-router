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
// Usage: node scripts/lint-gate.ts [--write | --pre-push]
//   --write     regenerate the baseline from the current findings
//   --pre-push  git hook mode (.githooks/pre-push): reads git's ref list on
//               stdin and skips with a notice when the working tree is not
//               what is being pushed (see prePushLintPlan)
import { ESLint } from 'eslint';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { invokedDirectly } from './lib/cli.ts';

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
/** Paths whose uncommitted state changes the lint verdict. */
const LINT_INPUTS = [...TARGETS, 'eslint.config.js', 'tsconfig.json', 'package.json'];
const SEP = '\u0000';
const ZERO_SHA = /^0+$/;

export type PrePushLintPlan = { run: true } | { run: false; reason: string };

/**
 * Whether the pre-push hook should run the gate. ESLint lints the working
 * tree, git pushes commits; they only agree when every pushed ref is the
 * checked-out HEAD and the lint inputs carry no uncommitted or untracked
 * changes. Otherwise the local verdict would be about code that is not being
 * pushed, so the hook skips with a reason and CI — which lints exactly the
 * pushed commit — decides.
 *
 * @param stdin git's pre-push input: "<local ref> <local sha> <remote ref> <remote sha>" per line
 * @param head  `git rev-parse HEAD`
 * @param dirty lint-input paths from `git status --porcelain`
 */
export function prePushLintPlan(stdin: string, head: string, dirty: readonly string[]): PrePushLintPlan {
  const pushed = stdin
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[1] ?? '')
    .filter((sha) => sha !== '' && !ZERO_SHA.test(sha));
  if (pushed.length === 0) return { run: false, reason: 'nothing to lint (delete-only push)' };
  if (pushed.some((sha) => sha !== head)) {
    return { run: false, reason: 'a pushed ref is not the checked-out HEAD; CI lints the pushed commit' };
  }
  if (dirty.length > 0) {
    return {
      run: false,
      reason: `uncommitted changes in lint inputs (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', ...' : ''}); CI lints the pushed commit`,
    };
  }
  return { run: true };
}

function prePushPlanFromGit(root: string): PrePushLintPlan {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const dirty = git('status', '--porcelain', '--untracked-files=all', '--', ...LINT_INPUTS)
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => l.slice(3));
  return prePushLintPlan(readFileSync(0, 'utf-8'), git('rev-parse', 'HEAD').trim(), dirty);
}

/** Aggregate ESLint results into canonical (file, rule) counts. */
/** Entries --write must not baseline: a parse error (`fatal`) is never accepted as known. */
export function refusedBaselineEntries(found: readonly LintEntry[]): LintEntry[] {
  return found.filter((entry) => entry.rule === 'fatal');
}

export function toEntries(results: ESLint.LintResult[], root: string): LintEntry[] {
  const counts = new Map<string, number>();
  for (const result of results) {
    const file = result.filePath.slice(root.length + 1).split('\\').join('/');
    for (const message of result.messages) {
      // A real parse error has `fatal: true` and no ruleId; an unused
      // eslint-disable directive also has no ruleId but is NOT fatal. Bucketing
      // both as 'fatal' would let a genuine parse error hide behind a baselined
      // directive warning.
      const rule = message.fatal ? 'fatal' : (message.ruleId ?? 'eslint-directive');
      const key = `${file}${SEP}${rule}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [file, rule] = key.split(SEP);
      return { file, rule, count };
    })
    // UTF-16 code-unit order, matching Array.prototype.sort() on strings — the
    // canonical check in test/lint-baseline.test.ts uses exactly that, and
    // localeCompare orders differently (a_b before a-b).
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
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
  if (process.argv.includes('--pre-push')) {
    const plan = prePushPlanFromGit(root);
    if (!plan.run) {
      console.error(`lint gate (pre-push): skipped, ${plan.reason}`);
      return;
    }
  }
  const results = await new ESLint({ cwd: root }).lintFiles(TARGETS);
  const found = toEntries(results, root);
  const total = found.reduce((sum, entry) => sum + entry.count, 0);

  if (write) {
    const refused = refusedBaselineEntries(found);
    if (refused.length > 0) {
      console.error(
        `refusing --write: ${refused.map((e) => e.file).join(', ')} does not parse. Fix the syntax error; a parse error is never baselined.`
      );
      process.exitCode = 1;
      return;
    }
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

// invokedDirectly(), not a hand-rolled `file://${argv[1]}` comparison: the naive
// form fails open on paths with a space (argv[1] is not percent-encoded), which
// is how the pre-push hook once silently stopped rejecting leaks.
if (invokedDirectly(import.meta.url)) {
  await main();
}
