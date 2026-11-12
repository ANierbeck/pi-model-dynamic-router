// The npm tarball of the sidecar (plan step 8/10): a `laya-sidecar` command that runs the built
// server, the built code and the notices, and nothing from src/, test/ or scripts/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

test('the package declares a laya-sidecar command pointing at the built server', () => {
  assert.equal(typeof pkg.bin, 'object', 'bin must be an object');
  const target = pkg.bin['laya-sidecar'];
  assert.equal(target, 'dist/server.js');
  assert.ok(existsSync(join(pkgDir, target)), `${target} must exist after the build`);
  assert.match(
    readFileSync(join(pkgDir, target), 'utf8').split('\n')[0],
    /^#!\/usr\/bin\/env node/
  );
});

test('the tarball ships dist, the notices and the README; no sources or tests', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: pkgDir,
    encoding: 'utf8',
  });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  for (const must of [
    'dist/server.js',
    'dist/identity.js',
    'LICENSE-laya',
    'README.md',
    'package.json',
  ]) {
    assert.ok(files.includes(must), `${must} missing from the tarball`);
  }
  for (const banned of files) {
    assert.doesNotMatch(banned, /^(src|test|scripts)\//, `${banned} must not ship`);
  }
});
