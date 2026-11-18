// src/laya-runtime-install.ts
//
// The ONNX runtime of the shipped Laya sidecar, installed on demand (plan
// docs/plans/2026-11-16-laya-sidecar-in-router-tarball.md, decision D2).
//
// The router package carries the sidecar code but not `onnxruntime-node`
// (115 MB compressed, 308 MB unpacked, native). `pi-laya-model runtime
// install` puts it into <Pi agent dir>/laya-runtime, next to the models:
//
//  - `npm ci` on the lockfile shipped with the router, so npm checks every
//    tarball against its integrity hash and installs exactly the pinned tree;
//  - `--ignore-scripts`, so the onnxruntime-node postinstall never runs. On
//    Linux x64 that script downloads CUDA libraries without a digest check
//    (docs/research/2026-11-11-onnx-sidecar-package-facts.md, section 2); the
//    CPU binding the sidecar uses is in the npm tarball itself;
//  - into a temporary directory that replaces the runtime only after it
//    verified, so a failed install leaves nothing behind.
//
// The spec (package.json + package-lock.json) is the sidecar's own, in
// laya-sidecar/: one lockfile for development, CI and the user's install.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { piAgentDir } from './agent-dir.ts';
import { tail } from './format.ts';
import { acquireInstallLock } from './install-lock.ts';

export const RUNTIME_PACKAGE = 'onnxruntime-node';
const SPEC_FILES = ['package.json', 'package-lock.json'] as const;
const TMP_SUFFIX = '.tmp';
const OLD_SUFFIX = '.old';
const INSTALL_HINT = 'pi-laya-model runtime install';

/**
 * Platforms with a native binding in the onnxruntime-node tarball (research
 * note of 2026-11-11, section 1). darwin/x64 has none in any 1.3x version.
 * Tuples, not "platform/arch" strings: the ADR-0025 scanner reads `a/b` as a
 * model reference, and a platform is not one.
 */
const SUPPORTED_PLATFORMS: readonly (readonly [string, string])[] = [
  ['darwin', 'arm64'],
  ['linux', 'x64'],
  ['linux', 'arm64'],
  ['win32', 'x64'],
  ['win32', 'arm64'],
];

const isSupported = (platform: string, arch: string): boolean =>
  SUPPORTED_PLATFORMS.some(([p, a]) => p === platform && a === arch);

export type RuntimeErrorCode = 'platform' | 'runtime' | 'busy' | 'io';

export class LayaRuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'LayaRuntimeError';
  }
}

export interface RunResult {
  code: number;
  stderr: string;
}

