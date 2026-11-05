// The format gate (docs/plans/2026-11-05-prettier-formatting.md): Prettier over
// the code scope (owner decision 1a: code only), enforced in CI and in the
// pre-push hook (owner decision 3: both). These pins hold the wiring in place:
// the scope, the pre-push skip wording, and the three integration points.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FORMAT_INPUTS } from '../scripts/format-gate.ts';
import { prePushLintPlan } from '../scripts/lint-gate.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

describe('format scope (owner decision 1a)', () => {
  it('covers exactly the code: src, test, scripts, index.ts, eslint.config.js', () => {
    // Code only — the shipped docs (1b) and the data files (1c) were
    // explicitly NOT chosen as scope.
    expect(FORMAT_INPUTS).toEqual(['src/', 'test/', 'scripts/', 'index.ts', 'eslint.config.js']);
  });

  it('exists as files or directories in the repository', () => {
    for (const input of FORMAT_INPUTS) {
      expect(fs.existsSync(path.join(repoRoot, input))).toBe(true);
    }
  });
});

describe('pre-push plan wording for the format gate', () => {
  const ZERO = '0'.repeat(40);
  const HEAD = 'a'.repeat(40);
  const line = (localSha: string, remoteSha = ZERO): string =>
    `refs/heads/x ${localSha} refs/heads/x ${remoteSha}`;

  it('speaks of formatting, not linting, when the subject is format', () => {
    const plan = prePushLintPlan(`(delete) ${ZERO} refs/heads/x ${HEAD}\n`, HEAD, [], 'format');
    expect(plan.run).toBe(false);
    expect(plan.run === false && plan.reason).toMatch(/nothing to format/);
  });

  it('names the format inputs when they are dirty', () => {
    const plan = prePushLintPlan(`${line(HEAD)}\n`, HEAD, ['src/wip.ts'], 'format');
    expect(plan.run).toBe(false);
    expect(plan.run === false && plan.reason).toMatch(/uncommitted changes in format inputs.*src\/wip\.ts/);
  });

  it('keeps the lint wording for the lint gate (default subject unchanged)', () => {
    const plan = prePushLintPlan(`${line(HEAD)}\n`, HEAD, ['src/wip.ts']);
    expect(plan.run).toBe(false);
    expect(plan.run === false && plan.reason).toMatch(/uncommitted changes in lint inputs/);
  });
});

describe('wiring pins', () => {
  it('package.json exposes format and format:check scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['format']).toMatch(/format-gate\.ts/);
    expect(pkg.scripts['format']).toMatch(/--write/);
    expect(pkg.scripts['format:check']).toMatch(/format-gate\.ts/);
  });
});
