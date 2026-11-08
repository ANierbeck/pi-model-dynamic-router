// src/laya-model-install.ts
//
// pi-laya-model: installs, verifies, lists and removes Laya model artifacts
// (docs/plans/2026-11-08-laya-model-artifact.md, Solution 3 and 4).
//
// Layout: <root>/<model>/<version>/ with an install record (manifest.json)
// next to the weights, so an installed directory describes itself. The root
// defaults to <Pi agent dir>/laya-models (owner decision 1).
//
// Install is atomic: everything lands in <version>.tmp, every file is checked
// for size and sha256 and the head for its hash, and only then is the
// directory renamed into place. A checksum or head mismatch deletes the temp
// tree; an interrupted download keeps it, because it is the resume point —
// the next run continues a partial file with an HTTP Range request.
//
// Runs without Pi and without dependencies (Node built-ins only, owner
// decision 2): the router package keeps zero runtime dependencies. Logic
// lives here, testable; the skill only calls the command line.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { piAgentDir } from './agent-dir.ts';
import {
  headFromFile,
  headSha256,
  INSTALL_RECORD,
  isSafeName,
  LAYA_BACKENDS,
  validateManifest,
  type LayaArtifactFile,
  type LayaArtifactSet,
  type LayaBackend,
  type LayaManifest,
  type LayaModelVersion,
} from './laya-model-manifest.ts';

export type InstallErrorCode =
  | 'usage'
  | 'manifest'
  | 'not-found'
  | 'unpublished'
  | 'exists'
  | 'disk'
  | 'download'
  | 'checksum'
  | 'head';

export class LayaInstallError extends Error {
  constructor(
    readonly code: InstallErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'LayaInstallError';
  }
}

/** The install record written next to the weights. */
export interface InstallRecord {
  schema_version: 1;
  model: string;
  version: string;
  tag: string;
  backend: LayaBackend;
  head: { sha256: string; categories: string[] };
  head_file: LayaArtifactSet['head_file'];
  files: LayaArtifactFile[];
  installed_at: string;
}

export interface InstallResult {
  dir: string;
  model: string;
  version: string;
  backend: LayaBackend;
  bytesDownloaded: number;
  /** Paths continued from a partial file of an earlier, interrupted run. */
  resumed: string[];
}

export type ProgressFn = (file: string, done: number, total: number) => void;

export interface InstallOptions {
  manifest: LayaManifest;
  model: string;
  /** Default: the highest version of `model` in the manifest. */
  version?: string;
  /** Default: onnx (owner decision 3). */
  backend?: LayaBackend;
  root: string;
  force?: boolean;
  allowUnpublished?: boolean;
  /** Free bytes on the file system holding `dir`; injectable for tests. */
  freeBytes?: (dir: string) => number;
  onProgress?: ProgressFn;
  /** Abort a download that receives no data for this long. Default 60 s. */
  idleTimeoutMs?: number;
}

/** Spare room on top of the download itself, so an install never fills the disk. */
const DISK_MARGIN_BYTES = 256 * 1024 * 1024;
const TMP_SUFFIX = '.tmp';
const OLD_SUFFIX = '.old';

export function defaultModelsRoot(): string {
  return path.join(piAgentDir(), 'laya-models');
}

/** The manifest shipped with this package: <package>/laya-models/manifest.json. */
export function shippedManifestPath(): string {
  return fileURLToPath(new URL('../laya-models/manifest.json', import.meta.url));
}

/** Loads a manifest from a path, a file: URL or an https URL. Not validated here. */
export async function loadManifest(source: string): Promise<LayaManifest> {
  try {
    if (/^https:\/\//i.test(source)) {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as LayaManifest;
    }
    const file = source.startsWith('file:') ? fileURLToPath(source) : source;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as LayaManifest;
  } catch (err) {
    throw new LayaInstallError('manifest', `cannot read manifest ${source}: ${messageOf(err)}`);
  }
}

/** Numeric-aware version order: 1.10.0 > 1.9.0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    const d = !isNaN(nx) && !isNaN(ny) ? nx - ny : x.localeCompare(y);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The named version, or else the highest one — counting only published
 * versions unless unpublished ones are allowed, so a newer version listed
 * ahead of its release never hides the one users can actually download.
 */
