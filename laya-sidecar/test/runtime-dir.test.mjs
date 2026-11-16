// Plan docs/plans/2026-11-16-laya-sidecar-in-router-tarball.md, step 1: the ONNX runtime is not a
// dependency of the shipped sidecar. It lives in a runtime directory the user installs on demand,
// and the sidecar must (a) load it from there and (b) say how to install it when it is missing,
// before it touches the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A copy of the built sidecar outside the package: no node_modules above it. */
function detachedDist() {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-detached-'));
  cpSync(join(pkg, 'dist'), join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  return join(dir, 'dist');
}

test('a missing runtime is reported with the install command before the model is read', () => {
  const model = mkdtempSync(join(tmpdir(), 'model-'));
  writeFileSync(
    join(model, 'head.json'),
    JSON.stringify({ instructions: 'x', categories: ['simple'] })
  );
  const emptyRuntime = mkdtempSync(join(tmpdir(), 'runtime-empty-'));
  const r = spawnSync(
    process.execPath,
    [
      join(pkg, 'dist', 'server.js'),
      '--model-dir',
      model,
      '--head-json',
      join(model, 'head.json'),
      '--runtime-dir',
      emptyRuntime,
      '--port',
      '18997',
    ],
    { encoding: 'utf8', timeout: 60_000 }
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /ONNX runtime not found in .*runtime-empty-/);
  assert.match(r.stderr, /pi-laya-model runtime install/);
  // The model directory is incomplete too; the runtime problem must win, so the user fixes the
  // cheap thing first and no model file was read to get here.
  assert.doesNotMatch(r.stderr, /incomplete/);
});

test('the runtime is loaded from the runtime directory, not from a dependency tree', () => {
  const dist = detachedDist();
  const probe = join(dist, '..', 'probe.mjs');
  writeFileSync(
    probe,
    `import { useRuntime } from './dist/runtime.js';
const spec = 'onnxruntime-' + 'node';
let before = 'resolved';
try { await import(spec); } catch (e) { before = e.code; }
useRuntime(process.argv[2]);
const ort = await import(spec);
console.log(JSON.stringify({ before, after: typeof ort.InferenceSession }));
`
  );
  // The package directory doubles as a runtime directory: it has node_modules/onnxruntime-node.
  const r = spawnSync(process.execPath, [probe, pkg], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), {
    before: 'ERR_MODULE_NOT_FOUND',
    after: 'function',
  });
});

test('serve() is exported so the installer can run the sidecar in its own process', async () => {
  const mod = await import(join(pkg, 'dist', 'server.js'));
  assert.equal(typeof mod.serve, 'function');
});

test('the sidecar starts when it is invoked through a symlink (an npm bin link)', () => {
  // Found on 2026-11-16: `import.meta.url === file://${process.argv[1]}` is false for a symlinked
  // entry, so the process exited 0 and served nothing. scripts/lib/cli.ts already solved this with
  // realpath; the sidecar is its own build tree and cannot import from there.
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-link-'));
  const link = join(dir, 'laya-sidecar');
  symlinkSync(join(pkg, 'dist', 'server.js'), link);
  const r = spawnSync(process.execPath, [link], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 1, 'no arguments: the usage error, not a silent exit 0');
  assert.match(r.stderr, /usage: laya-sidecar --model-dir/);
});
