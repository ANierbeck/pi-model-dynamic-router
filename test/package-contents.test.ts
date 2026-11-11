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
// Since the files list moved from the `dist/` directory entry plus negations
// to an EXPLICIT allowlist of the build outputs (see package.json), no
// runtime or stray file can ship by construction — the exact-equality
// assertion below proves it. STATE_FILES (and STRAY_FILES, seeded from the
// 2026-10-22 `router-config.dynamic.json.bak-20261022-ghosts` incident, where
// a local backup rode the `dist/` directory entry into the tarball) are the
// seeded counterexamples that keep the proof non-vacuous. A new BUILD output
// needs a package.json `files` entry and a BUILD_OUTPUTS entry here; a new
// runtime state file needs a STATE_FILES entry here.

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rmTmpDir } from './helpers/router-env.ts';

const repoRoot = path.resolve(__dirname, '..');
const BUILD_OUTPUTS = [
  'index.js',
  'laya-model-install.js',
  'router-config.json',
  'router-defaults.yaml',
  'model-map.yaml',
];
// Keep in sync with every stateDir write — see SYNC RULE in the header.
// Currently: src/cache.ts CacheManager and the dynamic-config save in index.ts.
const STATE_FILES = ['.cache/scan-cache.json', 'router-config.dynamic.json'];
// Stray non-build, non-state files that must never ship — seeded counterexamples.
const STRAY_FILES = ['router-config.dynamic.json.bak-20261022-ghosts', 'scratch.txt'];
// Release gate (owner 2026-10-29, hygiene Phase 2 Step 3a): the only skill
// directories allowed in the tarball. Adding one is a deliberate act.
// router-laya-install: owner decision in docs/plans/2026-11-08-laya-model-artifact.md
// (the install skill, "asks before it acts").
const SHIPPED_SKILLS = ['content-based-router', 'router-laya-install', 'router-login'];
// Top-level docs that ship. README links to the CHANGELOG's migration section,
// so the two travel together; TODO.md is repo-only.
const SHIPPED_DOCS = ['PI.md', 'README.md', 'CHANGELOG.md'];

