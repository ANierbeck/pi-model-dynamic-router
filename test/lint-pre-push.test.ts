// The pre-push half of the lint gate (docs/plans/2026-11-04-lint-gate.md).
//
// ESLint lints the WORKING TREE, but git pushes COMMITS. The two only agree
// when the pushed ref is the checked-out HEAD and the lint targets carry no
// uncommitted or untracked changes. Otherwise a local run would judge code
// that is not being pushed — blocking a clean push over unrelated WIP, or
// passing a push whose commits CI will reject. In those cases the hook skips
// with a notice and leaves the verdict to CI, which lints exactly the pushed
// commit.
import { describe, it, expect } from 'vitest';
import { prePushLintPlan } from '../scripts/lint-gate.ts';

const ZERO = '0'.repeat(40);
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const line = (localSha: string, remoteSha = ZERO): string =>
  `refs/heads/x ${localSha} refs/heads/x ${remoteSha}`;

describe('prePushLintPlan', () => {
  it('runs when the pushed commit is the clean checked-out HEAD', () => {
    expect(prePushLintPlan(`${line(HEAD, OTHER)}\n`, HEAD, [])).toEqual({ run: true });
  });

  it('skips a delete-only push (nothing is published)', () => {
    const plan = prePushLintPlan(`(delete) ${ZERO} refs/heads/x ${OTHER}\n`, HEAD, []);
    expect(plan.run).toBe(false);
    expect(plan.run === false && plan.reason).toMatch(/nothing to lint/);
  });

  it('skips when a pushed ref is not the checked-out HEAD', () => {
    const plan = prePushLintPlan(`${line(OTHER)}\n`, HEAD, []);
    expect(plan.run).toBe(false);
    expect(plan.run === false && plan.reason).toMatch(/not the checked-out HEAD/);
  });

  it('skips when lint targets have uncommitted or untracked changes', () => {
    const plan = prePushLintPlan(`${line(HEAD)}\n`, HEAD, ['src/wip.ts']);
    expect(plan.run).toBe(false);
    expect(plan.run === false && plan.reason).toMatch(/uncommitted changes.*src\/wip\.ts/);
  });

  it('ignores blank lines and trailing whitespace in the stdin git hands over', () => {
    expect(prePushLintPlan(`\n${line(HEAD)}  \n\n`, HEAD, [])).toEqual({ run: true });
  });
});
