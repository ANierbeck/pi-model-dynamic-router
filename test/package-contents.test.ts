// test/package-contents.test.ts
// Regression: stateDir defaults to the extension dir (dist/), so runtime state
// (dist/.cache/scan-cache.json, dist/router-config.dynamic.json) was swept into
// the tarball by the `dist/` entry of package.json `files`. A locally packed
// tarball seeded private scan state into the pi-work sandbox, and a publish
// would have shipped it to the registry.
//
// The test packs a synthetic tree (the real package.json plus fake build
// outputs and fake state files) in a temp dir, so it checks the real `files`
// rules without building and without touching the live state in ./dist.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const BUILD_OUTPUTS = ['index.js', 'router-config.json', 'router-defaults.yaml', 'model-map.yaml'];
const STATE_FILES = ['.cache/scan-cache.json', 'router-config.dynamic.json'];

describe('npm package contents', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('ships the build outputs but never runtime state from dist/', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-contents-'));
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(tmpDir, 'package.json'));
    for (const rel of [...BUILD_OUTPUTS, ...STATE_FILES]) {
      const file = path.join(tmpDir, 'dist', rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}');
    }

    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    const distFiles = files.filter((f) => f.startsWith('dist/')).sort();

    expect(distFiles).toEqual(BUILD_OUTPUTS.map((f) => `dist/${f}`).sort());
  }, 30_000);
});
