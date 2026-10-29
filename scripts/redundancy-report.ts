// Redundancy report (docs/plans/2026-10-29-repo-hygiene.md, Phase 0).
//
//   node scripts/redundancy-report.ts            counts, then the top-10 lists
//   node scripts/redundancy-report.ts --json     the counts only, as JSON
//
// `analyze` is pure: file contents and file lists in, findings out. The thin
// CLI at the bottom reads the file system. Output stays under 60 lines so an
// agent can run it without paying for the repository's size. The ceilings the
// counts are held to live in scripts/redundancy-baseline.json
// (test/redundancy-baseline.test.ts); they only shrink.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TextFile {
  path: string;
  text: string;
}

export interface RootFile {
  path: string;
  tracked: boolean;
}

export interface AnalyzeInput {
  /** src/ and scripts/ sources: the duplicate-helper check. */
  code: TextFile[];
  /** test/ sources: repeated blocks and mock boilerplate. */
  tests: TextFile[];
  /** Markdown documents that could be shipped or historical. */
  docs: TextFile[];
  /** Shipped paths: exact files, or directories written with a trailing slash. */
  shipped: string[];
  /** docs/plans/*.md. */
  plans: TextFile[];
  rootFiles: RootFile[];
  rootAllowlist: string[];
}

export interface Report {
  duplicateFunctions: { name: string; paths: string[] }[];
  repeatedBlocks: { files: number; preview: string }[];
  ollamaMockFiles: string[];
  staleNames: { path: string; line: number; name: string }[];
  rootOutsideAllowlist: string[];
  /** Untracked root leftovers: informational, never gated (CI cannot see them). */
  rootUntracked: string[];
  plansWithoutStatus: string[];
  counts: Counts;
}

export interface Counts {
  staleNames: number;
  rootOutsideAllowlist: number;
  plansWithoutStatus: number;
  duplicateFunctions: number;
  repeatedBlocks: number;
  ollamaMockFiles: number;
}

/** Group names of the 13-group layout; the five-group layout removed them. */
export const STALE_NAMES = ['strategic', 'operational', 'scout', 'tactical', 'fallback group'] as const;

/** Historical documents are never edited for tidiness (AGENTS.md §12). */
const HISTORICAL = ['docs/adr/', 'docs/plans/', 'docs/research/', 'CHANGELOG.md'];

/** A helper name that is legitimately one-per-script. */
const ENTRY_POINT_NAMES = new Set(['main']);

const BLOCK_LINES = 6;
const BLOCK_MIN_FILES = 3;
/** A window shorter than this is closing braces and one-word statements. */
const BLOCK_MIN_CHARS = 80;

const FUNCTION_DEF = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/;

function findDuplicateFunctions(code: TextFile[]): Report['duplicateFunctions'] {
  const byName = new Map<string, Set<string>>();
  for (const f of code) {
    for (const line of f.text.split('\n')) {
      const m = FUNCTION_DEF.exec(line); // anchored at column 0: nested helpers do not match
      const name = m?.[1] ?? m?.[2];
      if (!name || ENTRY_POINT_NAMES.has(name)) continue;
      (byName.get(name) ?? byName.set(name, new Set()).get(name)!).add(f.path);
    }
  }
  return [...byName.entries()]
    .filter(([, paths]) => paths.size > 1)
    .map(([name, paths]) => ({ name, paths: [...paths].sort() }))
    .sort((a, b) => b.paths.length - a.paths.length || a.name.localeCompare(b.name));
}

