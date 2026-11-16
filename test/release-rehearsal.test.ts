// test/release-rehearsal.test.ts
//
// scripts/release-rehearsal.ts — the delivery chain, end to end, against a
// synthetic release (plan docs/plans/2026-11-16-release-rehearsal.md).
//
// What this test can prove without a real 1.3 GB model: the ORDER of the
// steps, that the tarball is packed and installed, that the installer runs from
// the installed package against a loopback release, that the staged manifest
// differs from the shipped one only in `published` and `base_url`, and that a
// broken asset stops the run before anything is installed.
//
// What it cannot: the ONNX inference. `--no-serve` is the seam for that; the
// real rehearsal (host and container) runs the serve step.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rehearsal, stageManifest, type LayaManifestLike } from '../scripts/release-rehearsal.ts';

const repoRoot = path.resolve(__dirname, '..');
import { rmTmpDir } from './helpers/router-env.ts';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let tmp: string;
let assets: string;
let manifestPath: string;

const HEAD = { instructions: 'pick a category', categories: ['simple', 'standard'] };
const PAYLOAD: { asset: string; content: Buffer }[] = [
  { asset: 'head.json', content: Buffer.from(JSON.stringify(HEAD)) },
  { asset: 'encoder.onnx', content: Buffer.from('fake-onnx-encoder') },
  { asset: 'tokenizer.json', content: Buffer.from('{"t":1}') },
];

