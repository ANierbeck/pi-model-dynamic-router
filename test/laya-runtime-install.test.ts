// test/laya-runtime-install.test.ts
//
// pi-laya-model runtime install / verify / remove: the ONNX runtime the
// shipped sidecar needs, installed on demand (plan
// docs/plans/2026-11-16-laya-sidecar-in-router-tarball.md, step 2).
//
// Promises under test:
//  - pinned and verified: the install is `npm ci` on the shipped lockfile, so
//    npm checks every tarball against its integrity hash;
//  - no install script ever runs (`--ignore-scripts`): the onnxruntime-node
//    postinstall is the unverified CUDA download on Linux x64;
//  - atomic: a failed install leaves nothing behind and never damages an
//    existing runtime;
//  - an unsupported platform is refused BEFORE anything is downloaded.
//
// npm is a seam (`run`), so nothing here touches the network. The real
// `npm ci` is exercised by the release rehearsal.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultRuntimeDir,
  installRuntime,
  LayaRuntimeError,
  pinnedRuntimeVersion,
  removeRuntime,
  shippedRuntimeSpecDir,
  verifyRuntime,
  type RunFn,
} from '../src/laya-runtime-install.ts';
import { rmTmpDir } from './helpers/router-env.ts';

let tmp: string;
let dir: string;
let specDir: string;

const PIN = '9.9.9';
const SPEC = {
  name: 'spec',
  private: true,
  dependencies: { 'onnxruntime-node': PIN },
  devDependencies: { typescript: '1.0.0' },
};
const LOCK = { name: 'spec', lockfileVersion: 3, packages: { '': {} } };

/** What a successful `npm ci` leaves behind: the package and one native binding. */
function fakeNpm(
  opts: { version?: string; platform?: string; arch?: string; code?: number } = {}
): RunFn & { calls: { args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] } {
  const calls: { args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const run: RunFn = (args, o) => {
    calls.push({ args, cwd: o.cwd, env: o.env });
    if ((opts.code ?? 0) !== 0) {
      return Promise.resolve({ code: opts.code!, stderr: 'npm ERR! EINTEGRITY sha512 mismatch' });
    }
    const pkg = path.join(o.cwd, 'node_modules', 'onnxruntime-node');
    const bin = path.join(pkg, 'bin', 'napi-v6', opts.platform ?? 'linux', opts.arch ?? 'arm64');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'onnxruntime_binding.node'), 'x');
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'onnxruntime-node', version: opts.version ?? PIN })
    );
    return Promise.resolve({ code: 0, stderr: '' });
  };
  return Object.assign(run, { calls });
}

const linux = { platform: 'linux', arch: 'arm64' } as const;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-runtime-'));
  dir = path.join(tmp, 'agent', 'laya-runtime');
  specDir = path.join(tmp, 'spec');
  fs.mkdirSync(specDir);
  fs.writeFileSync(path.join(specDir, 'package.json'), JSON.stringify(SPEC));
  fs.writeFileSync(path.join(specDir, 'package-lock.json'), JSON.stringify(LOCK));
});

afterEach(() => rmTmpDir(tmp));

