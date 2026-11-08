// test/laya-model-install.test.ts
//
// pi-laya-model: install / verify / list / remove of a Laya model artifact
// (plan 2026-11-08-laya-model-artifact.md, Solution 3 and 4).
//
// Every case runs against a small local "release" — file:// for the plain
// paths, a loopback HTTP server where Range and broken connections matter —
// so nothing here touches the network or the real install root.
//
// Promises under test:
//  - atomic: a failed checksum leaves NOTHING behind (no version dir, no .tmp);
//  - resumable: an interrupted download keeps its partial file and the next
//    run continues it with a Range request instead of starting over;
//  - verifiable: `verify` catches a corrupted, truncated or missing file and a
//    head that does not hash to what the manifest claims.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LAYA_HEAD_V2_INSTRUCTIONS, VALID_CATEGORIES } from '../src/classification-prompt.ts';
import { artifactSha256, headSha256, type LayaManifest } from '../src/laya-model-manifest.ts';
import {
  defaultModelsRoot,
  installModel,
  LayaInstallError,
  listInstalls,
  main,
  removeInstall,
  verifyInstall,
} from '../src/laya-model-install.ts';
import { rmTmpDir } from './helpers/router-env.ts';

const codeHead = { instructions: LAYA_HEAD_V2_INSTRUCTIONS, categories: [...VALID_CATEGORIES] };
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let tmp: string;
let releaseDir: string;
let root: string;

/** The release payload: a head, a "weights" file big enough to cut in the middle, a nested file. */
const PAYLOAD: { path: string; asset: string; content: Buffer }[] = [
  { path: 'head.json', asset: 'head.json', content: Buffer.from(JSON.stringify(codeHead)) },
  {
    path: 'model.onnx.data',
    asset: 'model.onnx.data',
    content: Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => (i * 31) % 251)),
  },
  { path: 'tokenizer/tokenizer.json', asset: 'tokenizer.json', content: Buffer.from('{"t":1}') },
];

function manifestFor(baseUrl: string, overrides: Record<string, unknown> = {}): LayaManifest {
  return {
    schema_version: 1,
    models: [
      {
        model: 'r9',
        version: '1.0.0',
        tag: 'laya-r9-v1.0.0',
        published: true,
        base_url: baseUrl,
        head: { sha256: headSha256(codeHead), categories: [...VALID_CATEGORIES] },
        backends: {
          onnx: {
            head_file: { path: 'head.json', format: 'head-json' },
            files: PAYLOAD.map((f) => ({
              path: f.path,
              asset: f.asset,
              bytes: f.content.length,
              sha256: sha(f.content),
            })),
          },
        },
        ...overrides,
      },
    ],
  } as LayaManifest;
}

const fileBase = () => pathToFileURL(releaseDir).href + '/';
const versionDir = () => path.join(root, 'r9', '1.0.0');
const leftovers = () =>
  fs.existsSync(path.join(root, 'r9')) ? fs.readdirSync(path.join(root, 'r9')) : [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-install-'));
  releaseDir = path.join(tmp, 'release');
  root = path.join(tmp, 'models');
  fs.mkdirSync(releaseDir, { recursive: true });
  for (const f of PAYLOAD) fs.writeFileSync(path.join(releaseDir, f.asset), f.content);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmTmpDir(tmp);
});