function selectVersion(
  manifest: LayaManifest,
  model: string,
  version: string | undefined,
  allowUnpublished: boolean
): LayaModelVersion {
  const candidates = manifest.models.filter((m) => m.model === model);
  if (candidates.length === 0) {
    const known = [...new Set(manifest.models.map((m) => m.model))].join(', ');
    throw new LayaInstallError(
      'not-found',
      `model ${model} is not in the manifest (known: ${known})`
    );
  }
  if (version !== undefined) {
    const hit = candidates.find((m) => m.version === version);
    if (!hit) {
      const known = candidates.map((m) => m.version).join(', ');
      throw new LayaInstallError(
        'not-found',
        `${model}@${version} is not in the manifest (known: ${known})`
      );
    }
    return hit;
  }
  const pool = allowUnpublished ? candidates : candidates.filter((m) => m.published);
  // Nothing published: fall through to the newest, which then fails as 'unpublished'.
  return [...(pool.length > 0 ? pool : candidates)].sort((a, b) =>
    compareVersions(b.version, a.version)
  )[0];
}

/** `child` joined to `dir`, refusing anything that would leave `dir` (defence in depth). */
function inside(dir: string, child: string): string {
  const full = path.resolve(dir, child);
  if (!full.startsWith(path.resolve(dir) + path.sep)) {
    throw new LayaInstallError('manifest', `path ${child} leaves the install directory`);
  }
  return full;
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** The nearest existing ancestor: statfs needs a path that exists. */
function existingAncestor(dir: string): string {
  let d = path.resolve(dir);
  while (!fs.existsSync(d)) {
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return d;
}

function defaultFreeBytes(dir: string): number {
  const s = fs.statfsSync(existingAncestor(dir));
  return Number(s.bavail) * Number(s.bsize);
}

export async function installModel(opts: InstallOptions): Promise<InstallResult> {
  const problems = validateManifest(opts.manifest);
  if (problems.length > 0) {
    throw new LayaInstallError('manifest', `invalid manifest:\n  ${problems.join('\n  ')}`);
  }
  const entry = selectVersion(opts.manifest, opts.model, opts.version, !!opts.allowUnpublished);
  const id = `${entry.model}@${entry.version}`;
  if (!entry.published && !opts.allowUnpublished) {
    throw new LayaInstallError(
      'unpublished',
      `${id} is not published yet (release ${entry.tag} has no assets); ` +
        `--allow-unpublished installs it anyway from ${entry.base_url}`
    );
  }
  const backend = opts.backend ?? 'onnx';
  const set = entry.backends[backend];
  if (!set) {
    const known = Object.keys(entry.backends).join(', ');
    throw new LayaInstallError(
      'not-found',
      `${id} has no ${backend} artifact set (known: ${known})`
    );
  }

  const finalDir = path.join(opts.root, entry.model, entry.version);
  const tmpDir = finalDir + TMP_SUFFIX;
  if (fs.existsSync(finalDir) && !opts.force) {
    throw new LayaInstallError(
      'exists',
      `${id} is already installed in ${finalDir}; verify it, or reinstall with --force`
    );
  }

  // Free space for what is still missing, before anything is written.
  let need = 0;
  for (const f of set.files) {
    const have = sizeOf(inside(tmpDir, f.path));
    need += have >= 0 && have <= f.bytes ? f.bytes - have : f.bytes;
  }
  const free = (opts.freeBytes ?? defaultFreeBytes)(opts.root);
  if (free < need + DISK_MARGIN_BYTES) {
    throw new LayaInstallError(
      'disk',
      `not enough free space for ${id}: need ${mb(need + DISK_MARGIN_BYTES)} ` +
        `(incl. ${mb(DISK_MARGIN_BYTES)} margin), have ${mb(free)}`
    );
  }

  fs.mkdirSync(tmpDir, { recursive: true });
  const resumed: string[] = [];
  let bytesDownloaded = 0;
  const discard = (code: InstallErrorCode, message: string): never => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new LayaInstallError(code, message);
  };

  for (const f of set.files) {
    const dest = inside(tmpDir, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let have = sizeOf(dest);
    if (have > f.bytes) {
      fs.rmSync(dest);
      have = -1;
    }
    if (have < f.bytes) {
      const url = new URL(encodeURIComponent(f.asset), entry.base_url);
      const got = await download(url, dest, Math.max(have, 0), f, opts);
      bytesDownloaded += got.bytes;
      if (got.resumed) resumed.push(f.path);
    }
    const size = sizeOf(dest);
    if (size !== f.bytes) {
      discard(
        'checksum',
        `${f.path}: ${size} bytes, the manifest says ${f.bytes}; install discarded`
      );
    }
    const digest = await sha256Of(dest);
    if (digest !== f.sha256) {
      discard('checksum', `${f.path}: sha256 ${digest} ≠ manifest ${f.sha256}; install discarded`);
    }
  }

  const headProblem = checkHead(tmpDir, set.head_file, entry.head.sha256);
  if (headProblem) discard('head', `${headProblem}; install discarded`);

  const record: InstallRecord = {
    schema_version: 1,
    model: entry.model,
    version: entry.version,
    tag: entry.tag,
    backend,
    head: entry.head,
    head_file: set.head_file,
    files: set.files,
    installed_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(tmpDir, INSTALL_RECORD), JSON.stringify(record, null, 2) + '\n');

  if (fs.existsSync(finalDir)) {
    const old = finalDir + OLD_SUFFIX;
    fs.rmSync(old, { recursive: true, force: true });
    fs.renameSync(finalDir, old);
    fs.renameSync(tmpDir, finalDir);
    fs.rmSync(old, { recursive: true, force: true });
  } else {
    fs.renameSync(tmpDir, finalDir);
  }
  return {
    dir: finalDir,
    model: entry.model,
    version: entry.version,
    backend,
    bytesDownloaded,
    resumed,
  };
}

/** Null when the head file in `dir` hashes to `want`, else the problem. */
function checkHead(
  dir: string,
  headFile: LayaArtifactSet['head_file'],
  want: string
): string | null {
  let text: string;
  try {
    text = fs.readFileSync(inside(dir, headFile.path), 'utf8');
  } catch {
    return `head file ${headFile.path} is missing`;
  }
  const head = headFromFile(headFile.format, text);
  if (!head) return `head file ${headFile.path} is not a readable ${headFile.format} head`;
  const got = headSha256(head);
  return got === want ? null : `head sha256 ${got} ≠ manifest ${want}`;
}

/**
 * Fetches one asset into `dest`, continuing from `have` bytes when the server
 * honours Range (206). A 200 answer to a Range request replaces the partial
 * file. Any failure keeps what arrived — it is the next run's resume point.
 */
async function download(
  url: URL,
  dest: string,
  have: number,
  file: LayaArtifactFile,
  opts: InstallOptions
): Promise<{ bytes: number; resumed: boolean }> {
  const fail = (why: string): never => {
    throw new LayaInstallError(
      'download',
      `${file.path}: ${why} (${url.href}); run the install again to resume`
    );
  };
  let source: Readable;
  let append = false;
  if (url.protocol === 'file:') {
    const src = fileURLToPath(url);
    if (!fs.existsSync(src)) fail('not found');
    source = fs.createReadStream(src, { start: have });
    append = have > 0;
  } else {
    let res: Response;
    const controller = new AbortController();
    try {
      res = await fetch(url, {
        headers: have > 0 ? { range: `bytes=${have}-` } : {},
        signal: controller.signal,
      });
    } catch (err) {
      return fail(messageOf(err));
    }
    if (res.status === 206 && have > 0 && rangeStart(res) === have) {
      append = true;
    } else if (res.status === 206) {
      // A different range than asked: appending would corrupt the file, and
      // keeping the partial would hit the same answer on every run.
      fs.rmSync(dest, { force: true });
      await res.body?.cancel();
      return fail(`server answered a different range than bytes=${have}-; partial file dropped`);
    } else if (res.status !== 200) {
      await res.body?.cancel();
      return fail(`HTTP ${res.status}`);
    }
    if (!res.body) return fail('empty response body');
    source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on('close', () => controller.abort());
    watchIdle(source, controller, opts.idleTimeoutMs ?? 60_000);
  }
  const start = append ? have : 0;
  let done = start;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb): void {
      done += chunk.length;
      opts.onProgress?.(file.path, done, file.bytes);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(source, tap, fs.createWriteStream(dest, { flags: append ? 'a' : 'w' }));
  } catch (err) {
    return fail(messageOf(err));
  }
  return { bytes: done - start, resumed: append };
}

function rangeStart(res: Response): number {
  const m = /^bytes (\d+)-/.exec(res.headers.get('content-range') ?? '');
  return m ? Number(m[1]) : -1;
}

/** Aborts a stalled transfer: no data for `ms` → the stream errors. */
function watchIdle(stream: Readable, controller: AbortController, ms: number): void {
  let timer = setTimeout(() => controller.abort(), ms);
  stream.on('data', () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), ms);
  });
  stream.on('close', () => clearTimeout(timer));
}