function findRepeatedBlocks(tests: TextFile[]): Report['repeatedBlocks'] {
  // key -> files that contain the window
  const filesOf = new Map<string, Set<string>>();
  const windowsOf = new Map<string, string[]>();
  for (const f of tests) {
    const lines = f.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const keys: string[] = [];
    for (let i = 0; i + BLOCK_LINES <= lines.length; i++) {
      const w = lines.slice(i, i + BLOCK_LINES).join('\n');
      keys.push(w);
      if (w.length < BLOCK_MIN_CHARS) continue;
      (filesOf.get(w) ?? filesOf.set(w, new Set()).get(w)!).add(f.path);
    }
    windowsOf.set(f.path, keys);
  }
  const repeated = (key: string) => (filesOf.get(key)?.size ?? 0) >= BLOCK_MIN_FILES;
  // One block per run of consecutive repeated windows: count the run's start only.
  const starts = new Map<string, number>();
  for (const keys of windowsOf.values()) {
    keys.forEach((key, i) => {
      if (!repeated(key) || (i > 0 && repeated(keys[i - 1]!))) return;
      starts.set(key, filesOf.get(key)!.size);
    });
  }
  return [...starts.entries()]
    .map(([key, files]) => ({ files, preview: key.split('\n').reduce((a, b) => (b.length > a.length ? b : a)).slice(0, 90) }))
    .sort((a, b) => b.files - a.files || a.preview.localeCompare(b.preview));
}

function isShipped(path: string, shipped: string[]): boolean {
  if (HISTORICAL.some((h) => (h.endsWith('/') ? path.startsWith(h) : path === h))) return false;
  return shipped.some((s) => (s.endsWith('/') ? path.startsWith(s) : path === s));
}

function findStaleNames(docs: TextFile[], shipped: string[]): Report['staleNames'] {
  const patterns = STALE_NAMES.map((name) => ({ name, re: new RegExp(`\\b${name}\\b`, 'gi') }));
  const out: Report['staleNames'] = [];
  for (const d of docs) {
    if (!isShipped(d.path, shipped)) continue;
    d.text.split('\n').forEach((text, i) => {
      for (const { name, re } of patterns) {
        re.lastIndex = 0;
        if (re.test(text)) out.push({ path: d.path, line: i + 1, name });
      }
    });
  }
  return out;
}

/** AGENTS.md §11: every plan starts with a Status line (bold or plain). */
const STATUS_LINE = /^\*{0,2}status/im;

export function analyze(input: AnalyzeInput): Report {
  const allow = new Set(input.rootAllowlist);
  const duplicateFunctions = findDuplicateFunctions(input.code);
  const repeatedBlocks = findRepeatedBlocks(input.tests);
  const ollamaMockFiles = input.tests
    .filter((t) => /vi\.mock\(\s*['"][^'"]*ollama-utils/.test(t.text))
    .map((t) => t.path)
    .sort();
  const staleNames = findStaleNames(input.docs, input.shipped);
  const rootOutsideAllowlist = input.rootFiles.filter((f) => f.tracked && !allow.has(f.path)).map((f) => f.path).sort();
  const rootUntracked = input.rootFiles.filter((f) => !f.tracked && !allow.has(f.path)).map((f) => f.path).sort();
  const plansWithoutStatus = input.plans
    .filter((p) => !p.path.endsWith('/README.md') && !STATUS_LINE.test(p.text))
    .map((p) => p.path)
    .sort();
  return {
    duplicateFunctions,
    repeatedBlocks,
    ollamaMockFiles,
    staleNames,
    rootOutsideAllowlist,
    rootUntracked,
    plansWithoutStatus,
    counts: {
      staleNames: staleNames.length,
      rootOutsideAllowlist: rootOutsideAllowlist.length,
      plansWithoutStatus: plansWithoutStatus.length,
      duplicateFunctions: duplicateFunctions.length,
      repeatedBlocks: repeatedBlocks.length,
      ollamaMockFiles: ollamaMockFiles.length,
    },
  };
}

// ── CLI: reads the file system, feeds analyze ──────────────────────────────

/** Root files that belong at the top level. A new root file needs an entry here, in the same PR. */
export const ROOT_ALLOWLIST = [
  '.gitignore',
  '.gitleaksignore',
  '.prettierrc',
  '.roborev.toml',
  'AGENTS.md',
  'CHANGELOG.md',
  // Owner decisions 2026-10-29: CLAUDE.md stays at the root (local), PI.md ships and stays.
  'CLAUDE.md',
  'PI.md',
  'README.md',
  'RELEASE_CHECKLIST.md',
  'TODO.md',
  'eslint.config.js',
  'index.ts',
  'model-map.yaml',
  'package-lock.json',
  'package.json',
  'router-config.json',
  'router-defaults.yaml',
  'stryker.config.json',
  'tsconfig.json',
  'vitest.config.ts',
];

function walk(dir: string, root: string, accept: (p: string) => boolean, skip: Set<string>): TextFile[] {
  const out: TextFile[] = [];
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, root, accept, skip));
    else if (accept(full)) out.push({ path: relative(root, full), text: readFileSync(full, 'utf8') });
  }
  return out;
}

