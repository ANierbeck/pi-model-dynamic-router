// Redundancy report (docs/plans/2026-10-29-repo-hygiene.md, Phase 0).
//
//   node scripts/redundancy-report.ts            counts, then the top-10 lists
//   node scripts/redundancy-report.ts --json     the counts only, as JSON
//   node scripts/redundancy-report.ts --root     per root file: state, size, inbound refs
//
// `analyze` is pure: file contents and file lists in, findings out. The thin
// CLI at the bottom reads the file system. Output stays under 60 lines so an
// agent can run it without paying for the repository's size. The ceilings the
// counts are held to live in scripts/redundancy-baseline.json
// (test/redundancy-baseline.test.ts); they only shrink.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
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
  plansMissingFromIndex: string[];
  counts: Counts;
}

export interface Counts {
  staleNames: number;
  rootOutsideAllowlist: number;
  plansWithoutStatus: number;
  plansMissingFromIndex: number;
  duplicateFunctions: number;
  repeatedBlocks: number;
  ollamaMockFiles: number;
}

/**
 * Names the project no longer uses: the 13-group layout's group names (removed
 * by the five-group layout) plus the one retired category name that is
 * unambiguous. `fallback` and `trivial` are NOT here — both are ordinary
 * English words this project uses for other things (failover, a trivial
 * prompt); the retired category `fallback` is covered by `fallback group`.
 */
export const STALE_NAMES = ['strategic', 'operational', 'scout', 'tactical', 'fallback group', 'exploration'] as const;

/**
 * A line that explicitly marks the name as history is documentation, not a
 * stale claim: "the pre-v2 categories X and Y were removed" is exactly what a
 * shipped doc should say. Only current-state claims are findings.
 */
const HISTORY_MARKER = /\b(?:pre-v2|were removed|was removed|are removed|no longer|retired|dropped)\b/i;

/** Historical documents are never edited for tidiness (AGENTS.md §12). */
const HISTORICAL = ['docs/adr/', 'docs/plans/', 'docs/research/', 'CHANGELOG.md'];

/** A helper name that is legitimately one-per-script. */
const ENTRY_POINT_NAMES = new Set(['main']);

const BLOCK_LINES = 6;
const BLOCK_MIN_FILES = 3;

// Declaration forms the duplicate check recognizes at column 0:
//   function f(...)            export function f(...)
//   export default function f  const f = (...) => / = x => (typed or not)
//   const f = function (...)   const f = async function (...)
// A name declared twice in the same file counts once (the Set of paths).
// Not recognized: class methods, object-literal methods, arrow bodies spread
// over several lines before the `=>`. The count is a ratchet, not a proof.
const FUNCTION_DEF = new RegExp(
  [
    '^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+([A-Za-z_$][\\w$]*)',
    '^(?:export\\s+)?(?:default\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)|[A-Za-z_$][\\w$]*)',
  ].join('|')
);

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

const isTrivialLine = (line: string): boolean => !/[A-Za-z0-9_$]{3,}/.test(line);