function assertSafe(model: string, version: string): void {
  if (!isSafeName(model) || !isSafeName(version)) {
    throw new LayaInstallError(
      'usage',
      `invalid model@version ${JSON.stringify(`${model}@${version}`)}`
    );
  }
}

export async function verifyInstall(opts: {
  root: string;
  model: string;
  version: string;
}): Promise<{ ok: boolean; problems: string[] }> {
  assertSafe(opts.model, opts.version);
  const dir = path.join(opts.root, opts.model, opts.version);
  let record: InstallRecord;
  try {
    record = JSON.parse(fs.readFileSync(path.join(dir, INSTALL_RECORD), 'utf8')) as InstallRecord;
  } catch {
    return { ok: false, problems: [`no readable install record in ${dir}`] };
  }
  const problems: string[] = [];
  for (const f of record.files) {
    const file = inside(dir, f.path);
    const size = sizeOf(file);
    if (size < 0) problems.push(`${f.path}: missing`);
    else if (size !== f.bytes) problems.push(`${f.path}: ${size} bytes, expected ${f.bytes}`);
    else if ((await sha256Of(file)) !== f.sha256) problems.push(`${f.path}: sha256 mismatch`);
  }
  const headProblem = checkHead(dir, record.head_file, record.head.sha256);
  if (headProblem) problems.push(headProblem);
  return { ok: problems.length === 0, problems };
}

