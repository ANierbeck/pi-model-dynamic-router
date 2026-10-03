/**
 * Secret/reference scan over COMMIT RANGES (pre-push hook + CI gate).
 *
 * Why ranges and not the tree: on 2026-10-03 a webhook URL was found in the
 * public history although the tree-only guard (no-external-references) was
 * green — a leak that is added in one commit and removed in a later one is
 * invisible at HEAD but published with every push. The scan therefore
 * checks every ADDED line of every commit being pushed or merged.
 *
 * Forbidden strings are assembled from fragments so this file does not
 * match the patterns itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPatch, scanRange, prePushRanges } from '../scripts/secret-scan.ts';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WEBHOOK = 'http://host.tail' + 'net.ts' + '.net:8123/api' + '/webhook/abc123';
const ZERO = '0'.repeat(40);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitFile(cwd: string, file: string, content: string, msg: string): string {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD');
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

describe('scanPatch (added lines only)', () => {
  it('flags an ADDED forbidden line with commit and file, ignores REMOVED lines', () => {
    const patch = [
      'commit 1111111111111111111111111111111111111111',
      'diff --git a/docs/runbook.md b/docs/runbook.md',
      '--- a/docs/runbook.md',
      '+++ b/docs/runbook.md',
      '@@ -1,2 +1,2 @@',
      `+Endpoint: ${WEBHOOK}`,
      'commit 2222222222222222222222222222222222222222',
      'diff --git a/docs/runbook.md b/docs/runbook.md',
      '--- a/docs/runbook.md',
      '+++ b/docs/runbook.md',
      '@@ -1,2 +1,2 @@',
      `-Endpoint: ${WEBHOOK}`,
      '+Endpoint: <redacted>',
    ].join('\n');
    const findings = scanPatch(patch);
    expect(findings.map((f) => [f.commit.slice(0, 7), f.file])).toEqual([
      ['1111111', 'docs/runbook.md'],
      ['1111111', 'docs/runbook.md'],
    ]);
    expect(findings.map((f) => f.pattern).sort()).toEqual(['tailnet hostname', 'webhook URL']);
  });

  it('skips the generated lockfile like the tree guard does', () => {
    const patch = [
      'commit 3333333333333333333333333333333333333333',
      '+++ b/package-lock.json',
      '+  "resolved": "https://host.tail' + 'net.ts' + '.net/x.tgz"',
    ].join('\n');
    expect(scanPatch(patch)).toEqual([]);
  });
});

describe('prePushRanges (git pre-push stdin)', () => {
  it('update → remote..local; new branch → local --not --remotes; delete → skipped', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const stdin = [
      `refs/heads/main ${b} refs/heads/main ${a}`,
      `refs/heads/feat ${b} refs/heads/feat ${ZERO}`,
      `(delete) ${ZERO} refs/heads/old ${a}`,
    ].join('\n');
    expect(prePushRanges(stdin)).toEqual([[`${a}..${b}`], [b, '--not', '--remotes']]);
  });
});

describe('scanRange on a real repository', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-range-'));
    initRepo(dir);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('catches a leak that was added and removed again inside the range (the 2026-10-03 shape)', () => {
    const base = commitFile(dir, 'runbook.md', 'Endpoint: <placeholder>\n', 'docs: runbook');
    const leak = commitFile(dir, 'runbook.md', `Endpoint: ${WEBHOOK}\n`, 'docs: real endpoint');
    const head = commitFile(dir, 'runbook.md', 'Endpoint: <placeholder>\n', 'docs: redact');
    // The tree at HEAD is clean — a tree-only scan would pass:
    expect(fs.readFileSync(path.join(dir, 'runbook.md'), 'utf-8')).not.toContain('/webhook/');
    const findings = scanRange([`${base}..${head}`], dir);
    expect(findings.length).toBeGreaterThan(0);
    expect(new Set(findings.map((f) => f.commit))).toEqual(new Set([leak]));
  });

  it('a clean range yields no findings', () => {
    const base = git(dir, 'rev-parse', 'HEAD');
    const head = commitFile(dir, 'notes.md', 'nothing to see\n', 'docs: notes');
    expect(scanRange([`${base}..${head}`], dir)).toEqual([]);
  });
});

describe('npm prepare wires the hook', () => {
  it('sets core.hooksPath to the versioned .githooks inside a git work tree', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-prepare-'));
    try {
      initRepo(dir);
      const prepare = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')).scripts.prepare as string;
      execFileSync('sh', ['-c', prepare], { cwd: dir });
      expect(git(dir, 'config', '--get', 'core.hooksPath')).toBe('.githooks');
      // The hook must ship executable, or git silently skips it.
      expect(fs.statSync(path.join(repoRoot, '.githooks', 'pre-push')).mode & 0o111).not.toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op outside a git work tree (npm installs of the published tarball)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-nogit-'));
    try {
      const prepare = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')).scripts.prepare as string;
      const r = spawnSync('sh', ['-c', prepare], { cwd: dir, env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pre-push hook end to end', () => {
  let work: string;
  let remote: string;
  beforeAll(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-hook-'));
    remote = path.join(root, 'remote.git');
    work = path.join(root, 'work');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    initRepo(work);
    git(work, 'remote', 'add', 'origin', remote);
    // Use THIS repository's versioned hook, exactly as `npm prepare` wires it.
    git(work, 'config', 'core.hooksPath', path.join(repoRoot, '.githooks'));
    commitFile(work, 'README.md', 'hello\n', 'init');
    git(work, 'push', '-q', 'origin', 'main');
  });
  afterAll(() => fs.rmSync(path.dirname(work), { recursive: true, force: true }));

  const push = () =>
    spawnSync('git', ['push', 'origin', 'HEAD:main'], {
      cwd: work,
      encoding: 'utf-8',
      env: { ...process.env, SECRET_SCAN_SKIP_GITLEAKS: '1' },
    });

  it('rejects a push whose commits carry a leak, even if a later commit removed it', () => {
    commitFile(work, 'runbook.md', `Endpoint: ${WEBHOOK}\n`, 'docs: real endpoint');
    commitFile(work, 'runbook.md', 'Endpoint: <placeholder>\n', 'docs: redact');
    const r = push();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/webhook URL/);
    // Nothing reached the remote.
    expect(git(remote, 'rev-list', '--count', 'main')).toBe('1');
  });

  it('lets a clean push through', () => {
    git(work, 'reset', '-q', '--hard', 'origin/main');
    commitFile(work, 'notes.md', 'clean\n', 'docs: clean');
    const r = push();
    expect(r.status, r.stderr).toBe(0);
    expect(git(remote, 'rev-list', '--count', 'main')).toBe('2');
  });
});
