// Cross-language parity of GET /health (plan step 6): the TypeScript identity must equal
// spikes/laya-http/identity.py, the specification, byte for byte on the same directories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { healthPayload, servedHead } from '../dist/identity.js';

const here = dirname(fileURLToPath(import.meta.url));
const identityPy = join(here, '..', '..', 'spikes', 'laya-http', 'identity.py');

// A head with non-ASCII text and a quote, so the canonical JSON rules are actually exercised.
const HEAD = {
  instructions: 'Classify "the" request into one category — café, 日本語.',
  categories: ['simple', 'standard', 'design'],
};

function dirWith(record) {
  const dir = mkdtempSync(join(tmpdir(), 'identity-'));
  writeFileSync(join(dir, 'head.json'), JSON.stringify(HEAD));
  if (record) writeFileSync(join(dir, 'manifest.json'), JSON.stringify(record));
  return dir;
}

function viaPython(dir, headJson) {
  const args = [identityPy, '--model-dir', dir];
  if (headJson) args.push('--head-json', headJson);
  return JSON.parse(execFileSync('python3', ['-I', ...args], { encoding: 'utf8' }));
}

function viaTs(dir, headJsonText) {
  return healthPayload(dir, servedHead(dir, headJsonText));
}

const record = {
  schema_version: 1,
  model: 'router',
  version: '1.0.0',
  backend: 'onnx',
  files: [
    { path: 'head.json', sha256: 'b'.repeat(64) },
    { path: 'encoder.onnx', sha256: 'a'.repeat(64) },
  ],
  head_file: { path: 'head.json', format: 'raw' },
};

test('record + served head: identical /health fields', () => {
  const dir = dirWith(record);
  assert.deepEqual(viaTs(dir, null), viaPython(dir, null));
});

test('--head-json overrides the record head: identical fields and served_head', () => {
  const dir = dirWith(record);
  const headJson = join(dir, 'override.json');
  writeFileSync(headJson, JSON.stringify({ instructions: 'other', categories: ['x', 'y'] }));
  const ts = viaTs(dir, JSON.stringify({ instructions: 'other', categories: ['x', 'y'] }));
  assert.deepEqual(ts, viaPython(dir, headJson));
  assert.equal(ts.served_head, 'head-json');
});

test('no install record and no --head-json: status only, on both sides', () => {
  const dir = dirWith(null);
  assert.deepEqual(viaTs(dir, null), { status: 'ok' });
  assert.deepEqual(viaTs(dir, null), viaPython(dir, null));
});

test('a malformed file entry drops artifact_sha256 on both sides', () => {
  const dir = dirWith({ ...record, files: [{ path: 'encoder.onnx' }] });
  const ts = viaTs(dir, null);
  assert.equal('artifact_sha256' in ts, false);
  assert.deepEqual(ts, viaPython(dir, null));
});
