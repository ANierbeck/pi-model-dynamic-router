#!/usr/bin/env node
// Format gate: runs Prettier over the code scope and fails on any file that
// does not match the format (docs/plans/2026-11-05-prettier-formatting.md).
// The scope is owner decision 1a — code only; the shipped docs and the data
// files are deliberately excluded (see .prettierignore for the full picture).
// Enforced in the required CI job and in the pre-push hook (owner decision 3),
// which skips with a notice when the working tree is not what is being pushed,
// exactly like the lint gate.
//
// Usage: node scripts/format-gate.ts [--write | --pre-push]
//   --write     reformat the scope in place (`npm run format`)
//   --pre-push  git hook mode (.githooks/pre-push): reads git's ref list on
//               stdin and skips with a notice when the working tree is not
//               what is being pushed (see prePushLintPlan in lint-gate.ts)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { invokedDirectly } from './lib/cli.ts';
import { prePushPlanFromGit } from './lint-gate.ts';

/** The format scope (owner decision 1a): the code, nothing else. */
export const FORMAT_INPUTS = ['src/', 'test/', 'scripts/', 'index.ts', 'eslint.config.js'] as const;

// A dirty .prettierrc/.prettierignore also changes what the local check
// verifies, so they count as format inputs for the pre-push skip decision.
const PRE_PUSH_DIRTY_INPUTS = [...FORMAT_INPUTS, '.prettierrc', '.prettierignore'];

const prettierBin = createRequire(import.meta.url).resolve('prettier/bin/prettier.cjs');

function runPrettier(mode: '--check' | '--write'): void {
  execFileSync(process.execPath, [prettierBin, mode, ...FORMAT_INPUTS], { stdio: 'inherit' });
}

function main(): void {
  if (process.argv.includes('--pre-push')) {
    const plan = prePushPlanFromGit(process.cwd(), readFileSync(0, 'utf-8'), PRE_PUSH_DIRTY_INPUTS, 'format');
    if (!plan.run) {
      console.error(`format gate (pre-push): skipped, ${plan.reason}`);
      return;
    }
    runPrettier('--check');
  } else if (process.argv.includes('--write')) {
    runPrettier('--write');
  } else {
    runPrettier('--check');
  }
}

// Run only as a script, not when a test imports the module for its exports.
if (invokedDirectly(import.meta.url)) {
  main();
}