/** Runs npm to completion. A seam: the tests never start a process. */
export type RunFn = (
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => Promise<RunResult>;

export interface RuntimeTarget {
  /** The runtime directory; its node_modules holds the runtime. */
  dir: string;
  /** Directory with the shipped package.json and package-lock.json. */
  specDir: string;
  platform?: string;
  arch?: string;
}

export interface RuntimeInstallOptions extends RuntimeTarget {
  run?: RunFn;
  /** Install again even when the runtime verifies. */
  force?: boolean;
}

export interface RuntimeInstallResult {
  dir: string;
  version: string;
  /** false: a healthy runtime was already there and nothing was downloaded. */
  installed: boolean;
}

export interface RuntimeVerifyResult {
  ok: boolean;
  dir: string;
  problems: string[];
  /** The installed runtime version, when one is readable. */
  version?: string;
}

/** <Pi agent dir>/laya-runtime — next to laya-models, and follows PI_CODING_AGENT_DIR like it. */
export function defaultRuntimeDir(): string {
  return path.join(piAgentDir(), 'laya-runtime');
}

/** The spec shipped with this package: <package>/laya-sidecar/. */
export function shippedRuntimeSpecDir(): string {
  return fileURLToPath(new URL('../laya-sidecar/', import.meta.url));
}

/** The exact runtime version the spec pins; a range is an error, never a guess. */
export function pinnedRuntimeVersion(specDir: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(specDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const pin = pkg.dependencies?.[RUNTIME_PACKAGE];
  if (!pin || !/^\d+\.\d+\.\d+$/.test(pin)) {
    throw new LayaRuntimeError(
      'runtime',
      `${path.join(specDir, 'package.json')} must pin ${RUNTIME_PACKAGE} to an exact version, found ${JSON.stringify(pin)}`
    );
  }
  return pin;
}

const defaultRun: RunFn = (args, opts) =>
  new Promise((resolve) => {
    // npm is npm.cmd on Windows, which only a shell resolves.
    const child = spawn('npm', args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (err) => resolve({ code: 127, stderr: `npm: ${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
  });

/** True when <pkg>/bin/<napi>/<platform>/<arch>/ holds a native binding. */
function hasBinding(pkgDir: string, platform: string, arch: string): boolean {
  let napiDirs: string[];
  try {
    napiDirs = fs.readdirSync(path.join(pkgDir, 'bin'));
  } catch {
    return false;
  }
  return napiDirs.some((napi) => {
    try {
      return fs
        .readdirSync(path.join(pkgDir, 'bin', napi, platform, arch))
        .some((f) => f.endsWith('.node'));
    } catch {
      return false;
    }
  });
}

/** Checks an installed runtime against the shipped spec. Reads only. */
export function verifyRuntime(target: RuntimeTarget): RuntimeVerifyResult {
  const platform = target.platform ?? process.platform;
  const arch = target.arch ?? process.arch;
  const pkgDir = path.join(target.dir, 'node_modules', RUNTIME_PACKAGE);
  let version: string;
  try {
    version = (
      JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { version: string }
    ).version;
  } catch {
    return {
      ok: false,
      dir: target.dir,
      problems: [`the ONNX runtime is not installed in ${target.dir}; run: ${INSTALL_HINT}`],
    };
  }
  const problems: string[] = [];
  const pin = pinnedRuntimeVersion(target.specDir);
  if (version !== pin) {
    problems.push(
      `${RUNTIME_PACKAGE} ${version} is installed, this router pins ${pin}; run: ${INSTALL_HINT}`
    );
  }
  const read = (dir: string): string | null => {
    try {
      return fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8');
    } catch {
      return null;
    }
  };
  if (read(target.dir) !== read(target.specDir)) {
    problems.push(
      `the lockfile in ${target.dir} differs from the one this router ships; run: ${INSTALL_HINT}`
    );
  }
  if (!hasBinding(pkgDir, platform, arch)) {
    problems.push(`no native binding for ${platform}/${arch} in ${pkgDir}`);
  }
  return { ok: problems.length === 0, dir: target.dir, problems, version };
}

/** Installs the pinned runtime. Atomic: the directory changes only after a verified install. */
export async function installRuntime(opts: RuntimeInstallOptions): Promise<RuntimeInstallResult> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  if (!isSupported(platform, arch)) {
    throw new LayaRuntimeError(
      'platform',
      `${RUNTIME_PACKAGE} ships no native binding for ${platform}/${arch}; ` +
        `the Laya sidecar is not supported on this platform (nothing was downloaded)`
    );
  }
  const version = pinnedRuntimeVersion(opts.specDir);
  const target: RuntimeTarget = { dir: opts.dir, specDir: opts.specDir, platform, arch };
  if (!opts.force && verifyRuntime(target).ok) {
    return { dir: opts.dir, version, installed: false };
  }

  // The lock is taken here, not at the top: a refused install (wrong platform,
  // already installed) must not leave a lock file behind.
  const lock = acquireInstallLock(opts.dir);
  if (!lock.ok) throw new LayaRuntimeError(lock.reason, lock.message);
  try {
    const tmpDir = opts.dir + TMP_SUFFIX;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    const discard = (message: string): never => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw new LayaRuntimeError('runtime', message);
    };
    for (const f of SPEC_FILES) fs.copyFileSync(path.join(opts.specDir, f), path.join(tmpDir, f));

    const res = await (opts.run ?? defaultRun)(
      ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: tmpDir, env: { ...process.env, ONNXRUNTIME_NODE_INSTALL: 'skip' } }
    );
    if (res.code !== 0) {
      discard(`npm ci failed (exit ${res.code}); nothing was installed\n${tail(res.stderr)}`);
    }
    const check = verifyRuntime({ ...target, dir: tmpDir });
    if (!check.ok) {
      // The problems name the temporary directory; say where the install was headed.
      discard(
        `the installed runtime does not verify; nothing was installed in ${opts.dir}\n  ` +
          check.problems.join('\n  ')
      );
    }

    const oldDir = opts.dir + OLD_SUFFIX;
    fs.rmSync(oldDir, { recursive: true, force: true });
    if (fs.existsSync(opts.dir)) fs.renameSync(opts.dir, oldDir);
    fs.renameSync(tmpDir, opts.dir);
    fs.rmSync(oldDir, { recursive: true, force: true });
    return { dir: opts.dir, version, installed: true };
  } finally {
    lock.release();
  }
}

/** Deletes the runtime directory; false when there was none. */
export function removeRuntime(dir: string): boolean {
  const existed = fs.existsSync(dir);
  for (const d of [dir, dir + TMP_SUFFIX, dir + OLD_SUFFIX]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
  return existed;
}