export async function listInstalls(
  root: string
): Promise<{ model: string; version: string; backend: string }[]> {
  const out: { model: string; version: string; backend: string }[] = [];
  const dirs = (p: string): string[] => {
    try {
      return fs
        .readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory() && isSafeName(d.name))
        .map((d) => d.name);
    } catch {
      return [];
    }
  };
  for (const model of dirs(root).sort()) {
    const versions = dirs(path.join(root, model)).filter(
      (v) => !v.endsWith(TMP_SUFFIX) && !v.endsWith(OLD_SUFFIX)
    );
    for (const version of versions.sort(compareVersions)) {
      try {
        const rec = JSON.parse(
          await fs.promises.readFile(path.join(root, model, version, INSTALL_RECORD), 'utf8')
        ) as InstallRecord;
        out.push({ model, version, backend: rec.backend });
      } catch {
        // Not an install (no record): left alone, not listed.
      }
    }
  }
  return out;
}

export async function removeInstall(opts: {
  root: string;
  model: string;
  version: string;
}): Promise<string> {
  assertSafe(opts.model, opts.version);
  const dir = path.join(opts.root, opts.model, opts.version);
  if (!fs.existsSync(dir) && !fs.existsSync(dir + TMP_SUFFIX)) {
    throw new LayaInstallError('not-found', `${opts.model}@${opts.version} is not installed`);
  }
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.rm(dir + TMP_SUFFIX, { recursive: true, force: true });
  return dir;
}

// ── command line ───────────────────────────────────────────────────────────

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Progress lines only on an interactive terminal. */
  isTTY?: boolean;
}

const USAGE = `Usage: pi-laya-model <command> [options]

  install <model>[@<version>]  download, verify and install a model
      --backend onnx|mlx         artifact set (default: onnx)
      --force                    replace an existing install
      --allow-unpublished        install a version whose release is not out yet
  verify  <model>@<version>    re-check every file and the head of an install
  list                         installed models
  remove  <model>@<version>    delete an install
  models                       what the manifest offers, with download sizes

Options for every command:
      --root <dir>               install root (default: <Pi agent dir>/laya-models)
      --manifest <path|url>      manifest (default: the one shipped with the router)
      --json                     machine-readable output
`;

const VALUE_FLAGS = new Set(['--root', '--manifest', '--backend']);
const BOOL_FLAGS = new Set(['--json', '--force', '--allow-unpublished']);

