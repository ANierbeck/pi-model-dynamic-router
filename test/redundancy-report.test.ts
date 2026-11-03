// scripts/redundancy-report.ts — the pure analysis behind the redundancy gate
// (docs/plans/2026-10-29-repo-hygiene.md, Phase 0). File contents and file
// lists go in as plain arrays, findings come out; no file system in the unit
// under test. The CLI that feeds it lives in the same script.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyze, collectInput, formatRedundancyReport, type AnalyzeInput } from '../scripts/redundancy-report.ts';

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

describe('collectInput covers every shipped path (Sourcery 2026-11-03)', () => {
  it('does not analyze a file twice when it is both a root file and a shipped file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redundancy-dup-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ files: ['PI.md'] }));
      fs.writeFileSync(path.join(dir, 'PI.md'), 'the tactical group\n');

      const report = analyze(collectInput(dir));
      expect(report.staleNames.map((f) => `${f.path}:${f.name}`)).toEqual(['PI.md:tactical']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });


  it('loads a shipped Markdown file from a directory outside root, docs/ and skills/', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redundancy-shipped-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ files: ['PI.md', 'guides/'] }),
      );
      fs.writeFileSync(path.join(dir, 'PI.md'), '# PI\n');
      fs.mkdirSync(path.join(dir, 'guides'));
      fs.writeFileSync(path.join(dir, 'guides', 'groups.md'), 'the tactical group\n');

      const report = analyze(collectInput(dir));
      expect(report.staleNames.map((f) => `${f.path}:${f.name}`)).toEqual(['guides/groups.md:tactical']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('report robustness (Sourcery round 2026-11-03)', () => {
  it('finds duplicate helpers declared as typed arrows, function expressions and default exports', () => {
    const decls = [
      'const arg = (i: number): string => process.argv[i] ?? "";',
      'export const fmtTime = function (t: number) { return String(t); };',
      'export default function pct(n: number) { return n; }',
    ];
    const r = analyze({
      ...empty(),
      code: [
        { path: 'scripts/a.ts', text: decls.join('\n') },
        { path: 'scripts/b.ts', text: decls.join('\n') },
      ],
    });
    expect(r.duplicateFunctions.map((d) => d.name).sort()).toEqual(['arg', 'fmtTime', 'pct']);
  });


  it('counts a repeated block whose six lines are short in total', () => {
    // The 80-char guard exists to skip brace-and-one-word windows, but it must
    // not hide a real repeated set-up: three files sharing the same six short
    // lines is redundancy the ratchet has to see.
    const short = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;', 'const e = 5;', 'const f = 6;'].join('\n');
    const r = analyze({
      ...empty(),
      tests: ['x', 'y', 'z'].map((n) => ({ path: `test/${n}.test.ts`, text: `${short}\n` })),
    });
    expect(r.repeatedBlocks.length).toBe(1);
  });

  it('normalizes Windows-style separators before matching shipped paths', () => {
    const r = analyze({
      ...empty(),
      docs: [{ path: 'skills\\router-login\\SKILL.md', text: 'use the scout group\n' }],
      shipped: ['skills/'],
    });
    expect(r.staleNames.map((s) => s.name)).toEqual(['scout']);
  });

  it('lists the ollama-mock files and untracked leftovers, not just their counts', () => {
    const r = analyze({
      ...empty(),
      tests: [{ path: 'test/a.test.ts', text: "vi.mock('../src/ollama-utils.ts', () => ({}));\n" }],
      rootFiles: [{ path: 'leftover.md', tracked: false }],
    });
    const text = formatRedundancyReport(r);
    expect(text).toContain('test/a.test.ts');
    expect(text).toContain('leftover.md');
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

  it('does not flag a pi-subagents agent name that happens to be a removed group name', () => {
    // README's subagent examples pass `agent: "scout"` — that is pi-subagents'
    // own agent identifier, not a router group, and `scout` is a real agent
    // there. Flagging it would force the docs to lie about the subagent API.
    const r = analyze({
      ...empty(),
      docs: [{ path: 'README.md', text: 'agent: "scout",\n  agent: \'scout\',\n' }],
      shipped: ['README.md'],
    });
    expect(r.staleNames).toEqual([]);
  });

  it('still flags the same name when it is used as a group', () => {
    const r = analyze({
      ...empty(),
      docs: [{ path: 'README.md', text: '  agent: "scout",\nthe scout group ranks local models first\n' }],
      shipped: ['README.md'],
    });
    expect(r.staleNames.map((s) => `${s.line}:${s.name}`)).toEqual(['2:scout']);
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
  it('does not accept a Status line that appears deep in the body (Sourcery 2026-11-03)', () => {
    // The field belongs at the top (§11). A plan that merely mentions
    // "Status: ..." in a later paragraph has no Status field, and the ratchet
    // must still count it — otherwise the gate can be satisfied by prose.
    const body = ['# Plan', '', '## Problem', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'Status: mentioned in passing', ''].join('\n');
    const r = analyze({ ...empty(), plans: [{ path: 'docs/plans/x.md', text: body }] });
    expect(r.plansWithoutStatus).toEqual(['docs/plans/x.md']);
  });

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
