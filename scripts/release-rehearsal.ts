// Release rehearsal: the delivery chain a user meets, end to end, before anything is published
// (plan docs/plans/2026-11-16-release-rehearsal.md).
//
//   node scripts/release-rehearsal.ts --assets <release dir> [options]
//
// Steps, in the order a user meets them:
//   1. release directory   the assets match the manifest byte for byte (laya-release-check)
//   2. npm pack            the real tarball, prepack -> build
//   3. install the tarball into an empty temp project
//   4. install the model   the INSTALLED pi-laya-model, against a loopback release
//   5. verify the model    the installed verify
//   6. runtime install     the real `npm ci` for the ONNX runtime (--skip-runtime opts out)
//   7. serve               /health identity equals the manifest, one /classify (--no-serve opts out)
//
// Nothing is published, no tag is created, the shipped manifest is not edited: the loopback server
// gets a STAGED copy that differs in exactly two fields (`published`, `base_url`).
//
// Exit codes: 0 all steps ok, 1 a step failed (the temp tree is kept for inspection), 2 usage.

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg, invokedDirectly } from './lib/cli.ts';
import { checkReleaseDir } from './laya-release-check.ts';
import { mb, messageOf, tail } from '../src/format.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SHIPPED_MANIFEST = join(REPO, 'laya-models', 'manifest.json');
const MIN_NODE = [22, 19, 0] as const;

/** The manifest fields the rehearsal needs; a subset of LayaManifest, so a fixture can be small. */
export interface LayaManifestLike {
  schema_version: number;
  models: {
    model: string;
    version: string;
    tag: string;
    published: boolean;
    base_url: string;
    head: { sha256: string; categories: string[] };
    backends: Record<
      string,
      {
        head_file: { path: string; format: string };
        files: { path: string; asset: string; bytes: number; sha256: string }[];
      }
    >;
  }[];
}

export interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

export interface RehearsalOptions {
  /** The directory that would be uploaded as release assets. */
  assets: string;
  /** Manifest to rehearse against. Default: the shipped one. */
  manifestPath?: string;
  /** model@version. Default: the first entry of the manifest. */
  model?: string;
  /** Loopback port for the staged release. Default: 0 (one free port). */
  port?: number;
  /** Working directory. Default: a fresh temp dir. */
  workDir?: string;
  /** Skip step 6 (`runtime install`, a real npm download). */
  skipRuntime?: boolean;
  /** Skip step 7 (`serve` + /health + /classify). The unit test uses this; a real run must not. */
  noServe?: boolean;
  onStep?: (step: StepResult) => void;
}

export interface RehearsalResult {
  ok: boolean;
  workDir: string;
  steps: StepResult[];
}

/** The staged manifest: `published` and `base_url` change, nothing that identifies the payload. */
export function stageManifest(manifest: LayaManifestLike, baseUrl: string): LayaManifestLike {
  return {
    ...manifest,
    models: manifest.models.map((m) => ({ ...m, published: true, base_url: baseUrl })),
  };
}

function nodeTooOld(): string | null {
  const [major = 0, minor = 0, patch = 0] = process.versions.node.split('.').map(Number);
  const [wantMajor, wantMinor, wantPatch] = MIN_NODE;
  const older =
    major < wantMajor ||
    (major === wantMajor && minor < wantMinor) ||
    (major === wantMajor && minor === wantMinor && patch < wantPatch);
  return older
    ? `node ${process.versions.node} is older than the engines minimum ${MIN_NODE.join('.')}`
    : null;
}

/**
 * Runs a command to completion. Asynchronous on purpose: the staged release is served from THIS
 * process, so blocking the event loop here would deadlock the download it is waiting for.
 */
function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      // npm is npm.cmd on Windows, which only a shell resolves.
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Kept apart on purpose: npm's --json writes to stdout, the build it runs writes to stderr.
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 600_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ code: 127, out: out.trim(), err: `${err}${e.message}`.trim() });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, out: out.trim(), err: err.trim() });
    });
  });
}

/** Serves the asset directory on loopback; resolves with the server and its base URL. */
function serveAssets(dir: string, port: number): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').replace(/^\//, ''));
    const file = join(dir, basename(name));
    if (!name || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-length': statSync(file).size });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      ok({ server, baseUrl: `http://127.0.0.1:${p}/` });
    });
  });
}

/** Waits for /health, then classifies once. Resolves with the health payload. */
/** The identity fields the sidecar reports on GET /health. */
export interface SidecarHealth {
  status: string;
  model?: string;
  version?: string;
  backend?: string;
  head_sha256: string;
}

