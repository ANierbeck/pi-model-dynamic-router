// scripts/redundancy-report.ts — the pure analysis behind the redundancy gate
// (docs/plans/2026-10-29-repo-hygiene.md, Phase 0). File contents and file
// lists go in as plain arrays, findings come out; no file system in the unit
// under test. The CLI that feeds it lives in the same script.

import { describe, it, expect } from 'vitest';
import { analyze, type AnalyzeInput } from '../scripts/redundancy-report.ts';

const empty = (): AnalyzeInput => ({
  code: [],
  tests: [],
  docs: [],
  shipped: [],
  plans: [],
  rootFiles: [],
  rootAllowlist: [],
});

describe('duplicate function names', () => {
  it('reports a helper defined in two files once, with both paths', () => {
    const r = analyze({
      ...empty(),
      code: [
        { path: 'scripts/a.ts', text: 'function pct(n: number) { return n; }\n' },
        { path: 'scripts/b.ts', text: 'export function pct(n: number) { return n * 100; }\n' },
        { path: 'scripts/c.ts', text: 'const pct = (n: number) => n;\n' },
      ],
    });
    expect(r.duplicateFunctions).toEqual([{ name: 'pct', paths: ['scripts/a.ts', 'scripts/b.ts', 'scripts/c.ts'] }]);
  });

  it('does not report a name that lives in one file, or the entry-point name main', () => {
    const r = analyze({
      ...empty(),
      code: [
        { path: 'scripts/a.ts', text: 'function only() {}\nasync function main() {}\n' },
        { path: 'scripts/b.ts', text: 'async function main() {}\n' },
      ],
    });
    expect(r.duplicateFunctions).toEqual([]);
  });

  it('does not count a nested or indented definition as a top-level helper', () => {
    const r = analyze({
      ...empty(),
      code: [
        { path: 'a.ts', text: 'function outer() {\n  function inner() {}\n}\n' },
        { path: 'b.ts', text: 'function outer2() {\n  function inner() {}\n}\n' },
      ],
    });
    expect(r.duplicateFunctions).toEqual([]);
  });
});

describe('repeated test blocks', () => {
  const block = (n: number) =>
    Array.from({ length: n }, (_, i) => `  const configuredValue${i} = buildSomethingLong(argument${i}, other${i});`).join('\n');

  it('counts a 6-line block that appears in at least three test files', () => {
    const body = `describe('x', () => {\n${block(6)}\n});\n`;
    const r = analyze({
      ...empty(),
      tests: [
        { path: 'test/a.test.ts', text: body },
        { path: 'test/b.test.ts', text: body },
        { path: 'test/c.test.ts', text: body },
      ],
    });
    expect(r.repeatedBlocks.length).toBe(1);
    expect(r.repeatedBlocks[0]!.files).toBe(3);
  });

  it('ignores a block that appears in only two files', () => {
    const body = `${block(6)}\n`;
    const r = analyze({
      ...empty(),
      tests: [
        { path: 'test/a.test.ts', text: body },
        { path: 'test/b.test.ts', text: body },
        { path: 'test/c.test.ts', text: 'it("unrelated", () => {});\n' },
      ],
    });
    expect(r.repeatedBlocks).toEqual([]);
  });

  it('counts a long shared block once, not once per sliding window', () => {
    const body = `${block(12)}\n`;
    const r = analyze({
      ...empty(),
      tests: ['a', 'b', 'c'].map((n) => ({ path: `test/${n}.test.ts`, text: body })),
    });
    expect(r.repeatedBlocks.length).toBe(1);
  });

  it('ignores blocks made of trivial lines (closing braces, short statements)', () => {
    const trivial = '});\n});\n});\n});\n});\n});\n});\n';
    const r = analyze({
      ...empty(),
      tests: ['a', 'b', 'c'].map((n) => ({ path: `test/${n}.test.ts`, text: trivial })),
    });
    expect(r.repeatedBlocks).toEqual([]);
  });
});

describe('ollama mock boilerplate', () => {
  it('lists the test files that mock ollama-utils', () => {
    const r = analyze({
      ...empty(),
      tests: [
        { path: 'test/a.test.ts', text: "vi.mock('../src/ollama-utils.ts', () => ({}));\n" },
        { path: 'test/b.test.ts', text: "vi.mock('../src/ollama-utils', async (orig) => ({}));\n" },
        { path: 'test/c.test.ts', text: "vi.mock('../src/logger.ts', () => ({}));\n" },
      ],
    });
    expect(r.ollamaMockFiles).toEqual(['test/a.test.ts', 'test/b.test.ts']);
  });
});

