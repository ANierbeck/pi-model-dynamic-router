// The git half of the pre-push lint plan (docs/plans/2026-11-04-lint-gate.md).
//
// prePushLintPlan is pure and is tested in lint-pre-push.test.ts. This file
// covers what it is fed: `git status --porcelain` for the lint inputs and
// `git rev-parse HEAD`, run against throwaway repositories. The status output
// is where the subtle cases live (renames, untracked files, pathspecs), so the
// plan is checked against real git, not against a hand-written status string.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prePushPlanFromGit } from '../scripts/lint-gate.ts';

const ZERO = '0'.repeat(40);
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** git's pre-push stdin for pushing `localSha` to a new remote branch. */
const pushOf = (localSha: string): string => `refs/heads/x ${localSha} refs/heads/x ${ZERO}\n`;

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'lint-pre-push-git-'));
  git(repo, 'init', '-q');
  mkdirSync(join(repo, 'test'));
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'test', 'a.test.ts'), 'export {};\n');
  writeFileSync(join(repo, 'src', 'a.ts'), 'export {};\n');
  writeFileSync(join(repo, 'docs', 'a.md'), '# a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const head = (): string => git(repo, 'rev-parse', 'HEAD');

describe('prePushPlanFromGit — against real git status', () => {
  it('runs for a clean checkout whose HEAD is the pushed commit', () => {
    expect(prePushPlanFromGit(repo, pushOf(head()))).toEqual({ run: true });
  });

  it('skips when a tracked lint input has unstaged changes', () => {
    writeFileSync(join(repo, 'test', 'a.test.ts'), 'export const x = 1;\n');
    const plan = prePushPlanFromGit(repo, pushOf(head()));
    expect(plan.run).toBe(false);
    expect(plan.run === false && plan.reason).toMatch(/uncommitted changes in lint inputs/);
  });

  it('skips for an UNTRACKED file under a lint target (--untracked-files=all)', () => {
    writeFileSync(join(repo, 'src', 'new.ts'), 'export {};\n');
    expect(prePushPlanFromGit(repo, pushOf(head())).run).toBe(false);
  });

  it('still runs when only non-lint files are dirty (docs are not lint inputs)', () => {
    writeFileSync(join(repo, 'docs', 'a.md'), '# changed\n');
    writeFileSync(join(repo, 'docs', 'untracked.md'), 'x\n');
    expect(prePushPlanFromGit(repo, pushOf(head()))).toEqual({ run: true });
  });

  it('skips for a STAGED rename that moves a file out of a lint target', () => {
    // Porcelain prints `R  test/a.test.ts -> docs/a.test.ts` when both paths
    // are visible, or a deletion when only the source matches the pathspec.
    // Either way the lint input is in the dirty list, so the verdict is CI's.
    git(repo, 'mv', 'test/a.test.ts', 'docs/a.test.ts');
    expect(prePushPlanFromGit(repo, pushOf(head())).run).toBe(false);
  });

  it('skips when a pushed ref is not the checked-out HEAD', () => {
    const older = git(repo, 'rev-parse', 'HEAD~0');
    writeFileSync(join(repo, 'docs', 'b.md'), 'b\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'second');
    const plan = prePushPlanFromGit(repo, pushOf(older));
    expect(plan.run).toBe(false);
    expect(plan.run === false && plan.reason).toMatch(/not the checked-out HEAD/);
  });
});