describe('install from a file:// release', () => {
  it('installs every file, writes the install record, leaves no temp dir', async () => {
    const res = await installModel({ manifest: manifestFor(fileBase()), model: 'r9', root });
    expect(res.dir).toBe(versionDir());
    expect(res.backend).toBe('onnx');
    for (const f of PAYLOAD) {
      expect(fs.readFileSync(path.join(versionDir(), f.path)).equals(f.content)).toBe(true);
    }
    const record = JSON.parse(fs.readFileSync(path.join(versionDir(), 'manifest.json'), 'utf8'));
    expect(record).toMatchObject({ model: 'r9', version: '1.0.0', backend: 'onnx' });
    expect(record.head.sha256).toBe(headSha256(codeHead));
    expect(leftovers()).toEqual(['1.0.0']);
  });

  it('picks the highest version when none is named', async () => {
    const m = manifestFor(fileBase());
    m.models.push({ ...m.models[0]!, version: '1.10.0' }, { ...m.models[0]!, version: '1.9.0' });
    const res = await installModel({ manifest: m, model: 'r9', root });
    expect(res.version).toBe('1.10.0');
  });

  it('without a version, an unpublished newer version does not hide the published one', async () => {
    const m = manifestFor(fileBase());
    m.models.push({ ...m.models[0]!, version: '1.1.0', published: false });
    expect((await installModel({ manifest: m, model: 'r9', root })).version).toBe('1.0.0');
    // Asking for unpublished versions makes the newest one the default again.
    const res = await installModel({
      manifest: m,
      model: 'r9',
      root: path.join(tmp, 'b'),
      allowUnpublished: true,
    });
    expect(res.version).toBe('1.1.0');
  });

  it('a checksum mismatch aborts and leaves nothing behind', async () => {
    fs.writeFileSync(path.join(releaseDir, 'model.onnx.data'), Buffer.alloc(256 * 1024, 7));
    const err = await installModel({ manifest: manifestFor(fileBase()), model: 'r9', root }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(LayaInstallError);
    expect(err.code).toBe('checksum');
    expect(err.message).toContain('model.onnx.data');
    expect(fs.existsSync(versionDir())).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('a file of the wrong size is reported by size, before hashing', async () => {
    fs.writeFileSync(path.join(releaseDir, 'tokenizer.json'), '{"t":12}');
    const err = await installModel({ manifest: manifestFor(fileBase()), model: 'r9', root }).catch(
      (e) => e
    );
    expect(err.code).toBe('checksum');
    expect(err.message).toContain('8 bytes, the manifest says 7');
    expect(leftovers()).toEqual([]);
  });

  it('a head that does not hash to the manifest claim aborts and leaves nothing behind', async () => {
    const m = manifestFor(fileBase());
    m.models[0]!.head.sha256 = 'f'.repeat(64);
    const err = await installModel({ manifest: m, model: 'r9', root }).catch((e) => e);
    expect(err.code).toBe('head');
    expect(leftovers()).toEqual([]);
  });

  it('refuses an unpublished version unless asked to', async () => {
    const m = manifestFor(fileBase(), { published: false });
    const err = await installModel({ manifest: m, model: 'r9', root }).catch((e) => e);
    expect(err.code).toBe('unpublished');
    expect(fs.existsSync(root)).toBe(false);
    await installModel({ manifest: m, model: 'r9', root, allowUnpublished: true });
    expect(fs.existsSync(versionDir())).toBe(true);
  });

  it('refuses an unknown model, version or backend', async () => {
    const m = manifestFor(fileBase());
    expect((await installModel({ manifest: m, model: 'nope', root }).catch((e) => e)).code).toBe(
      'not-found'
    );
    expect(
      (await installModel({ manifest: m, model: 'r9', version: '9.9.9', root }).catch((e) => e))
        .code
    ).toBe('not-found');
    expect(
      (await installModel({ manifest: m, model: 'r9', backend: 'mlx', root }).catch((e) => e)).code
    ).toBe('not-found');
  });

  it('refuses an invalid manifest before touching the disk', async () => {
    const m = manifestFor(fileBase());
    m.models[0]!.backends.onnx!.files[1]!.path = '../escape';
    const err = await installModel({ manifest: m, model: 'r9', root }).catch((e) => e);
    expect(err.code).toBe('manifest');
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'escape'))).toBe(false);
  });

  it('checks free space before downloading anything', async () => {
    const err = await installModel({
      manifest: manifestFor(fileBase()),
      model: 'r9',
      root,
      freeBytes: () => 1000,
    }).catch((e) => e);
    expect(err.code).toBe('disk');
    expect(leftovers()).toEqual([]);
  });

  it('does not overwrite an existing install unless forced', async () => {
    const m = manifestFor(fileBase());
    await installModel({ manifest: m, model: 'r9', root });
    expect((await installModel({ manifest: m, model: 'r9', root }).catch((e) => e)).code).toBe(
      'exists'
    );
    fs.writeFileSync(path.join(versionDir(), 'head.json'), 'tampered');
    await installModel({ manifest: m, model: 'r9', root, force: true });
    expect((await verifyInstall({ root, model: 'r9', version: '1.0.0' })).ok).toBe(true);
    expect(leftovers()).toEqual(['1.0.0']);
  });
});