describe('installRuntime', () => {
  it('runs npm ci on the shipped lockfile, without dev packages and without install scripts', async () => {
    const run = fakeNpm();
    const res = await installRuntime({ dir, specDir, run, ...linux });

    expect(run.calls).toHaveLength(1);
    expect(run.calls[0].args).toEqual(
      expect.arrayContaining(['ci', '--omit=dev', '--ignore-scripts'])
    );
    // Belt and braces for the CUDA download, should a script ever run after all.
    expect(run.calls[0].env.ONNXRUNTIME_NODE_INSTALL).toBe('skip');
    expect(res).toMatchObject({ dir, version: PIN, installed: true });
    expect(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')).toBe(JSON.stringify(LOCK));
    expect(verifyRuntime({ dir, specDir, ...linux })).toMatchObject({ ok: true, version: PIN });
  });

  it('refuses a platform without a native binding before npm is started', async () => {
    const run = fakeNpm();
    await expect(
      installRuntime({ dir, specDir, run, platform: 'darwin', arch: 'x64' })
    ).rejects.toMatchObject({ code: 'platform' });
    expect(run.calls).toHaveLength(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('a failed npm run leaves nothing behind and reports what npm said', async () => {
    const err = await installRuntime({ dir, specDir, run: fakeNpm({ code: 1 }), ...linux }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(LayaRuntimeError);
    expect((err as LayaRuntimeError).code).toBe('runtime');
    expect((err as Error).message).toContain('EINTEGRITY');
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readdirSync(path.dirname(dir))).toEqual([]);
  });

  it('an install without a binding for this platform is discarded', async () => {
    const run = fakeNpm({ platform: 'win32', arch: 'x64' });
    await expect(installRuntime({ dir, specDir, run, ...linux })).rejects.toMatchObject({
      code: 'runtime',
    });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('a failed re-install keeps the runtime that was there', async () => {
    await installRuntime({ dir, specDir, run: fakeNpm(), ...linux });
    await expect(
      installRuntime({ dir, specDir, run: fakeNpm({ code: 1 }), force: true, ...linux })
    ).rejects.toBeInstanceOf(LayaRuntimeError);
    expect(verifyRuntime({ dir, specDir, ...linux }).ok).toBe(true);
  });

  it('is a no-op on a healthy runtime, and --force installs again', async () => {
    await installRuntime({ dir, specDir, run: fakeNpm(), ...linux });
    const again = fakeNpm();
    expect(await installRuntime({ dir, specDir, run: again, ...linux })).toMatchObject({
      installed: false,
    });
    expect(again.calls).toHaveLength(0);
    const forced = fakeNpm();
    expect(
      await installRuntime({ dir, specDir, run: forced, force: true, ...linux })
    ).toMatchObject({ installed: true });
    expect(forced.calls).toHaveLength(1);
  });
});

describe('two runtime installs at once', () => {
  // The runtime stages into <dir>.tmp and moves <dir> aside exactly like the model
  // install; without a lock the second run deletes the first run's staging dir.
  const lockFile = () => `${dir}.install-lock`;

  it('refuses while another install holds the lock', async () => {
    fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
    fs.writeFileSync(lockFile(), 'someone-else\n');
    const err = await installRuntime({ dir, specDir, run: fakeNpm(), ...linux }).catch((e) => e);
    expect(err.code).toBe('busy');
    expect(err.message).toContain(lockFile());
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('releases the lock after a failed install', async () => {
    const failing = Object.assign(() => Promise.resolve({ code: 1, stderr: 'npm ERR! network' }), {
      calls: [],
    }) as unknown as Parameters<typeof installRuntime>[0]['run'];
    await installRuntime({ dir, specDir, run: failing, ...linux }).catch(() => {});
    expect(fs.existsSync(lockFile())).toBe(false);
  });
});

describe('verifyRuntime', () => {
  it('names the install command when nothing is installed', () => {
    const res = verifyRuntime({ dir, specDir, ...linux });
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/not installed.*pi-laya-model runtime install/);
  });

  it('catches a runtime version the router no longer pins', async () => {
    await installRuntime({ dir, specDir, run: fakeNpm(), ...linux });
    fs.writeFileSync(
      path.join(specDir, 'package.json'),
      JSON.stringify({ ...SPEC, dependencies: { 'onnxruntime-node': '10.0.0' } })
    );
    const res = verifyRuntime({ dir, specDir, ...linux });
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/9\.9\.9.*10\.0\.0/);
  });

  it('catches a lockfile that differs from the shipped one (transitive drift after an update)', async () => {
    await installRuntime({ dir, specDir, run: fakeNpm(), ...linux });
    fs.writeFileSync(
      path.join(specDir, 'package-lock.json'),
      JSON.stringify({ ...LOCK, changed: true })
    );
    const res = verifyRuntime({ dir, specDir, ...linux });
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/lockfile/);
  });

  it('catches a missing native binding', async () => {
    await installRuntime({ dir, specDir, run: fakeNpm(), ...linux });
    fs.rmSync(path.join(dir, 'node_modules', 'onnxruntime-node', 'bin'), { recursive: true });
    const res = verifyRuntime({ dir, specDir, ...linux });
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toMatch(/binding.*linux\/arm64/);
  });
});

describe('removeRuntime', () => {
  it('deletes the runtime directory and says so when there is none', async () => {
    await installRuntime({ dir, specDir, run: fakeNpm(), ...linux });
    expect(removeRuntime(dir)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(removeRuntime(dir)).toBe(false);
  });
});

describe('the shipped runtime spec', () => {
  const shipped = shippedRuntimeSpecDir();
  const lock = JSON.parse(fs.readFileSync(path.join(shipped, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
  };

  it('pins the runtime to one exact version, and the lockfile agrees', () => {
    const pin = pinnedRuntimeVersion(shipped);
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packages['node_modules/onnxruntime-node'].version).toBe(pin);
  });

  it('every locked package comes from the npm registry with an integrity hash', () => {
    // This is what makes `npm ci` a verified install: no hash, no check.
    const entries = Object.entries(lock.packages).filter(([name]) => name !== '');
    expect(entries.length).toBeGreaterThan(5);
    for (const [name, p] of entries) {
      expect(p.resolved, name).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(p.integrity, name).toMatch(/^sha512-/);
    }
  });

  it('a range instead of an exact pin is refused', () => {
    fs.writeFileSync(
      path.join(specDir, 'package.json'),
      JSON.stringify({ ...SPEC, dependencies: { 'onnxruntime-node': '^9.9.9' } })
    );
    expect(() => pinnedRuntimeVersion(specDir)).toThrow(/exact version/);
  });

  it('the runtime lives next to the models in the Pi agent directory', () => {
    const before = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'profile');
    try {
      expect(defaultRuntimeDir()).toBe(path.join(tmp, 'profile', 'laya-runtime'));
    } finally {
      if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = before;
    }
  });
});

// ── command line ───────────────────────────────────────────────────────────

import { main, SIDECAR_DEFAULT_PORT, type CliDeps } from '../src/laya-model-install.ts';
import { LAYA_DEFAULT_ENDPOINT } from '../src/laya-classifier.ts';

function cli(argv: string[], deps: CliDeps): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  return main(argv, { out: (s) => (out += s), err: (s) => (err += s) }, deps).then((code) => ({
    code,
    out,
    err,
  }));
}

describe('pi-laya-model runtime', () => {
  const deps = (run: RunFn): CliDeps => ({ run, specDir, ...linux });

  it('install, verify and remove work on --runtime-dir', async () => {
    const run = fakeNpm();
    const installed = await cli(['runtime', 'install', '--runtime-dir', dir, '--json'], deps(run));
    expect(installed.code).toBe(0);
    expect(JSON.parse(installed.out)).toMatchObject({ ok: true, dir, version: PIN });

    const verified = await cli(['runtime', 'verify', '--runtime-dir', dir], deps(run));
    expect(verified.code).toBe(0);
    expect(verified.out).toContain(`onnxruntime-node ${PIN}`);

    expect((await cli(['runtime', 'remove', '--runtime-dir', dir], deps(run))).code).toBe(0);
    const gone = await cli(['runtime', 'verify', '--runtime-dir', dir], deps(run));
    expect(gone.code).toBe(1);
    expect(gone.out + gone.err).toMatch(/not installed/);
  });

  it('a failed install exits 1 with the code in --json', async () => {
    const res = await cli(
      ['runtime', 'install', '--runtime-dir', dir, '--json'],
      deps(fakeNpm({ code: 1 }))
    );
    expect(res.code).toBe(1);
    expect(JSON.parse(res.out)).toMatchObject({ ok: false, code: 'runtime' });
  });

  it('an unknown or missing runtime sub-command is a usage error', async () => {
    expect((await cli(['runtime'], deps(fakeNpm()))).code).toBe(2);
    expect((await cli(['runtime', 'upgrade'], deps(fakeNpm()))).code).toBe(2);
  });
});

describe('pi-laya-model serve', () => {
  let root: string;
  let served: unknown[];
  const serveDeps = (): CliDeps => ({
    run: fakeNpm(),
    specDir,
    ...linux,
    serve: (o) => {
      served.push(o);
      return Promise.resolve();
    },
  });

  /** An install as `pi-laya-model install` leaves it: a record naming the head file. */
  function installedModel(): string {
    const modelDir = path.join(root, 'router', '1.0.0');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(
      path.join(modelDir, 'manifest.json'),
      JSON.stringify({
        schema_version: 1,
        model: 'router',
        version: '1.0.0',
        head_file: { path: 'head.json', format: 'head-json' },
        files: [],
      })
    );
    return modelDir;
  }

  beforeEach(() => {
    root = path.join(tmp, 'models');
    served = [];
  });

  it('starts the sidecar on the install directory, its head file and the runtime directory', async () => {
    const modelDir = installedModel();
    await installRuntime({ dir, specDir, run: fakeNpm(), ...linux });
    const res = await cli(
      ['serve', 'router@1.0.0', '--root', root, '--runtime-dir', dir, '--port', '18123'],
      serveDeps()
    );
    expect(res.code).toBe(0);
    expect(served).toEqual([
      { modelDir, headJson: path.join(modelDir, 'head.json'), port: 18123, runtimeDir: dir },
    ]);
  });

  it("the default port is the port of the router's default endpoint", () => {
    // Two constants on purpose: the installer bundle must not pull in the classifier module.
    expect(String(SIDECAR_DEFAULT_PORT)).toBe(new URL(LAYA_DEFAULT_ENDPOINT).port);
  });

  it('defaults to port 8089, the endpoint the router calls', async () => {
    installedModel();
    await installRuntime({ dir, specDir, run: fakeNpm(), ...linux });
    await cli(['serve', 'router@1.0.0', '--root', root, '--runtime-dir', dir], serveDeps());
    expect(served).toHaveLength(1);
    expect((served[0] as { port: number }).port).toBe(8089);
  });

  it('refuses to start without the runtime and names the install command', async () => {
    installedModel();
    const res = await cli(
      ['serve', 'router@1.0.0', '--root', root, '--runtime-dir', dir],
      serveDeps()
    );
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/pi-laya-model runtime install/);
    expect(served).toEqual([]);
  });

  it('refuses a model that is not installed and names the install command', async () => {
    await installRuntime({ dir, specDir, run: fakeNpm(), ...linux });
    const res = await cli(
      ['serve', 'router@1.0.0', '--root', root, '--runtime-dir', dir],
      serveDeps()
    );
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/not installed.*pi-laya-model install router@1\.0\.0/);
    expect(served).toEqual([]);
  });

  it('a port that is not a port is a usage error', async () => {
    installedModel();
    const res = await cli(['serve', 'router@1.0.0', '--root', root, '--port', 'http'], serveDeps());
    expect(res.code).toBe(2);
    expect(served).toEqual([]);
  });
});
