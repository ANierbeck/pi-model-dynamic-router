// Decision D4 (docs/plans/2026-11-11-onnx-sidecar-package.md, step 4): installing
// the sidecar must not download the CUDA libraries. The preload makes the install
// script believe it runs on linux/x64, where the download path exists; the proxy
// points at a closed port, so a download attempt fails instead of reaching NuGet.
// Red evidence (2026-11-12, this machine): without the committed .npmrc the same
// command exits 1 (ECONNREFUSED 127.0.0.1:9); with it, exit 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const preload = join(pkgDir, 'test', 'helpers', 'linux-x64-preload.cjs');

test('the package pins the skip flag in its own .npmrc', () => {
  const npmrc = readFileSync(join(pkgDir, '.npmrc'), 'utf8');
  assert.match(npmrc, /^onnxruntime-node-install=skip$/m);
});

test('rebuilding onnxruntime-node on linux/x64 without network fetches nothing and succeeds', () => {
  assert.ok(existsSync(join(pkgDir, 'node_modules', 'onnxruntime-node')), 'run npm install first');
  const env = {
    ...process.env,
    GLOBAL_AGENT_HTTPS_PROXY: 'http://127.0.0.1:9',
    NODE_OPTIONS: `-r ${preload}`,
  };
  delete env.ONNXRUNTIME_NODE_INSTALL;
  delete env.npm_config_onnxruntime_node_install;
  const r = spawnSync('npm', ['rebuild', 'onnxruntime-node'], {
    cwd: pkgDir,
    env,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