function writeRelease(opts: { publish?: boolean } = {}): LayaManifestLike {
  assets = path.join(tmp, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  for (const f of PAYLOAD) fs.writeFileSync(path.join(assets, f.asset), f.content);
  const manifest: LayaManifestLike = {
    schema_version: 1,
    models: [
      {
        model: 'router',
        version: '1.0.0',
        tag: 'laya-router-v1.0.0',
        published: opts.publish ?? false,
        base_url: 'https://github.com/example/repo/releases/download/laya-router-v1.0.0/',
        head: { sha256: sha(JSON.stringify(HEAD)), categories: HEAD.categories },
        backends: {
          onnx: {
            head_file: { path: 'head.json', format: 'head-json' },
            files: PAYLOAD.map((f) => ({
              path: f.asset,
              asset: f.asset,
              bytes: f.content.length,
              sha256: sha(f.content),
            })),
          },
        },
      },
    ],
  };
  manifestPath = path.join(tmp, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-'));
});

afterEach(() => rmTmpDir(tmp));

describe('stageManifest', () => {
  it('changes exactly two fields: published, and the base_url pointing at the loopback server', () => {
    const manifest = writeRelease();
    const staged = stageManifest(manifest, 'http://127.0.0.1:18111/');
    const before = JSON.stringify(manifest.models[0]);
    const after = JSON.stringify(staged.models[0]);
    const diff = (a: string, b: string) => a !== b;
    expect(diff(before, after)).toBe(true);
    expect(staged.models[0].published).toBe(true);
    expect(staged.models[0].base_url).toBe('http://127.0.0.1:18111/');
    // Everything that identifies the payload is untouched: the rehearsal must not
    // be able to pass against a manifest whose hashes it just rewrote.
    expect(staged.models[0].head).toEqual(manifest.models[0].head);
    expect(staged.models[0].backends).toEqual(manifest.models[0].backends);
    expect(staged.models[0].tag).toBe(manifest.models[0].tag);
    expect(manifest.models[0].published).toBe(false); // the input is not mutated
  });
});

describe('rehearsal', () => {
  it('refuses a release directory that does not match the manifest, before packing anything', async () => {
    writeRelease();
    fs.writeFileSync(path.join(assets, 'not-in-the-manifest.bin'), 'x');
    const res = await rehearsal({
      assets,
      manifestPath,
      workDir: path.join(tmp, 'work'),
      skipRuntime: true,
      noServe: true,
    });
    expect(res.ok).toBe(false);
    expect(res.steps[0].name).toBe('release directory');
    expect(res.steps[0].ok).toBe(false);
    expect(res.steps[0].detail).toMatch(/not-in-the-manifest\.bin: not in the manifest/);
    expect(res.steps).toHaveLength(1);
    expect(fs.existsSync(path.join(tmp, 'work', 'dist'))).toBe(false);
  }, 60_000);

  it('packs, installs, installs the model from a loopback release and verifies it', async () => {
    writeRelease();
    const res = await rehearsal({
      assets,
      manifestPath,
      workDir: path.join(tmp, 'work'),
      skipRuntime: true,
      noServe: true,
    });
    expect(res.steps.map((s) => s.name)).toEqual([
      'release directory',
      'npm pack',
      'install the tarball',
      'install the model',
      'verify the model',
    ]);
    expect(res.ok, JSON.stringify(res.steps, null, 2)).toBe(true);
    for (const s of res.steps) expect(s.ok, `${s.name}: ${s.detail}`).toBe(true);

    const agentDir = path.join(res.workDir, 'agent');
    const installed = path.join(agentDir, 'laya-models', 'router', '1.0.0');
    expect(fs.existsSync(path.join(installed, 'manifest.json'))).toBe(true);
    expect(fs.readFileSync(path.join(installed, 'encoder.onnx'), 'utf8')).toBe('fake-onnx-encoder');
    // The tarball is the real one: it carries the sidecar bundle and the runtime spec.
    const tarball = fs.readdirSync(path.join(res.workDir, 'pack')).find((f) => f.endsWith('.tgz'));
    expect(tarball).toBeTruthy();
    // And what was installed came out of it, not out of the repository.
    expect(fs.existsSync(path.join(agentDir, 'laya-runtime'))).toBe(false);
  }, 180_000);

  it('reports the installed tarball contents as part of the pack step', async () => {
    writeRelease();
    const res = await rehearsal({
      assets,
      manifestPath,
      workDir: path.join(tmp, 'work'),
      skipRuntime: true,
      noServe: true,
    });
    const pack = res.steps.find((s) => s.name === 'npm pack');
    expect(pack?.detail).toMatch(/dist\/laya-sidecar\.js/);
    expect(pack?.detail).toMatch(/laya-sidecar\/package-lock\.json/);
  }, 180_000);

  it('a corrupted asset fails at the release-directory step with the file named', async () => {
    writeRelease();
    fs.writeFileSync(path.join(assets, 'encoder.onnx'), 'tampered');
    const res = await rehearsal({
      assets,
      manifestPath,
      workDir: path.join(tmp, 'work'),
      skipRuntime: true,
      noServe: true,
    });
    expect(res.ok).toBe(false);
    expect(res.steps[0].detail).toMatch(/encoder\.onnx: sha256 differs|encoder\.onnx: \d+ bytes/);
  }, 60_000);

  it('a model that is not in the manifest is refused by name', async () => {
    writeRelease();
    const res = await rehearsal({
      assets,
      manifestPath,
      model: 'nope@9.9.9',
      workDir: path.join(tmp, 'work'),
      skipRuntime: true,
      noServe: true,
    });
    expect(res.ok).toBe(false);
    expect(res.steps[0].detail).toMatch(/nope@9\.9\.9 is not in the manifest/);
  }, 60_000);
});

describe('the rehearsal container', () => {
  const dir = path.join(repoRoot, 'rehearsal');

  it('is standalone: a plain Node base image, nothing from the maintainer machine', () => {
    const dockerfile = fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8');
    // The point of the container is a second platform, not a second copy of a private image.
    expect(dockerfile).toMatch(/^FROM node:22\.19\.0-/m);
    expect(dockerfile).not.toMatch(/claude-container|llm-container/);
    expect(dockerfile).toMatch(/USER agent/);
  });

  it('copies the repository without the host node_modules or the worktrees', () => {
    // The host's binaries are for another platform (`esbuild: Exec format error`) and the
    // worktrees are gigabytes; the container installs its own dependencies.
    const entry = fs.readFileSync(path.join(dir, 'entrypoint.sh'), 'utf8');
    expect(entry).toMatch(/--exclude=\.\/node_modules/);
    expect(entry).toMatch(/--exclude=\.\/\.worktrees/);
    expect(entry).toMatch(/npm ci/);
    expect(entry).toMatch(/exec node scripts\/release-rehearsal\.ts "\$@"/);
  });

  it('runs the same script as the host, with the arguments it is given', () => {
    const entry = fs.readFileSync(path.join(dir, 'entrypoint.sh'), 'utf8');
    expect(entry).toMatch(/--assets/); // documented in --help
    expect(entry).not.toMatch(/--skip-runtime\b.*--no-serve/); // never silently weakened
  });
});