describe('npm package contents', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmTmpDir(tmpDir);
    tmpDir = undefined;
  });

  it('ships the build outputs but never runtime state from dist/', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-contents-'));
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(tmpDir, 'package.json'));
    for (const rel of [...BUILD_OUTPUTS, ...STATE_FILES, ...STRAY_FILES]) {
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

  it('ships every directory under skills/ — so the allowlist, not the packer, is the gate (hygiene Phase 2, Step 3a)', () => {
    // Premise of the gate below: `files` names `skills/`, which is a wildcard.
    // Anything a future commit puts there ships to every user. This test makes
    // that explicit with a seeded third directory, so the allowlist assertion
    // in the next test is provably the thing doing the work.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-skills-'));
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(tmpDir, 'package.json'));
    for (const rel of BUILD_OUTPUTS) {
      const file = path.join(tmpDir, 'dist', rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}');
    }
    for (const dir of [...SHIPPED_SKILLS, 'laya-tooling']) {
      fs.mkdirSync(path.join(tmpDir, 'skills', dir), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'skills', dir, 'SKILL.md'), '# x\n');
    }

    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    const skillDirs = [
      ...new Set(files.filter((f) => f.startsWith('skills/')).map((f) => f.split('/')[1])),
    ].sort();

    expect(skillDirs).toEqual([...SHIPPED_SKILLS, 'laya-tooling'].sort());
  }, 30_000);

  it('the repo ships exactly the three user-facing skills (release gate, owner 2026-10-29; router-laya-install per the 2026-11-08 artifact plan)', () => {
    // The Laya training tooling must not ship: /laya-label, /laya-sidecar and
    // /classifier-replay are Pi extensions outside this repo, and the training
    // scripts live in ~/.laya-ft. A new directory under skills/ is a
    // deliberate act — adding it here is the same kind of decision as adding a
    // build output to BUILD_OUTPUTS.
    const dirs = fs
      .readdirSync(path.join(repoRoot, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([...SHIPPED_SKILLS].sort());
  });

  it('top-level docs in the tarball are exactly PI.md, README.md, CHANGELOG.md', () => {
    // README.md tells the reader to use "the CHANGELOG's combined migration
    // section" for the pre-1.7.0 upgrade — a reference that dangles when the
    // tarball ships README.md without CHANGELOG.md. The doc allowlist is
    // pinned here so a new top-level doc is a deliberate act.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-docs-'));
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(tmpDir, 'package.json'));
    for (const rel of BUILD_OUTPUTS) {
      const file = path.join(tmpDir, 'dist', rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}');
    }
    for (const doc of [...SHIPPED_DOCS, 'TODO.md']) {
      fs.writeFileSync(path.join(tmpDir, doc), '# x\n');
    }

    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    const docs = files.filter((f) => !f.includes('/') && f.endsWith('.md')).sort();

    expect(docs).toEqual([...SHIPPED_DOCS].sort());
  }, 30_000);

  it('BUILD_OUTPUTS stays in sync with the files the build script produces (merge review 2026-11-01)', () => {
    // The allowlist in package.json `files` and this test's BUILD_OUTPUTS are
    // both hand-maintained next to the build script — a new build output that
    // is neither listed in `files` nor here would silently not ship (or ship
    // untested). Derive the script's dist/ outputs from the build command and
    // require exact equality.
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const build: string = pkg.scripts.build;
    const fromScript = new Set<string>();
    // Every esbuild entry: the extension and the pi-laya-model installer.
    for (const outfile of build.matchAll(/--outfile=(\S+)/g)) {
      if (outfile[1]?.startsWith('dist/')) fromScript.add(outfile[1].slice('dist/'.length));
    }
    const cp = build.match(/\bcp\s+([^&|;]+?)\s+dist\//);
    if (cp) for (const f of cp[1].trim().split(/\s+/)) fromScript.add(f);
    expect([...fromScript].sort()).toEqual([...BUILD_OUTPUTS].sort());
  });

  it('ships the pi-laya-model installer: its bin target and exactly the manifest from laya-models/', () => {
    // plan 2026-11-08-laya-model-artifact.md, Solution 1 + 4. `files` names the
    // manifest FILE, not the directory: weights dropped into laya-models/ by
    // hand (1.3 GB) must never ride into the tarball. The seeded stray below
    // keeps that assertion non-vacuous.
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.bin).toEqual({ 'pi-laya-model': 'dist/laya-model-install.js' });

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-laya-'));
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(tmpDir, 'package.json'));
    for (const rel of BUILD_OUTPUTS) {
      const file = path.join(tmpDir, 'dist', rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}');
    }
    fs.mkdirSync(path.join(tmpDir, 'laya-models', 'router', '1.0.0'), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, 'laya-models', 'manifest.json'),
      path.join(tmpDir, 'laya-models', 'manifest.json')
    );
    fs.writeFileSync(path.join(tmpDir, 'laya-models', 'router', '1.0.0', 'model.safetensors'), 'x');

    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    expect(files).toContain(pkg.bin['pi-laya-model']);
    expect(files.filter((f) => f.startsWith('laya-models/'))).toEqual([
      'laya-models/manifest.json',
    ]);
  }, 30_000);

  it('the installer bundle runs on its own: shebang, no router code, finds the shipped manifest', async () => {
    // Owner decision 2 of the artifact plan: pi-laya-model runs WITHOUT Pi and
    // with Node built-ins only. Bundle the bin entry exactly like the build
    // does, into a package-shaped temp tree, and run it.
    const { build } = await import('esbuild');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-laya-bin-'));
    const bundle = path.join(tmpDir, 'dist', 'laya-model-install.js');
    await build({
      entryPoints: [path.join(repoRoot, 'src', 'laya-model-bin.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: bundle,
      logLevel: 'silent',
    });
    fs.mkdirSync(path.join(tmpDir, 'laya-models'));
    fs.copyFileSync(
      path.join(repoRoot, 'laya-models', 'manifest.json'),
      path.join(tmpDir, 'laya-models', 'manifest.json')
    );
    const code = fs.readFileSync(bundle, 'utf8');
    expect(code.startsWith('#!/usr/bin/env node')).toBe(true);
    // Router modules must not leak in (they would drag the whole extension along).
    expect(code).not.toMatch(/src\/(content-classifier|config-loader|logger|routing)\.ts/);
    expect(code.length).toBeLessThan(80_000);

    const offer = JSON.parse(
      execFileSync(process.execPath, [bundle, 'models', '--json'], { encoding: 'utf8' })
    );
    expect(offer.map((o: { model: string }) => o.model)).toContain('router');
  }, 30_000);
});
