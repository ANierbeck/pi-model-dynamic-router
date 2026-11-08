// test/laya-model-manifest.test.ts
//
// The shipped Laya model manifest (laya-models/manifest.json) and the head
// parity gate (plan 2026-11-08-laya-model-artifact.md, Solution 1 and 6).
//
// The head is the task definition the model was trained on. The router builds
// it from LAYA_HEAD_V2_INSTRUCTIONS + VALID_CATEGORIES; the sidecar serves the
// copy inside the artifact. If the two drift, every measurement afterwards
// measures prompt drift instead of the model — so a router release may only
// ship a manifest whose heads hash to exactly what the code builds.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAYA_HEAD_V2_INSTRUCTIONS, VALID_CATEGORIES } from '../src/classification-prompt.ts';
import { createHash } from 'node:crypto';
import {
  artifactSha256,
  checkHeadParity,
  headFromFile,
  headSha256,
  validateManifest,
  type LayaManifest,
} from '../src/laya-model-manifest.ts';

const shipped = JSON.parse(
  readFileSync(join(__dirname, '..', 'laya-models', 'manifest.json'), 'utf8')
) as LayaManifest;
const codeHead = { instructions: LAYA_HEAD_V2_INSTRUCTIONS, categories: [...VALID_CATEGORIES] };

const HEX = (c: string) => c.repeat(64);

/** A minimal valid manifest; tests break exactly one rule each. */
function fixture(): any {
  return {
    schema_version: 1,
    models: [
      {
        model: 'r9',
        version: '1.0.0',
        tag: 'laya-r9-v1.0.0',
        published: true,
        base_url: 'https://example.invalid/releases/download/laya-r9-v1.0.0/',
        head: { sha256: headSha256(codeHead), categories: [...VALID_CATEGORIES] },
        backends: {
          onnx: {
            head_file: { path: 'head.json', format: 'head-json' },
            files: [
              { path: 'head.json', asset: 'r9-head.json', bytes: 10, sha256: HEX('a') },
              { path: 'model.onnx', asset: 'r9-model.onnx', bytes: 20, sha256: HEX('b') },
            ],
          },
        },
      },
    ],
  };
}

describe('the shipped manifest', () => {
  it('passes validation', () => {
    expect(validateManifest(shipped)).toEqual([]);
  });

  it('every shipped model was trained on the head the code builds (parity gate)', () => {
    expect(shipped.models.length).toBeGreaterThan(0);
    expect(checkHeadParity(shipped, codeHead)).toEqual([]);
  });

  it('the r2 artifact head hash is pinned: code canonicalisation = the bytes in the artifact', () => {
    // 5f12…: sha256 of r2's head.json, written from the checkpoint's own
    // questions.json by the export (compact JSON, keys instructions, categories).
    // A different canonical form in the code would make every /health
    // head_sha256 comparison fail, so the form is pinned against the real bytes.
    expect(headSha256(codeHead)).toBe(
      '5f12495d95d8743a277aa668ad0c8d756f2de1e76b82d80a85b65067e2900883'
    );
  });

  it('ships the default backend (onnx) for every model', () => {
    for (const m of shipped.models) expect(Object.keys(m.backends)).toContain('onnx');
  });
});

describe('head parity gate', () => {
  it('reports a model whose head drifted by a single character', () => {
    const drifted = fixture();
    drifted.models[0].head.sha256 = headSha256({
      ...codeHead,
      instructions: codeHead.instructions.replace('exactly one', 'exactly  one'),
    });
    const problems = checkHeadParity(drifted, codeHead);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('r9@1.0.0');
  });

  it('reports a model whose category order differs (choice index → category by position)', () => {
    const reordered = fixture();
    const cats = [...VALID_CATEGORIES].reverse();
    reordered.models[0].head = {
      sha256: headSha256({ ...codeHead, categories: cats }),
      categories: cats,
    };
    expect(checkHeadParity(reordered, codeHead)).toHaveLength(1);
  });

  it('reports a head whose listed categories disagree with its own hash input', () => {
    const lying = fixture();
    lying.models[0].head.categories = ['simple'];
    expect(checkHeadParity(lying, codeHead)).toHaveLength(1);
  });
});

