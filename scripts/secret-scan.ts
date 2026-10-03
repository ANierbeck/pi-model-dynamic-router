// scripts/secret-scan.ts
// Scans COMMIT RANGES for forbidden references (scripts/forbidden-patterns.ts)
// and, via gitleaks, for generic credentials. Runs as the git pre-push hook
// (.githooks/pre-push, wired by `npm prepare`) and as the CI `secret-scan`
// job that branch protection requires before anything merges into main.
//
// Why ranges: this repository is public, so every pushed commit is
// published, not just the final tree. Two leaks found on 2026-10-03 (a
// webhook URL, and a provider API key copied into a generated config) both
// passed tree-only checks because later commits had removed them.
//
// Usage:
//   node scripts/secret-scan.ts --range <a>..<b>        (CI)
//   node scripts/secret-scan.ts --pre-push              (git hook; reads stdin)
//   flags: --require-gitleaks  fail when gitleaks is not installed (CI)
//   env:   SECRET_SCAN_SKIP_GITLEAKS=1 skips only the gitleaks layer (tests);
//          ignored together with --require-gitleaks.
//
// There is no bypass for the pattern layer: a hit means the content must be
// fixed (rewrite the local commits) before pushing. A gitleaks false
// positive is allowlisted by adding its fingerprint to .gitleaksignore.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { FORBIDDEN, SKIP_PATHS } from './forbidden-patterns.ts';

export interface Finding {
  commit: string;
  file: string;
  pattern: string;
  line: string;
}

const COMMIT_MARK = 'commit ';
const ZERO_SHA = /^0+$/;

/**
 * Scans `git log -p --format=commit %H` output. Only ADDED lines count —
 * a removal of a forbidden string is the fix, not the leak.
 */
export function scanPatch(patch: string): Finding[] {
  const findings: Finding[] = [];
  let commit = '';
  let file = '';
  for (const raw of patch.split('\n')) {
    if (raw.startsWith(COMMIT_MARK) && /^commit [0-9a-f]{40}$/.test(raw)) {
      commit = raw.slice(COMMIT_MARK.length);
      file = '';
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4);
      file = target === '/dev/null' ? '' : target.replace(/^b\//, '');
      continue;
    }
    if (!raw.startsWith('+') || !file || SKIP_PATHS.has(file)) continue;
    const line = raw.slice(1);
    for (const { name, re } of FORBIDDEN) {
      if (re.test(line)) findings.push({ commit, file, pattern: name, line: line.trim().slice(0, 160) });
    }
  }
  return findings;
}

/** Runs the pattern scan over one `git log` revision specification. */
export function scanRange(revs: string[], cwd: string = process.cwd()): Finding[] {
  const patch = execFileSync(
    'git',
    ['log', '-p', '--no-color', '--no-ext-diff', '--no-textconv', '--format=commit %H', ...revs],
    { cwd, encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024 },
  );
  return scanPatch(patch);
}

/**
 * Turns git's pre-push stdin ("<local ref> <local sha> <remote ref> <remote
 * sha>" per line) into revision specs covering exactly the commits that
 * would be published. A new remote branch has no remote sha: everything not
 * yet on any remote is in scope. Deletions publish nothing.
 */
export function prePushRanges(stdin: string): string[][] {
  const ranges: string[][] = [];
  for (const line of stdin.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const local = parts[1]!;
    const remote = parts[3]!;
    if (ZERO_SHA.test(local)) continue;
    ranges.push(ZERO_SHA.test(remote) ? [local, '--not', '--remotes'] : [`${remote}..${local}`]);
  }
  return ranges;
}

function commitExists(sha: string, cwd: string): boolean {
  return spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd }).status === 0;
}

/** gitleaks takes one --log-opts string; same revision semantics as git log. */
function runGitleaks(revs: string[], cwd: string, required: boolean): boolean {
  const probe = spawnSync('gitleaks', ['version'], { encoding: 'utf-8' });
  if (probe.error || probe.status !== 0) {
    if (required) {
      console.error('secret-scan: gitleaks is required here but not installed');
      return false;
    }
    console.error('secret-scan: gitleaks not installed — generic credential scan skipped (brew install gitleaks)');
    return true;
  }
  const r = spawnSync(
    'gitleaks',
    ['git', '--no-banner', '--redact', '--exit-code', '1', '--log-opts', revs.join(' '), '.'],
    { cwd, encoding: 'utf-8' },
  );
  if (r.status === 0) return true;
  console.error(r.stdout + r.stderr);
  console.error('secret-scan: gitleaks reported a possible credential (false positive? add its fingerprint to .gitleaksignore)');
  return false;
}

function report(findings: Finding[]): void {
  console.error(`secret-scan: ${findings.length} forbidden reference(s) in the commits being published:`);
  for (const f of findings) console.error(`  ${f.commit.slice(0, 7)} ${f.file} [${f.pattern}] ${f.line}`);
  console.error(
    'Fix the content in the offending commit(s) (e.g. git rebase -i) and push again. ' +
      'Do not bypass with --no-verify: on a public repository a push is a publication.',
  );
}

function main(argv: string[]): number {
  const cwd = process.cwd();
  const required = argv.includes('--require-gitleaks');
  const skipGitleaks = !required && process.env.SECRET_SCAN_SKIP_GITLEAKS === '1';
  let rangeSpecs: string[][];
  if (argv.includes('--pre-push')) {
    rangeSpecs = prePushRanges(readFileSync(0, 'utf-8'));
    // A remote sha we never fetched cannot anchor a range: fall back to
    // "everything not on any remote" for that ref.
    rangeSpecs = rangeSpecs.map((spec) => {
      const m = /^([0-9a-f]{40})\.\.([0-9a-f]{40})$/.exec(spec[0]!);
      return m && !commitExists(m[1]!, cwd) ? [m[2]!, '--not', '--remotes'] : spec;
    });
  } else {
    const i = argv.indexOf('--range');
    const range = i >= 0 ? argv[i + 1] : undefined;
    if (!range) {
      console.error('usage: secret-scan.ts --range <a>..<b> | --pre-push [--require-gitleaks]');
      return 2;
    }
    rangeSpecs = [[range]];
  }

  let ok = true;
  const findings = rangeSpecs.flatMap((revs) => scanRange(revs, cwd));
  if (findings.length > 0) {
    report(findings);
    ok = false;
  }
  if (!skipGitleaks) {
    for (const revs of rangeSpecs) ok = runGitleaks(revs, cwd, required) && ok;
  }
  return ok ? 0 : 1;
}

// Same direct-invocation guard as scripts/router-kpi-audit.ts: importing
// the module (tests) must never run main().
function invokedDirectly(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exit(main(process.argv.slice(2)));
