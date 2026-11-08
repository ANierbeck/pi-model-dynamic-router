// test/laya-sidecar-identity.test.ts
//
// The sidecar half of the GET /health contract (plan
// 2026-11-08-laya-model-artifact.md, Solution 5): spikes/laya-http/identity.py
// builds the payload server.py serves. The two hashes in it are computed in
// Python and compared by the router in TypeScript, so this file pins them
// byte for byte against the TypeScript implementations, and feeds the real
// Python payload through the router's own /health parser.
//
// identity.py is stdlib-only on purpose: these tests run it with the system
// python3 (CI's ubuntu image ships one) without the MLX venv server.py needs.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { artifactSha256, headSha256, INSTALL_RECORD } from '../src/laya-model-manifest.ts';
import { fetchLayaHealth } from '../src/laya-classifier.ts';
import { LAYA_HEAD_V2_INSTRUCTIONS, VALID_CATEGORIES } from '../src/classification-prompt.ts';

const SCRIPT = path.resolve(__dirname, '../spikes/laya-http/identity.py');
const HEX = (c: string) => c.repeat(64);

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-identity-'));
  tmpDirs.push(d);
  return d;
}

/** Runs identity.py; `-I` so nothing from the cwd or user site can shadow a module. */
function py(...args: string[]): any {
  return JSON.parse(execFileSync('python3', ['-I', SCRIPT, ...args], { encoding: 'utf8' }));
}

const routerHead = { instructions: LAYA_HEAD_V2_INSTRUCTIONS, categories: [...VALID_CATEGORIES] };

/** A head whose JSON encoding exercises every escaping rule both encoders must agree on. */
const trickyHead = {
  instructions:
    'Quote " backslash \\ newline \n tab \t ctrl \u0001 umlaut ä emoji 😀 line-sep \u2028 del \u007f',
  categories: ['a"b', 'ü', 'plain'],
};

function writeHeadJson(dir: string, head: { instructions: string; categories: string[] }): string {
  const p = path.join(dir, 'head.json');
  fs.writeFileSync(p, JSON.stringify(head));
  return p;
}

const files = [
  { path: 'tokenizer.json', asset: 't', bytes: 3, sha256: HEX('c') },
  { path: 'encoder.onnx', asset: 'e', bytes: 5, sha256: HEX('a') },
  { path: 'head.json', asset: 'h', bytes: 9, sha256: HEX('b') },
];

function installDir(
  head: { instructions: string; categories: string[] },
  format: 'head-json' | 'laya-questions' = 'head-json',
  record: Record<string, unknown> = {}
): string {
  const dir = tmp();
  const headPath = format === 'head-json' ? 'head.json' : 'questions.json';
  fs.writeFileSync(
    path.join(dir, headPath),
    JSON.stringify(
      format === 'head-json'
        ? head
        : {
            category: {
              type: 'choice',
              instructions: head.instructions,
              criteria: head.categories,
            },
          }
    )
  );
  fs.writeFileSync(
    path.join(dir, INSTALL_RECORD),
    JSON.stringify({
      schema_version: 1,
      model: 'r2',
      version: '1.0.0',
      tag: 'laya-r2-v1.0.0',
      backend: 'onnx',
      head: { sha256: headSha256(head), categories: head.categories },
      head_file: { path: headPath, format },
      files,
      installed_at: '2026-11-08T00:00:00.000Z',
      ...record,
    })
  );
  return dir;
}

describe('hash parity: Python computes what TypeScript computes', () => {
  it.each([
    ['the router head', routerHead],
    ['a head with every JSON escaping case', trickyHead],
  ])('head_sha256 of %s', (_name, head) => {
    const out = py('--head-json', writeHeadJson(tmp(), head));
    expect(out.head_sha256).toBe(headSha256(head));
  });

  it('artifact_sha256 of an unsorted install record', () => {
    const out = py('--model-dir', installDir(routerHead));
    expect(out.artifact_sha256).toBe(artifactSha256(files));
  });
});

describe('the /health payload', () => {
  it('an installed model reports model, version, backend and both hashes', () => {
    expect(py('--model-dir', installDir(routerHead))).toEqual({
      status: 'ok',
      model: 'r2',
      version: '1.0.0',
      backend: 'onnx',
      artifact_sha256: artifactSha256(files),
      head_sha256: headSha256(routerHead),
      served_head: 'record',
    });
  });

  it.each([['head-json' as const], ['laya-questions' as const]])(
    'without --head-json an install serves the head its record names (%s)',
    (format) => {
      const out = py('--model-dir', installDir(trickyHead, format));
      expect(out.head_sha256).toBe(headSha256(trickyHead));
      expect(out.served_head).toBe('record');
    }
  );

  it('--head-json overrides the record head — and the hash says what is served', () => {
    const out = py(
      '--model-dir',
      installDir(routerHead),
      '--head-json',
      writeHeadJson(tmp(), trickyHead)
    );
    expect(out.head_sha256).toBe(headSha256(trickyHead));
    expect(out.served_head).toBe('head-json');
  });

  it('a model dir without an install record reports the head only', () => {
    const out = py('--model-dir', tmp(), '--head-json', writeHeadJson(tmp(), routerHead));
    expect(out).toEqual({
      status: 'ok',
      head_sha256: headSha256(routerHead),
      served_head: 'head-json',
    });
  });

  it('nothing at all: no identity, no head (server.py then uses the production prompt)', () => {
    expect(py()).toEqual({ status: 'ok' });
  });

  it.each([
    ['an unreadable record', 'not json'],
    ['a record without files', JSON.stringify({ schema_version: 1, model: 'r2', version: '1' })],
  ])('%s yields no identity, never a crash', (_name, text) => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, INSTALL_RECORD), text);
    expect(py('--model-dir', dir)).toEqual({ status: 'ok' });
  });

  it('a complete record of another schema version is not read (neither identity nor head)', () => {
    expect(py('--model-dir', installDir(routerHead, 'head-json', { schema_version: 2 }))).toEqual({
      status: 'ok',
    });
  });

  it('a record whose head file is missing reports the identity but no served head', () => {
    const dir = installDir(routerHead);
    fs.rmSync(path.join(dir, 'head.json'));
    const out = py('--model-dir', dir);
    expect(out).toMatchObject({ model: 'r2', version: '1.0.0' });
    expect(out.head_sha256).toBeUndefined();
  });
});

describe('end to end: the router parses what the sidecar serves', () => {
  let server: http.Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });

  it('every identity field survives the router-side validation', async () => {
    const payload = py('--model-dir', installDir(routerHead));
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    expect(await fetchLayaHealth(`http://127.0.0.1:${port}`, 1000)).toEqual({
      ok: true,
      identity: {
        model: 'r2',
        version: '1.0.0',
        backend: 'onnx',
        artifact_sha256: artifactSha256(files),
        head_sha256: headSha256(routerHead),
      },
    });
  });
});
