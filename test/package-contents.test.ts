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
//
// SYNC RULE (roborev job 644 LOW): STATE_FILES below must stay in sync with
// EVERY file stateDir can write — today .cache/scan-cache.json (CacheManager,
// src/cache.ts) and router-config.dynamic.json (index.ts dynamic-config save).
// A new runtime file under dist/ needs BOTH a `!dist/<path>` negation in
// package.json `files` AND an entry here: a missing negation ships the file
// (this test goes red because the packed dist/ list no longer equals
// BUILD_OUTPUTS), and a missing STATE_FILES entry leaves the new file
// unseeded, so a dropped negation would go unnoticed. The exact-equality
// assertion is the mechanism; STATE_FILES is the input set that feeds it.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const BUILD_OUTPUTS = ['index.js', 'router-config.json', 'router-defaults.yaml', 'model-map.yaml'];
// Keep in sync with every stateDir write — see SYNC RULE in the header.
// Currently: src/cache.ts CacheManager and the dynamic-config save in index.ts.
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