/** Waits until the sidecar answers on /health, and returns what it reports. */
async function waitForSidecar(port: number, timeoutMs = 180_000): Promise<SidecarHealth> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return (await res.json()) as SidecarHealth;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the sidecar did not answer on 127.0.0.1:${port} within ${timeoutMs} ms ${last}`);
}

export async function rehearsal(opts: RehearsalOptions): Promise<RehearsalResult> {
  const steps: StepResult[] = [];
  const workDir = opts.workDir ?? join(tmpdir(), `rehearsal-${process.pid}-${Date.now()}`);
  const record = (name: string, ok: boolean, detail: string, ms: number): void => {
    const step: StepResult = { name, ok, detail, ms };
    steps.push(step);
    opts.onStep?.(step);
  };
  const fail = (name: string, detail: string, ms: number): RehearsalResult => {
    record(name, false, detail, ms);
    return { ok: false, workDir, steps };
  };

  // 1. the release directory -------------------------------------------------
  let t0 = Date.now();
  const oldNode = nodeTooOld();
  if (oldNode) return fail('release directory', oldNode, Date.now() - t0);
  const manifestPath = opts.manifestPath ?? SHIPPED_MANIFEST;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as LayaManifestLike;
  const first = manifest.models[0];
  if (!first) return fail('release directory', `${manifestPath} lists no model`, Date.now() - t0);
  const model = opts.model ?? `${first.model}@${first.version}`;
  // LayaManifestLike is the subset checkReleaseDir reads; no cast, so a manifest that stops
  // matching the schema fails to compile here.
  const problems = await checkReleaseDir(resolve(opts.assets), manifest, model);
  if (problems.length > 0) return fail('release directory', problems.join('; '), Date.now() - t0);
  const total = manifest.models
    .find((m) => `${m.model}@${m.version}` === model)!
    .backends.onnx?.files.reduce((n, f) => n + f.bytes, 0);
  record(
    'release directory',
    true,
    `${model}: ${readdirSync(opts.assets).length} assets, ${mb(total ?? 0)}`,
    Date.now() - t0
  );

  mkdirSync(workDir, { recursive: true });
  const agentDir = join(workDir, 'agent');
  mkdirSync(agentDir, { recursive: true });

  // 2. npm pack --------------------------------------------------------------
  t0 = Date.now();
  const packDir = join(workDir, 'pack');
  mkdirSync(packDir, { recursive: true });
  // --loglevel=silent: `prepack` runs the build, and its output would sit in front of the JSON.
  const pack = await run(
    'npm',
    ['pack', '--pack-destination', packDir, '--json', '--loglevel=silent'],
    {
      cwd: REPO,
    }
  );
  if (pack.code !== 0) return fail('npm pack', tail(`${pack.out}\n${pack.err}`), Date.now() - t0);
  const tarball = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  if (!tarball) return fail('npm pack', `no tarball in ${packDir}`, Date.now() - t0);
  let listed: { files: { path: string }[] }[];
  try {
    listed = JSON.parse(pack.out) as typeof listed;
  } catch (e) {
    return fail(
      'npm pack',
      `cannot read npm's JSON: ${messageOf(e)}\n${tail(`${pack.out}\n${pack.err}`)}`,
      Date.now() - t0
    );
  }
  const files = (listed[0]?.files ?? []).map((f) => f.path);
  // The two entries that make the sidecar work at all (plan 2026-11-16, D1/D2).
  for (const must of ['dist/laya-sidecar.js', 'laya-sidecar/package-lock.json']) {
    if (!files.includes(must)) {
      return fail('npm pack', `${must} is missing from the tarball`, Date.now() - t0);
    }
  }
  const tarballPath = join(packDir, tarball);
  record(
    'npm pack',
    true,
    `${tarball} (${files.length} files, ${mb(statSync(tarballPath).size)}): ${files.join(', ')}`,
    Date.now() - t0
  );

  // 3. install the tarball ---------------------------------------------------
  t0 = Date.now();
  const project = join(workDir, 'project');
  mkdirSync(project, { recursive: true });
  writeJson(join(project, 'package.json'), { name: 'rehearsal', private: true, version: '0.0.0' });
  // --omit=peer: the rehearsal runs the installer and the sidecar, not the Pi host,
  // and the host packages are peer dependencies of the router.
  const install = await run('npm', ['install', '--no-save', '--omit=peer', tarballPath], {
    cwd: project,
  });
  if (install.code !== 0)
    return fail('install the tarball', tail(`${install.out}\n${install.err}`), Date.now() - t0);
  const pkgDir = join(project, 'node_modules', '@anierbeck', 'pi-model-dynamic-router');
  const bin = join(pkgDir, 'dist', 'laya-model-install.js');
  if (!existsSync(bin)) {
    return fail('install the tarball', `${bin} is missing after the install`, Date.now() - t0);
  }
  record('install the tarball', true, pkgDir, Date.now() - t0);

  // 4. install the model from a loopback release -----------------------------
  t0 = Date.now();
  const { server, baseUrl } = await serveAssets(resolve(opts.assets), opts.port ?? 0);
  const stagedPath = join(workDir, 'manifest.staged.json');
  writeJson(stagedPath, stageManifest(manifest, baseUrl));
  const env = { PI_CODING_AGENT_DIR: agentDir };
  try {
    const got = await run('node', [bin, 'install', model, '--manifest', stagedPath, '--json'], {
      cwd: project,
      env,
    });
    if (got.code !== 0)
      return fail('install the model', tail(`${got.out}\n${got.err}`), Date.now() - t0);
    record('install the model', true, `${model} from ${baseUrl}`, Date.now() - t0);

    // 5. verify --------------------------------------------------------------
    t0 = Date.now();
    const verified = await run('node', [bin, 'verify', model, '--json'], { cwd: project, env });
    if (verified.code !== 0)
      return fail('verify the model', tail(`${verified.out}\n${verified.err}`), Date.now() - t0);
    record('verify the model', true, `${model}: ok`, Date.now() - t0);

    // 6. the ONNX runtime ----------------------------------------------------
    if (!opts.skipRuntime) {
      t0 = Date.now();
      const rt = await run('node', [bin, 'runtime', 'install', '--json'], {
        cwd: project,
        env,
        timeoutMs: 1_800_000,
      });
      if (rt.code !== 0)
        return fail('runtime install', tail(`${rt.out}\n${rt.err}`), Date.now() - t0);
      const rtOut = JSON.parse(rt.out) as { dir?: string; version?: string };
      record(
        'runtime install',
        true,
        `onnxruntime-node ${rtOut.version} in ${rtOut.dir}`,
        Date.now() - t0
      );
    }

    // 7. serve, /health, /classify -------------------------------------------
    if (!opts.noServe) {
      t0 = Date.now();
      const port = 18_000 + (process.pid % 1000);
      const child = spawn('node', [bin, 'serve', model, '--port', String(port)], {
        cwd: project,
        // process.env first: PATH has to survive, or spawn cannot even find node.
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      // Without a listener, a failed spawn is an unhandled 'error' event and kills the rehearsal.
      child.on('error', (e) => (log += `spawn failed: ${e.message}\n`));
      child.stdout.on('data', (c: Buffer) => (log += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (log += c.toString('utf8')));
      try {
        const health = await waitForSidecar(port);
        const entry = manifest.models.find((m) => `${m.model}@${m.version}` === model)!;
        const wrong: string[] = [];
        if (health.status !== 'ok') wrong.push(`status ${health.status}`);
        if (health.model !== entry.model) wrong.push(`model ${health.model}`);
        if (health.version !== entry.version) wrong.push(`version ${health.version}`);
        if (health.backend !== 'onnx') wrong.push(`backend ${health.backend}`);
        if (health.head_sha256 !== entry.head.sha256) wrong.push(`head ${health.head_sha256}`);
        if (wrong.length > 0) {
          return fail('serve', `identity mismatch: ${wrong.join(', ')}`, Date.now() - t0);
        }
        const res = await fetch(`http://127.0.0.1:${port}/classify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'Refactor the parser and add tests', context: {} }),
        });
        const answer = (await res.json()) as {
          category?: string;
          confidence?: number;
          ms?: number;
        };
        if (!answer.category || !entry.head.categories.includes(answer.category)) {
          return fail('serve', `invalid category ${JSON.stringify(answer)}`, Date.now() - t0);
        }
        record(
          'serve',
          true,
          `identity ok, ${answer.category} ${answer.confidence?.toFixed(3)} in ${answer.ms} ms`,
          Date.now() - t0
        );
      } catch (e) {
        return fail(
          'serve',
          `${e instanceof Error ? e.message : String(e)}\n${tail(log)}`,
          Date.now() - t0
        );
      } finally {
        child.kill('SIGTERM');
      }
    }
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }

  return { ok: steps.every((s) => s.ok), workDir, steps };
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

async function main(): Promise<void> {
  const assets = arg('assets');
  if (!assets) {
    console.error(
      'usage: release-rehearsal.ts --assets <release dir> [--manifest <file>] [--model <m>@<v>] ' +
        '[--port <n>] [--skip-runtime] [--no-serve] [--keep] [--json]'
    );
    process.exit(2);
  }
  const json = process.argv.includes('--json');
  const started = Date.now();
  const res = await rehearsal({
    assets,
    ...(arg('manifest') ? { manifestPath: arg('manifest')! } : {}),
    ...(arg('model') ? { model: arg('model')! } : {}),
    ...(arg('port') ? { port: Number(arg('port')) } : {}),
    skipRuntime: process.argv.includes('--skip-runtime'),
    noServe: process.argv.includes('--no-serve'),
    ...(json
      ? {}
      : {
          onStep: (s: StepResult): void =>
            console.log(`${s.ok ? '✓' : '✗'} ${s.name} (${s.ms} ms) ${s.detail}`),
        }),
  });
  if (json) console.log(JSON.stringify(res, null, 2));
  else {
    console.log(
      `${res.ok ? 'rehearsal ok' : 'rehearsal FAILED'} in ${((Date.now() - started) / 1000).toFixed(1)} s`
    );
    if (!res.ok) console.log(`work dir kept: ${res.workDir}`);
  }
  if (!res.ok) process.exitCode = 1;
}

if (invokedDirectly(import.meta.url)) await main();
