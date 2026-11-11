import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReleaseDir } from '../scripts/laya-release-check.ts';
import type { LayaManifest } from '../src/laya-model-manifest.ts';

const sha = (b: string) => createHash('sha256').update(b).digest('hex');

function manifest(): LayaManifest {
  const file = (asset: string, body: string) => ({
    path: asset,
    asset,
    bytes: body.length,
    sha256: sha(body),
  });
  return {
    schema_version: 1,
    models: [
      {
        model: 'm',
        version: '1.0.0',
        tag: 'laya-m-v1.0.0',
        published: false,
        base_url: 'https://example.invalid/',
        head: { sha256: 'x', categories: [] },
        backends: {
          onnx: {
            head_file: { path: 'a', format: 'head-json' },
            files: [file('a', 'AAA'), file('b', 'BB')],
          },
          mlx: {
            head_file: { path: 'a', format: 'head-json' },
            files: [file('a', 'AAA'), file('c', 'C')],
          },
        },
      },
    ],
  } as unknown as LayaManifest;
}

describe('laya-release-check', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const fill = (files: Record<string, string>) => {
    dir = mkdtempSync(join(tmpdir(), 'laya-release-'));
    for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v);
  };

  it('passes when the directory holds exactly the manifest assets (shared asset counted once)', async () => {
    fill({ a: 'AAA', b: 'BB', c: 'C' });
    expect(await checkReleaseDir(dir, manifest(), 'm@1.0.0')).toEqual([]);
  });

  it('reports a missing asset', async () => {
    fill({ a: 'AAA', b: 'BB' });
    expect(await checkReleaseDir(dir, manifest(), 'm@1.0.0')).toEqual(['c: missing']);
  });

  it('reports a size mismatch and a same-size content difference separately', async () => {
    fill({ a: 'AAAA', b: 'XX', c: 'C' });
    const out = await checkReleaseDir(dir, manifest(), 'm@1.0.0');
    expect(out).toEqual(['a: 4 bytes, manifest says 3', 'b: sha256 differs']);
  });

  it('reports a file the manifest does not name, because the upload would include it', async () => {
    fill({ a: 'AAA', b: 'BB', c: 'C', 'stray.log': 'x' });
    expect(await checkReleaseDir(dir, manifest(), 'm@1.0.0')).toEqual([
      'stray.log: not in the manifest (would be uploaded)',
    ]);
  });

  it('rejects a model the manifest does not list', async () => {
    fill({});
    expect(await checkReleaseDir(dir, manifest(), 'other@1')).toEqual([
      'other@1 is not in the manifest',
    ]);
  });

  it('agrees with the shipped manifest on its own asset list (every LICENSE/NOTICE entry has a repo file)', async () => {
    const shipped = JSON.parse(
      readFileSync(join(__dirname, '..', 'laya-models', 'manifest.json'), 'utf8')
    ) as LayaManifest;
    fill({ LICENSE: readFileSync(join(__dirname, '..', 'laya-models', 'LICENSE'), 'utf8') });
    const out = await checkReleaseDir(dir, shipped, 'router@1.0.0');
    expect(out).not.toContain('LICENSE: missing');
    expect(out).not.toContain('LICENSE: sha256 differs');
    expect(out).toContain('NOTICE: missing');
  });
});
