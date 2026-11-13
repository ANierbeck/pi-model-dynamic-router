// The prepublishOnly guard (package.json) is the last line before `npm publish`:
// it refuses to publish from a commit without a git tag, so a publish always
// names a release (AGENTS.md §1). Release review 2026-11-13: the guard was
// untested. The test runs the exact script string in throwaway repositories.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const guard = pkg.scripts.prepublishOnly;

function repoWithCommit(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepublish-guard-'));
  const git = (...args: string[]) =>
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

function runGuard(cwd: string) {
  return spawnSync('sh', ['-c', guard], { cwd, encoding: 'utf8' });
}

describe('prepublishOnly guard', () => {
  it('is defined in package.json', () => {
    expect(guard).toBeTypeOf('string');
  });

  it('refuses to publish from a commit without a release tag', () => {
    const dir = repoWithCommit();
    try {
      const r = runGuard(dir);
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain('No git tag found');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets the publish through from a tagged commit', () => {
    const dir = repoWithCommit();
    try {
      spawnSync('git', ['tag', 'v2.0.0'], { cwd: dir });
      const r = runGuard(dir);
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