function findRepeatedBlocks(tests: TextFile[]): Report['repeatedBlocks'] {
  // key -> files that contain the window
  const filesOf = new Map<string, Set<string>>();
  const windowsOf = new Map<string, string[]>();
  for (const f of tests) {
    const lines = f.text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const keys: string[] = [];
    for (let i = 0; i + BLOCK_LINES <= lines.length; i++) {
      const window = lines.slice(i, i + BLOCK_LINES);
      const w = window.join('\n');
      keys.push(w);
      // Skip windows that carry no information — six closing braces are not a
      // shared set-up. A window counts as trivial when no line contains an
      // identifier or number of three or more characters, which keeps short
      // but real set-ups (`const a = 1;`) in the report.
      if (window.every(isTrivialLine)) continue;
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

// A removed group name is only stale when it names a ROUTER group. Two of the
// five also exist outside the router: `scout` is a pi-subagents agent
// identifier (README's subagent examples pass `agent: "scout"`), and
// `operational` is an ordinary English adjective. Both are legitimate in a
// shipped doc, so the check skips a hit whose line uses the word in one of
// those roles — the subagent assignment below, and the adjective phrase for
// `operational`. Everything else is a finding.
const NON_GROUP_USES: Partial<Record<(typeof STALE_NAMES)[number], RegExp>> = {
  scout: /\bagent:\s*['"]scout['"]/i,
  operational: /\boperational\s+(?:problems?|issues?|overhead|cost|risk|work)\b/i,
};

function findStaleNames(docs: TextFile[], shipped: string[]): Report['staleNames'] {
  const patterns = STALE_NAMES.map((name) => ({ name, re: new RegExp(`\\b${name}\\b`, 'gi') }));
  const out: Report['staleNames'] = [];
  for (const d of docs) {
    if (!isShipped(d.path, shipped)) continue;
    d.text.split('\n').forEach((text, i) => {
      for (const { name, re } of patterns) {
        // Strip the exempt occurrences, then test again: a line can carry both
        // `agent: "scout"` and a stale group reference, and only the exempt
        // occurrence is legitimate (Sourcery on PR #84, 2026-11-03).
        if (HISTORY_MARKER.test(text)) continue;
        const exemption = NON_GROUP_USES[name];
        const subject = exemption ? text.replace(new RegExp(exemption.source, 'gi'), '') : text;
        re.lastIndex = 0;
        if (!re.test(subject)) continue;
        out.push({ path: d.path, line: i + 1, name });
      }
    });
  }
  return out;
}

/**
 * AGENTS.md §11: every plan STARTS with a Status line (bold or plain). The
 * field must be in the header block, so a later paragraph that merely mentions
 * "Status: ..." does not satisfy the gate (Sourcery 2026-11-03).
 */
const STATUS_LINE = /^\*{0,2}status\b/im;

/**
 * The Status field counts only in the plan's header block — the text before the
 * first level-2 heading. A plan that merely mentions "Status: ..." in a later
 * paragraph has no Status field (Sourcery 2026-11-03).
 */
function hasStatusField(text: string): boolean {
  const lines = text.split('\n');
  const firstSection = lines.findIndex((l) => l.startsWith('## '));
  return lines.slice(0, firstSection === -1 ? lines.length : firstSection).some((l) => STATUS_LINE.test(l));
}

export function analyze(input: AnalyzeInput): Report {
  // Normalize once: a Windows checkout (or a hand-built input) would otherwise
  // never match the forward-slash shipped/historical paths (Sourcery 2026-11-03).
  const docs = input.docs.map((d) => ({ ...d, path: toPosix(d.path) }));
  const plans = input.plans.map((p) => ({ ...p, path: toPosix(p.path) }));
  const allow = new Set(input.rootAllowlist);
  const duplicateFunctions = findDuplicateFunctions(input.code);
  const repeatedBlocks = findRepeatedBlocks(input.tests);
  const ollamaMockFiles = input.tests
    .filter((t) => /vi\.mock\(\s*['"][^'"]*ollama-utils/.test(t.text))
    .map((t) => t.path)
    .sort();
  const staleNames = findStaleNames(docs, input.shipped.map(toPosix));
  const rootOutsideAllowlist = input.rootFiles.filter((f) => f.tracked && !allow.has(f.path)).map((f) => f.path).sort();
  const rootUntracked = input.rootFiles.filter((f) => !f.tracked && !allow.has(f.path)).map((f) => f.path).sort();
  const plansWithoutStatus = plans
    .filter((p) => !p.path.endsWith('/README.md') && !hasStatusField(p.text))
    .map((p) => p.path)
    .sort();
  // The plan index is hand-maintained; a plan without a row would silently
  // disappear from the only overview (Sourcery on PR #84, 2026-11-03). The
  // index links each plan by filename, so presence is a substring check.
  const index = plans.find((p) => p.path === 'docs/plans/README.md');
  const plansMissingFromIndex = index
    ? plans
        .filter((p) => p.path !== 'docs/plans/README.md')
        .filter((p) => !index.text.includes(p.path.split('/').pop()!))
        .map((p) => p.path)
        .sort()
    : [];
  return {
    duplicateFunctions,
    repeatedBlocks,
    ollamaMockFiles,
    plansMissingFromIndex,
    staleNames,
    rootOutsideAllowlist,
    rootUntracked,
    plansWithoutStatus,
    counts: {
      staleNames: staleNames.length,
      rootOutsideAllowlist: rootOutsideAllowlist.length,
      plansWithoutStatus: plansWithoutStatus.length,
      plansMissingFromIndex: plansMissingFromIndex.length,
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

/** Windows separators would never match the forward-slash shipped/historical paths. */
const toPosix = (p: string): string => p.split('\\').join('/');

function walk(dir: string, root: string, accept: (p: string) => boolean, skip: Set<string>): TextFile[] {
  const out: TextFile[] = [];
  // A shipped entry may name a directory this checkout does not have (a
  // synthetic test tree, a partial checkout) — that is not an error.
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = join(dir, name);
    // A symlink can point outside the checkout; following it would put outside
    // file content into the report (Sourcery 2026-11-03).
    if (lstatSync(full).isSymbolicLink()) continue;
    if (statSync(full).isDirectory()) out.push(...walk(full, root, accept, skip));
    else if (accept(full)) out.push({ path: toPosix(relative(root, full)), text: readFileSync(full, 'utf8') });
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
    // Any OTHER shipped directory or file: a doc that ships must be analyzed,
    // wherever it lives, or its stale names escape the gate (Sourcery
    // 2026-11-03). docs/ and skills/ are covered above; dist/ is build output.
    ...shipped
      .filter((entry) => !entry.startsWith('docs/') && !entry.startsWith('skills/') && !entry.startsWith('dist/'))
      .flatMap((entry) =>
        entry.endsWith('/')
          ? walk(join(root, entry), root, md, skip)
          : existsSync(join(root, entry))
            ? [{ path: entry, text: readFileSync(join(root, entry), 'utf8') }]
            : []
      )
      .filter((d) => d.path.endsWith('.md')),
  ].filter((d, i, all) => all.findIndex((o) => o.path === d.path) === i); // a root file can also be a shipped file
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
    `  plans missing from the index      : ${c.plansMissingFromIndex}`,
    `  duplicate function names          : ${c.duplicateFunctions}`,
    `  repeated ${BLOCK_LINES}-line test blocks (>= ${BLOCK_MIN_FILES} files) : ${c.repeatedBlocks}`,
    `  test files mocking ollama-utils   : ${c.ollamaMockFiles}`,
    '',
    ...topList('Stale names', r.staleNames.map((s) => `${s.path}:${s.line} ${s.name}`), c.staleNames),
    ...topList('Root outside allowlist', r.rootOutsideAllowlist, c.rootOutsideAllowlist),
    ...topList('Duplicate functions', r.duplicateFunctions.map((d) => `${d.name} x${d.paths.length}: ${d.paths.join(', ')}`), c.duplicateFunctions),
    ...topList('Repeated blocks', r.repeatedBlocks.map((b) => `${b.files} files: ${b.preview}`), c.repeatedBlocks),
    ...topList('Plans without status', r.plansWithoutStatus, c.plansWithoutStatus),
    ...topList('Plans missing from docs/plans/README.md', r.plansMissingFromIndex, c.plansMissingFromIndex),
    ...topList('Test files mocking ollama-utils', r.ollamaMockFiles, c.ollamaMockFiles),
    ...topList('Untracked root leftovers', r.rootUntracked, r.rootUntracked.length),
  ].join('\n');
}

/**
 * Phase 1 Step 1 inventory: per root file, tracked state, size and how many
 * tracked files mention its name. Capped like the report.
 */
export function formatRootInventory(root: string): string {
  const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n'));
  const files = readdirSync(root).filter((n) => statSync(join(root, n)).isFile());
  const mentions = new Map<string, number>();
  for (const rel of tracked) {
    if (!rel.endsWith('.md') && !rel.endsWith('.ts') && !rel.endsWith('.json')) continue;
    let text: string;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    for (const name of files) {
      if (rel === name) continue;
      if (text.includes(name)) mentions.set(name, (mentions.get(name) ?? 0) + 1);
    }
  }
  const rows = files
    .sort()
    .map((name) => {
      const size = statSync(join(root, name)).size;
      return `${name} | ${tracked.has(name) ? 'tracked' : 'untracked'} | ${size} B | ${mentions.get(name) ?? 0} inbound`;
    });
  return ['Root inventory (file | state | size | inbound references):', ...rows].join('\n');
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--root')) {
    console.log(formatRootInventory(root));
    return;
  }
  const report = analyze(collectInput(root));
  console.log(process.argv.includes('--json') ? JSON.stringify(report.counts, null, 2) : formatRedundancyReport(report));
}

if (process.argv[1] && process.argv[1].endsWith('redundancy-report.ts')) main();