export function collectInput(root: string): AnalyzeInput {
  const skip = new Set(['node_modules', 'dist', '.git', '.worktrees', '.cache', 'archive']);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files?: string[] };
  const shipped = [...(pkg.files ?? []).filter((f) => !f.startsWith('!') && !f.startsWith('dist/')), 'README.md'];
  const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n'));
  const rootFiles = readdirSync(root)
    .filter((n) => statSync(join(root, n)).isFile())
    .map((n) => ({ path: n, tracked: tracked.has(n) }));
  const ts = (p: string) => p.endsWith('.ts');
  const md = (p: string) => p.endsWith('.md');
  const docs: TextFile[] = [
    ...rootFiles.filter((f) => f.path.endsWith('.md')).map((f) => ({ path: f.path, text: readFileSync(join(root, f.path), 'utf8') })),
    ...walk(join(root, 'docs'), root, md, skip),
    ...walk(join(root, 'skills'), root, md, skip),
  ];
  return {
    code: [
      ...walk(join(root, 'src'), root, ts, skip),
      ...walk(join(root, 'scripts'), root, ts, skip),
    ],
    tests: walk(join(root, 'test'), root, ts, skip),
    docs,
    shipped,
    plans: walk(join(root, 'docs', 'plans'), root, md, skip),
    rootFiles,
    rootAllowlist: ROOT_ALLOWLIST,
  };
}

const topList = (title: string, rows: string[], total: number): string[] =>
  rows.length === 0 ? [`${title}: none`] : [`${title} (top ${Math.min(10, rows.length)} of ${total}):`, ...rows.slice(0, 10).map((r) => `  ${r}`)];

export function formatRedundancyReport(r: Report): string {
  const c = r.counts;
  return [
    'Redundancy report',
    `  stale group names in shipped docs : ${c.staleNames}`,
    `  root files outside the allowlist  : ${c.rootOutsideAllowlist}  (untracked leftovers: ${r.rootUntracked.length})`,
    `  plans without a Status line       : ${c.plansWithoutStatus}`,
    `  duplicate function names          : ${c.duplicateFunctions}`,
    `  repeated ${BLOCK_LINES}-line test blocks (>= ${BLOCK_MIN_FILES} files) : ${c.repeatedBlocks}`,
    `  test files mocking ollama-utils   : ${c.ollamaMockFiles}`,
    '',
    ...topList('Stale names', r.staleNames.map((s) => `${s.path}:${s.line} ${s.name}`), c.staleNames),
    ...topList('Root outside allowlist', r.rootOutsideAllowlist, c.rootOutsideAllowlist),
    ...topList('Duplicate functions', r.duplicateFunctions.map((d) => `${d.name} x${d.paths.length}: ${d.paths.join(', ')}`), c.duplicateFunctions),
    ...topList('Repeated blocks', r.repeatedBlocks.map((b) => `${b.files} files: ${b.preview}`), c.repeatedBlocks),
    ...topList('Plans without status', r.plansWithoutStatus, c.plansWithoutStatus),
  ].join('\n');
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const report = analyze(collectInput(root));
  console.log(process.argv.includes('--json') ? JSON.stringify(report.counts, null, 2) : formatRedundancyReport(report));
}

if (process.argv[1] && process.argv[1].endsWith('redundancy-report.ts')) main();