describe('install over HTTP: resume and Range', () => {
  let server: http.Server;
  let base = '';
  let requests: { asset: string; range: string | undefined; served: number }[] = [];
  /** Asset → byte count after which the connection is cut (once). */
  let cutAfter: Record<string, number> = {};
  let ignoreRange = false;
  /** Answer a Range request with 206 for a DIFFERENT start than asked (a broken proxy). */
  let wrongRange = false;

  beforeEach(async () => {
    requests = [];
    cutAfter = {};
    ignoreRange = false;
    wrongRange = false;
    server = http.createServer((req, res) => {
      const asset = decodeURIComponent((req.url ?? '').replace(/^\/rel\//, ''));
      const file = path.join(releaseDir, asset);
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = fs.readFileSync(file);
      const range = req.headers.range;
      const m = /^bytes=(\d+)-$/.exec(range ?? '');
      const asked = m && !ignoreRange ? Number(m[1]) : 0;
      const start = wrongRange && asked > 0 ? asked - 1 : asked;
      const slice = body.subarray(start);
      const entry = { asset, range, served: 0 };
      requests.push(entry);
      res.writeHead(start > 0 ? 206 : 200, {
        'content-length': String(slice.length),
        ...(start > 0
          ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` }
          : {}),
      });
      const cut = cutAfter[asset];
      if (cut !== undefined) {
        delete cutAfter[asset];
        entry.served = cut;
        res.write(slice.subarray(0, cut), () => setTimeout(() => res.destroy(), 20));
        return;
      }
      entry.served = slice.length;
      res.end(slice);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/rel/`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('installs over loopback http', async () => {
    await installModel({ manifest: manifestFor(base), model: 'r9', root });
    expect((await verifyInstall({ root, model: 'r9', version: '1.0.0' })).ok).toBe(true);
  });

  it('an interrupted download keeps its partial file; the next run resumes with Range', async () => {
    const big = PAYLOAD[1]!;
    cutAfter = { [big.asset]: 100 * 1024 };
    const first = await installModel({ manifest: manifestFor(base), model: 'r9', root }).catch(
      (e) => e
    );
    expect(first).toBeInstanceOf(LayaInstallError);
    expect(first.code).toBe('download');
    expect(fs.existsSync(versionDir())).toBe(false);
    expect(leftovers()).toEqual(['1.0.0.tmp']); // kept on purpose: it is the resume point

    requests = [];
    const res = await installModel({ manifest: manifestFor(base), model: 'r9', root });
    const again = requests.filter((r) => r.asset === big.asset);
    expect(again).toHaveLength(1);
    const offset = Number(/^bytes=(\d+)-$/.exec(again[0]!.range ?? '')?.[1]);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThanOrEqual(100 * 1024);
    expect(again[0]!.served).toBe(big.content.length - offset); // only the rest, not the whole file
    expect(res.resumed).toContain(big.path);
    // Files that were complete after the first run are not fetched again.
    expect(requests.map((r) => r.asset)).not.toContain(PAYLOAD[0]!.asset);
    expect((await verifyInstall({ root, model: 'r9', version: '1.0.0' })).ok).toBe(true);
    expect(leftovers()).toEqual(['1.0.0']);
  });

  it('a server that ignores Range (200 instead of 206) still yields a correct install', async () => {
    const big = PAYLOAD[1]!;
    cutAfter = { [big.asset]: 100 * 1024 };
    await installModel({ manifest: manifestFor(base), model: 'r9', root }).catch(() => {});
    ignoreRange = true;
    await installModel({ manifest: manifestFor(base), model: 'r9', root });
    expect(
      fs.readFileSync(path.join(versionDir(), big.path)).equals(big.content),
      'a 200 on a resume must replace the partial file, not be appended to it'
    ).toBe(true);
  });

  it('a 206 for a different range drops the partial file, so the next run starts clean', async () => {
    const big = PAYLOAD[1]!;
    cutAfter = { [big.asset]: 100 * 1024 };
    await installModel({ manifest: manifestFor(base), model: 'r9', root }).catch(() => {});
    wrongRange = true;
    const err = await installModel({ manifest: manifestFor(base), model: 'r9', root }).catch(
      (e) => e
    );
    expect(err.code).toBe('download');
    expect(err.message).toContain('range');
    wrongRange = false;
    requests = [];
    await installModel({ manifest: manifestFor(base), model: 'r9', root });
    const again = requests.filter((r) => r.asset === big.asset);
    expect(again[0]!.range, 'the partial was dropped: no Range on the retry').toBeUndefined();
    expect((await verifyInstall({ root, model: 'r9', version: '1.0.0' })).ok).toBe(true);
  });

  it('an HTTP error is a download error and keeps the resume point', async () => {
    const m = manifestFor(base);
    m.models[0]!.backends.onnx!.files[2]!.asset = 'missing.json';
    const err = await installModel({ manifest: m, model: 'r9', root }).catch((e) => e);
    expect(err.code).toBe('download');
    expect(err.message).toContain('404');
    expect(leftovers()).toEqual(['1.0.0.tmp']);
  });
});

describe('verify / list / remove', () => {
  beforeEach(async () => {
    await installModel({ manifest: manifestFor(fileBase()), model: 'r9', root });
  });

  it('a fresh install verifies', async () => {
    expect(await verifyInstall({ root, model: 'r9', version: '1.0.0' })).toEqual({
      ok: true,
      problems: [],
    });
  });

  it.each([
    ['a flipped byte', (p: string) => fs.writeFileSync(p, Buffer.alloc(256 * 1024, 1))],
    ['a truncated file', (p: string) => fs.truncateSync(p, 10)],
    ['a missing file', (p: string) => fs.rmSync(p)],
  ])('detects %s', async (_name, damage) => {
    damage(path.join(versionDir(), 'model.onnx.data'));
    const res = await verifyInstall({ root, model: 'r9', version: '1.0.0' });
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toContain('model.onnx.data');
  });

  it('detects a head that no longer hashes to the recorded claim', async () => {
    // Head file rewritten AND its file hash in the record adjusted: only the
    // head check can catch this one.
    const headPath = path.join(versionDir(), 'head.json');
    const drifted = Buffer.from(JSON.stringify({ ...codeHead, instructions: 'other' }));
    fs.writeFileSync(headPath, drifted);
    const recPath = path.join(versionDir(), 'manifest.json');
    const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
    const entry = rec.files.find((f: any) => f.path === 'head.json');
    entry.sha256 = sha(drifted);
    entry.bytes = drifted.length;
    fs.writeFileSync(recPath, JSON.stringify(rec));
    const res = await verifyInstall({ root, model: 'r9', version: '1.0.0' });
    expect(res.ok).toBe(false);
    expect(res.problems.join('\n')).toContain('head');
  });

  it('an install without a record is reported, not crashed on', async () => {
    fs.rmSync(path.join(versionDir(), 'manifest.json'));
    const res = await verifyInstall({ root, model: 'r9', version: '1.0.0' });
    expect(res.ok).toBe(false);
  });

  it('list shows installs and skips temp dirs', async () => {
    // A crash between writing the record and the final rename leaves a temp
    // dir WITH a record — it is still not an install.
    const crashed = path.join(root, 'r9', '2.0.0.tmp');
    fs.mkdirSync(crashed, { recursive: true });
    fs.copyFileSync(path.join(versionDir(), 'manifest.json'), path.join(crashed, 'manifest.json'));
    expect(await listInstalls(root)).toEqual([{ model: 'r9', version: '1.0.0', backend: 'onnx' }]);
    expect(await listInstalls(path.join(tmp, 'does-not-exist'))).toEqual([]);
  });

  it('remove deletes the version dir', async () => {
    await removeInstall({ root, model: 'r9', version: '1.0.0' });
    expect(fs.existsSync(versionDir())).toBe(false);
    expect(await listInstalls(root)).toEqual([]);
  });

  it('remove refuses names that would leave the install root', async () => {
    const outside = path.join(tmp, 'keep');
    fs.mkdirSync(outside);
    for (const [model, version] of [
      ['..', 'keep'],
      ['r9', '../../keep'],
      ['r9', ''],
    ]) {
      const err = await removeInstall({ root, model: model!, version: version! }).catch((e) => e);
      expect(err).toBeInstanceOf(LayaInstallError);
      expect(err.code).toBe('usage');
    }
    expect(fs.existsSync(outside)).toBe(true);
  });
});

describe('install root', () => {
  it('defaults to <Pi agent dir>/laya-models and follows PI_CODING_AGENT_DIR', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', path.join(tmp, 'agent'));
    expect(defaultModelsRoot()).toBe(path.join(tmp, 'agent', 'laya-models'));
    vi.stubEnv('PI_CODING_AGENT_DIR', '');
    expect(defaultModelsRoot()).toBe(path.join(os.homedir(), '.pi', 'agent', 'laya-models'));
  });
});

describe('the pi-laya-model command line', () => {
  let out: string[];
  let err: string[];
  const io = () => ({ out: (s: string) => out.push(s), err: (s: string) => err.push(s) });
  let manifestPath: string;

  beforeEach(() => {
    out = [];
    err = [];
    manifestPath = path.join(tmp, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifestFor(fileBase())));
  });

  const run = (...argv: string[]) => main(argv, io());

  it('install → list → verify → remove, all with --json', async () => {
    expect(
      await run('install', 'r9@1.0.0', '--manifest', manifestPath, '--root', root, '--json')
    ).toBe(0);
    const installed = JSON.parse(out.join(''));
    expect(installed).toMatchObject({ ok: true, dir: versionDir() });
    // The skill compares this with the artifact_sha256 the sidecar reports on /health.
    expect(installed.artifact_sha256).toBe(
      artifactSha256(manifestFor(fileBase()).models[0]!.backends.onnx!.files)
    );

    out = [];
    expect(await run('list', '--root', root, '--json')).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual([{ model: 'r9', version: '1.0.0', backend: 'onnx' }]);

    out = [];
    expect(await run('verify', 'r9@1.0.0', '--root', root, '--json')).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ ok: true, problems: [] });

    fs.truncateSync(path.join(versionDir(), 'model.onnx.data'), 1);
    out = [];
    expect(await run('verify', 'r9@1.0.0', '--root', root, '--json')).toBe(1);
    expect(JSON.parse(out.join('')).ok).toBe(false);

    out = [];
    expect(await run('remove', 'r9@1.0.0', '--root', root, '--json')).toBe(0);
    expect(fs.existsSync(versionDir())).toBe(false);
  });

  it('a failed install exits 1 and reports the error code as JSON', async () => {
    fs.writeFileSync(path.join(releaseDir, 'tokenizer.json'), 'changed');
    expect(await run('install', 'r9', '--manifest', manifestPath, '--root', root, '--json')).toBe(
      1
    );
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: false, code: 'checksum' });
  });

  it('models lists what the manifest offers (the skill reads sizes from here)', async () => {
    expect(await run('models', '--manifest', manifestPath, '--json')).toBe(0);
    const [entry] = JSON.parse(out.join(''));
    expect(entry).toMatchObject({ model: 'r9', version: '1.0.0', published: true });
    expect(entry.backends.onnx.bytes).toBe(PAYLOAD.reduce((n, f) => n + f.content.length, 0));
    expect(entry.backends.onnx.artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [[]],
    [['frobnicate']],
    [['install']],
    [['verify', 'r9']],
    [['install', 'r9', '--backend']],
  ])('usage errors exit 2: %j', async (argv) => {
    expect(await main(argv as string[], io())).toBe(2);
    expect(err.join('')).toContain('Usage');
  });

  it('human output names the install dir', async () => {
    expect(await run('install', 'r9', '--manifest', manifestPath, '--root', root)).toBe(0);
    expect(out.join('')).toContain(versionDir());
  });
});