interface ParsedArgs {
  command: string;
  target?: string;
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command) throw new LayaInstallError('usage', 'no command');
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (VALUE_FLAGS.has(a)) {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) {
        throw new LayaInstallError('usage', `${a} needs a value`);
      }
      flags.set(a, v);
    } else if (BOOL_FLAGS.has(a)) {
      flags.set(a, true);
    } else if (a.startsWith('--')) {
      throw new LayaInstallError('usage', `unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) throw new LayaInstallError('usage', 'one model at a time');
  return { command, ...(positional[0] !== undefined ? { target: positional[0] } : {}), flags };
}

function splitTarget(target: string | undefined, needVersion: boolean): [string, string?] {
  if (!target) throw new LayaInstallError('usage', 'missing <model>[@<version>]');
  const at = target.indexOf('@');
  const model = at < 0 ? target : target.slice(0, at);
  const version = at < 0 ? undefined : target.slice(at + 1);
  if (needVersion && !version)
    throw new LayaInstallError('usage', 'name the version: <model>@<version>');
  return version === undefined ? [model] : [model, version];
}

/** Runs the command line; returns the exit code (0 ok, 1 failed, 2 usage). */
export async function main(argv: string[], io: CliIo): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(`pi-laya-model: ${messageOf(err)}\n\n${USAGE}`);
    return 2;
  }
  const json = args.flags.has('--json');
  const flag = (name: string): string | undefined => {
    const v = args.flags.get(name);
    return typeof v === 'string' ? v : undefined;
  };
  const root = flag('--root') ?? defaultModelsRoot();
  const emit = (value: unknown, human: string): void => {
    io.out(json ? JSON.stringify(value, null, 2) + '\n' : human + '\n');
  };

  try {
    switch (args.command) {
      case 'install': {
        const [model, version] = splitTarget(args.target, false);
        const backend = flag('--backend') ?? 'onnx';
        if (!(LAYA_BACKENDS as readonly string[]).includes(backend)) {
          throw new LayaInstallError('usage', `unknown backend ${backend}`);
        }
        const manifest = await loadManifest(flag('--manifest') ?? shippedManifestPath());
        const onProgress: ProgressFn | undefined =
          io.isTTY && !json
            ? (file, done, total): void =>
                io.err(`\r${file}: ${Math.floor((done / total) * 100)}% of ${mb(total)}`)
            : undefined;
        const res = await installModel({
          manifest,
          model,
          ...(version !== undefined ? { version } : {}),
          backend: backend as LayaBackend,
          root,
          force: args.flags.has('--force'),
          allowUnpublished: args.flags.has('--allow-unpublished'),
          ...(onProgress ? { onProgress } : {}),
        });
        if (onProgress) io.err('\n');
        emit(
          { ok: true, ...res },
          `Installed ${res.model}@${res.version} (${res.backend}) in ${res.dir}`
        );
        return 0;
      }
      case 'verify': {
        const [model, version] = splitTarget(args.target, true);
        const res = await verifyInstall({ root, model, version: version! });
        emit(
          res,
          res.ok
            ? `${model}@${version}: ok`
            : `${model}@${version}: BROKEN\n  ${res.problems.join('\n  ')}`
        );
        return res.ok ? 0 : 1;
      }
      case 'list': {
        const installs = await listInstalls(root);
        emit(
          installs,
          installs.length === 0
            ? `No Laya models installed in ${root}`
            : installs.map((i) => `${i.model}@${i.version} (${i.backend})`).join('\n')
        );
        return 0;
      }
      case 'remove': {
        const [model, version] = splitTarget(args.target, true);
        const dir = await removeInstall({ root, model, version: version! });
        emit({ ok: true, removed: dir }, `Removed ${dir}`);
        return 0;
      }
      case 'models': {
        const manifest = await loadManifest(flag('--manifest') ?? shippedManifestPath());
        const problems = validateManifest(manifest);
        if (problems.length > 0) {
          throw new LayaInstallError('manifest', `invalid manifest:\n  ${problems.join('\n  ')}`);
        }
        const offer = manifest.models.map((m) => ({
          model: m.model,
          version: m.version,
          tag: m.tag,
          published: m.published,
          backends: Object.fromEntries(
            Object.entries(m.backends).map(([b, set]) => [
              b,
              { files: set.files.length, bytes: set.files.reduce((n, f) => n + f.bytes, 0) },
            ])
          ),
        }));
        emit(
          offer,
          offer
            .map(
              (o) =>
                `${o.model}@${o.version}${o.published ? '' : ' (not published yet)'}: ` +
                Object.entries(o.backends)
                  .map(([b, s]) => `${b} ${mb(s.bytes)}`)
                  .join(', ')
            )
            .join('\n')
        );
        return 0;
      }
      default:
        throw new LayaInstallError('usage', `unknown command ${args.command}`);
    }
  } catch (err) {
    if (err instanceof LayaInstallError && err.code === 'usage') {
      io.err(`pi-laya-model: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    const code = err instanceof LayaInstallError ? err.code : 'internal';
    if (json) io.out(JSON.stringify({ ok: false, code, error: messageOf(err) }, null, 2) + '\n');
    else io.err(`pi-laya-model: ${messageOf(err)}\n`);
    return 1;
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
