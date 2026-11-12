// Pre-publish check for a Laya weights release
// (docs/plans/2026-11-08-laya-model-artifact.md; RELEASE_CHECKLIST.md, "Weights release").
//
// The manifest is the contract and the release assets are the payload: before
// anyone uploads, the directory that will be uploaded must hold exactly the
// assets the manifest names, byte for byte. This script only READS; it never
// uploads or edits the manifest.
//
//   node scripts/laya-release-check.ts --dir <release dir> [--model router@1.0.0]

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg, invokedDirectly } from './lib/cli.ts';
import type { LayaManifest } from '../src/laya-model-manifest.ts';

const MANIFEST = fileURLToPath(new URL('../laya-models/manifest.json', import.meta.url));

function sha256OfFile(file: string): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', fail)
      .on('end', () => ok(h.digest('hex')));
  });
}

/** Problems between the release directory and the manifest entry; empty = ready to upload. */
export async function checkReleaseDir(
  dir: string,
  manifest: LayaManifest,
  model: string
): Promise<string[]> {
  const entry = manifest.models.find((m) => `${m.model}@${m.version}` === model);
  if (!entry) return [`${model} is not in the manifest`];
  const problems: string[] = [];
  const expected = new Map<string, { bytes: number; sha256: string }>();
  for (const set of Object.values(entry.backends)) {
    for (const f of set.files) expected.set(f.asset, { bytes: f.bytes, sha256: f.sha256 });
  }
  for (const [asset, want] of expected) {
    const file = join(dir, asset);
    if (!existsSync(file)) {
      problems.push(`${asset}: missing`);
      continue;
    }
    const size = statSync(file).size;
    if (size !== want.bytes) {
      problems.push(`${asset}: ${size} bytes, manifest says ${want.bytes}`);
      continue;
    }
    if ((await sha256OfFile(file)) !== want.sha256) problems.push(`${asset}: sha256 differs`);
  }
  for (const name of readdirSync(dir)) {
    if (!expected.has(name)) problems.push(`${name}: not in the manifest (would be uploaded)`);
  }
  return problems;
}

async function main(): Promise<void> {
  const dir = arg('dir');
  if (!dir) {
    console.error('usage: laya-release-check.ts --dir <release dir> [--model <model>@<version>]');
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as LayaManifest;
  const first = manifest.models[0];
  const model = arg('model') ?? `${first.model}@${first.version}`;
  const problems = await checkReleaseDir(resolve(dir), manifest, model);
  if (problems.length > 0) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  const entry = manifest.models.find((m) => `${m.model}@${m.version}` === model)!;
  console.log(`ok: ${dir} matches ${model}; tag ${entry.tag}, published=${entry.published}`);
}

if (invokedDirectly(import.meta.url)) await main();