describe('manifest validation', () => {
  const errorsFor = (mutate: (m: any) => void): string[] => {
    const m = fixture();
    mutate(m);
    return validateManifest(m);
  };

  it('the fixture itself is valid (guards every case below against vacuity)', () => {
    expect(validateManifest(fixture())).toEqual([]);
  });

  it.each([
    ['a missing sha256', (m: any) => delete m.models[0].backends.onnx.files[0].sha256, 'sha256'],
    [
      'an upper-case or short sha256',
      (m: any) => (m.models[0].backends.onnx.files[0].sha256 = 'ABC'),
      'sha256',
    ],
    [
      'a duplicate file path',
      (m: any) => (m.models[0].backends.onnx.files[1].path = 'head.json'),
      'duplicate',
    ],
    [
      'a duplicate that differs only in case (case-insensitive file systems)',
      (m: any) => (m.models[0].backends.onnx.files[1].path = 'HEAD.json'),
      'duplicate',
    ],
    ['an unknown backend', (m: any) => (m.models[0].backends.cuda = { files: [] }), 'backend'],
    ['no backend at all', (m: any) => (m.models[0].backends = {}), 'backend'],
    [
      'a path escaping the install directory',
      (m: any) => (m.models[0].backends.onnx.files[1].path = '../evil.onnx'),
      'path',
    ],
    [
      'an absolute path',
      (m: any) => (m.models[0].backends.onnx.files[1].path = '/etc/evil'),
      'path',
    ],
    [
      'a Windows-style path',
      (m: any) => (m.models[0].backends.onnx.files[1].path = 'sub\\evil'),
      'path',
    ],
    [
      'the reserved install-record name',
      (m: any) => (m.models[0].backends.onnx.files[1].path = 'manifest.json'),
      'reserved',
    ],
    [
      'an asset name with a slash',
      (m: any) => (m.models[0].backends.onnx.files[1].asset = 'a/b'),
      'asset',
    ],
    [
      'one asset name carrying two different files',
      (m: any) => (m.models[0].backends.onnx.files[1].asset = 'r9-head.json'),
      'asset',
    ],
    ['zero bytes', (m: any) => (m.models[0].backends.onnx.files[1].bytes = 0), 'bytes'],
    ['fractional bytes', (m: any) => (m.models[0].backends.onnx.files[1].bytes = 1.5), 'bytes'],
    [
      'a head file that is not one of the files',
      (m: any) => (m.models[0].backends.onnx.head_file.path = 'nope.json'),
      'head_file',
    ],
    [
      'an unknown head file format',
      (m: any) => (m.models[0].backends.onnx.head_file.format = 'yaml'),
      'head_file',
    ],
    ['a missing head hash', (m: any) => delete m.models[0].head.sha256, 'head'],
    [
      'plain http to a remote host',
      (m: any) => (m.models[0].base_url = 'http://example.com/x/'),
      'base_url',
    ],
    [
      'a base_url without a trailing slash',
      (m: any) => (m.models[0].base_url = 'https://example.invalid/x'),
      'base_url',
    ],
    ['an unsafe model name', (m: any) => (m.models[0].model = '../r9'), 'model'],
    ['an unsafe version', (m: any) => (m.models[0].version = '1/0'), 'version'],
    ['a duplicate model@version', (m: any) => m.models.push(m.models[0]), 'duplicate'],
    ['an unknown schema_version', (m: any) => (m.schema_version = 2), 'schema_version'],
    ['a non-boolean published flag', (m: any) => (m.models[0].published = 'yes'), 'published'],
  ])('rejects %s', (_name, mutate, needle) => {
    const errors = errorsFor(mutate);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain(needle);
  });

  it('accepts file:// and loopback http base URLs (local testing with --manifest)', () => {
    expect(errorsFor((m) => (m.models[0].base_url = 'file:///tmp/rel/'))).toEqual([]);
    expect(errorsFor((m) => (m.models[0].base_url = 'http://127.0.0.1:9/rel/'))).toEqual([]);
  });

  it('allows the same asset in two backends when it is the same file', () => {
    expect(
      errorsFor((m) => {
        m.models[0].backends.mlx = {
          head_file: { path: 'questions.json', format: 'laya-questions' },
          files: [
            { path: 'questions.json', asset: 'r9-questions.json', bytes: 5, sha256: HEX('c') },
            { ...m.models[0].backends.onnx.files[1], path: 'sub/model.onnx' },
          ],
        };
      })
    ).toEqual([]);
  });

  it('never throws on garbage, it reports', () => {
    for (const garbage of [null, 42, 'x', [], { models: 'x' }, { schema_version: 1 }]) {
      expect(validateManifest(garbage).length).toBeGreaterThan(0);
    }
  });
});

describe('head files', () => {
  it('reads the head-json format', () => {
    const text = JSON.stringify(codeHead);
    expect(headFromFile('head-json', text)).toEqual(codeHead);
  });

  it('reads the laya-questions format of a training checkpoint', () => {
    const text = JSON.stringify({
      category: {
        type: 'choice',
        instructions: codeHead.instructions,
        criteria: codeHead.categories,
      },
    });
    expect(headFromFile('laya-questions', text)).toEqual(codeHead);
  });

  it('formatting does not change the hash (pretty-printed head = compact head)', () => {
    const pretty = headFromFile('head-json', JSON.stringify(codeHead, null, 2));
    expect(headSha256(pretty!)).toBe(headSha256(codeHead));
  });

  it('returns null for an unreadable head instead of throwing', () => {
    expect(headFromFile('head-json', 'not json')).toBeNull();
    expect(headFromFile('laya-questions', '{"category":{}}')).toBeNull();
  });
});

describe('artifact fingerprint (what /health reports as artifact_sha256)', () => {
  const files = [
    { path: 'b.onnx', asset: 'b', bytes: 2, sha256: HEX('b') },
    { path: 'a/x.json', asset: 'x', bytes: 1, sha256: HEX('a') },
  ];

  it('is sha256 over "<sha256>  <path>\\n" lines sorted by path (the format the sidecar reproduces)', () => {
    const expected = createHash('sha256')
      .update(`${HEX('a')}  a/x.json\n${HEX('b')}  b.onnx\n`)
      .digest('hex');
    expect(artifactSha256(files)).toBe(expected);
  });

  it('does not depend on file order or asset names, but on every file hash and path', () => {
    const base = artifactSha256(files);
    expect(artifactSha256([...files].reverse())).toBe(base);
    expect(artifactSha256(files.map((f) => ({ ...f, asset: 'renamed' })))).toBe(base);
    expect(artifactSha256([{ ...files[0]!, sha256: HEX('c') }, files[1]!])).not.toBe(base);
    expect(artifactSha256([{ ...files[0]!, path: 'c.onnx' }, files[1]!])).not.toBe(base);
  });
});
