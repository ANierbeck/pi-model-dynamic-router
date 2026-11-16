// The sidecar is not a package of its own any more (plan
// docs/plans/2026-11-16-laya-sidecar-in-router-tarball.md, D1): its code ships as
// dist/laya-sidecar.js inside the router tarball. This directory stays the place where the source,
// the tests and the parity runner live, and its package.json + package-lock.json double as the
// spec that `pi-laya-model runtime install` hands to `npm ci`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

test('the package can never be published by accident', () => {
  assert.equal(pkg.private, true);
  assert.equal(pkg.bin, undefined, 'the command is pi-laya-model serve, in the router package');
  assert.equal(pkg.files, undefined, 'nothing here is packed on its own');
  assert.equal(pkg.publishConfig, undefined);
});

test('the only runtime dependency is the pinned ONNX runtime', () => {
  // This package.json is copied into the user's runtime directory and installed with
  // `npm ci --omit=dev`: every entry here is downloaded by every Laya user.
  assert.deepEqual(Object.keys(pkg.dependencies), ['onnxruntime-node']);
  assert.match(pkg.dependencies['onnxruntime-node'], /^\d+\.\d+\.\d+$/);
});

test('no install script of our own', () => {
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(pkg.scripts?.[hook], undefined, `${hook} must not exist`);
  }
});