describe('stale group names in shipped docs', () => {
  const old = 'Groups: strategic, tactical and the fallback group.\n';

  it('is a finding in a shipped doc, with path, line and the name', () => {
    const r = analyze({
      ...empty(),
      docs: [{ path: 'PI.md', text: `# Pi\n${old}` }],
      shipped: ['PI.md'],
    });
    expect(r.staleNames.map((s) => [s.path, s.line, s.name])).toEqual([
      ['PI.md', 2, 'strategic'],
      ['PI.md', 2, 'tactical'],
      ['PI.md', 2, 'fallback group'],
    ]);
  });

  it('is not a finding in a doc that does not ship', () => {
    const r = analyze({ ...empty(), docs: [{ path: 'docs/architecture.md', text: old }], shipped: ['PI.md'] });
    expect(r.staleNames).toEqual([]);
  });

  it('is not a finding in historical directories even if listed as shipped', () => {
    const r = analyze({
      ...empty(),
      docs: [
        { path: 'docs/adr/0007-escalation.md', text: old },
        { path: 'docs/plans/x.md', text: old },
        { path: 'docs/research/y.md', text: old },
        { path: 'CHANGELOG.md', text: old },
      ],
      shipped: ['docs/', 'CHANGELOG.md'],
    });
    expect(r.staleNames).toEqual([]);
  });

  it('a shipped directory entry covers the files below it', () => {
    const r = analyze({
      ...empty(),
      docs: [{ path: 'skills/router-login/SKILL.md', text: 'use the scout group\n' }],
      shipped: ['skills/'],
    });
    expect(r.staleNames.map((s) => s.name)).toEqual(['scout']);
  });

  it('matches whole words only', () => {
    const r = analyze({
      ...empty(),
      docs: [{ path: 'PI.md', text: 'a tactically sound, strategically placed scouting plan\n' }],
      shipped: ['PI.md'],
    });
    expect(r.staleNames).toEqual([]);
  });
});

describe('root files', () => {
  it('flags a tracked root file that is not on the allowlist', () => {
    const r = analyze({
      ...empty(),
      rootFiles: [
        { path: 'README.md', tracked: true },
        { path: 'FINAL_SUMMARY.md', tracked: true },
      ],
      rootAllowlist: ['README.md'],
    });
    expect(r.rootOutsideAllowlist).toEqual(['FINAL_SUMMARY.md']);
  });

  it('keeps untracked leftovers out of the gated list but reports them', () => {
    const r = analyze({
      ...empty(),
      rootFiles: [{ path: 'v1.6.0-changes-local.md', tracked: false }],
      rootAllowlist: [],
    });
    expect(r.rootOutsideAllowlist).toEqual([]);
    expect(r.rootUntracked).toEqual(['v1.6.0-changes-local.md']);
  });
});

describe('plans without a status line', () => {
  it('flags a plan with no Status line and accepts the bold and plain forms', () => {
    const r = analyze({
      ...empty(),
      plans: [
        { path: 'docs/plans/a.md', text: '# A\n\n**Status:** done\n' },
        { path: 'docs/plans/b.md', text: '# B\n\nStatus: proposed\n' },
        { path: 'docs/plans/c.md', text: '# C\n\nno status here, but the word status appears mid-line\n' },
      ],
    });
    expect(r.plansWithoutStatus).toEqual(['docs/plans/c.md']);
  });

  it('does not require a status on the plan index', () => {
    const r = analyze({ ...empty(), plans: [{ path: 'docs/plans/README.md', text: '# Index\n' }] });
    expect(r.plansWithoutStatus).toEqual([]);
  });
});

describe('counts', () => {
  it('summarizes every finding list as a number for the baseline gate', () => {
    const r = analyze({
      ...empty(),
      plans: [{ path: 'docs/plans/c.md', text: '# C\n' }],
      rootFiles: [{ path: 'X.md', tracked: true }],
    });
    expect(r.counts).toEqual({
      staleNames: 0,
      rootOutsideAllowlist: 1,
      plansWithoutStatus: 1,
      duplicateFunctions: 0,
      repeatedBlocks: 0,
      ollamaMockFiles: 0,
    });
  });
});
