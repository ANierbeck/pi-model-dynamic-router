// Parity gate of the ONNX sidecar against the MLX reference (plan
// docs/plans/2026-11-11-onnx-sidecar-package.md, step 2). The real run needs the
// owner's local data (~/.laya-ft) and is not part of CI; these tests pin the
// script's failure modes and the comparison rule with fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareParity } from '../scripts/parity-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'parity.mjs');

test('parity script refuses to run without a stored MLX reference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'parity-missing-'));
  const items = join(dir, 'items.jsonl');
  writeFileSync(items, '');
  const args = [
    script,
    '--items',
    items,
    '--reference',
    join(dir, 'nope.json'),
    '--sidecar',
    'http://127.0.0.1:1',
    '--gate',
    '1',
  ];
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /reference .*not found/i);
});

test('compareParity counts argmax agreement and reports the disagreeing keys', () => {
  const reference = {
    a: { category: 'simple', confidence: 0.9, probabilities: { simple: 0.9, standard: 0.1 } },
    b: { category: 'design', confidence: 0.8, probabilities: { design: 0.8, planning: 0.2 } },
    c: { category: 'continue', confidence: 0.4, probabilities: { continue: 0.4, standard: 0.6 } },
  };
  const observed = {
    a: { category: 'simple', confidence: 0.91, probabilities: { simple: 0.91, standard: 0.09 } },
    b: { category: 'planning', confidence: 0.5, probabilities: { design: 0.5, planning: 0.5 } },
    c: { category: 'continue', confidence: 0.4, probabilities: { continue: 0.4, standard: 0.6 } },
  };
  const r = compareParity(reference, observed, { minAgreement: 1 });
  assert.equal(r.total, 3);
  assert.equal(r.agree, 2);
  assert.deepEqual(r.disagree, ['b']);
  assert.equal(r.pass, false);
  assert.equal(compareParity(reference, observed, { minAgreement: 2 / 3 }).pass, true);
});

test('compareParity fails an item that is missing on the sidecar side', () => {
  const reference = { a: { category: 'simple', confidence: 0.9, probabilities: { simple: 0.9 } } };
  const r = compareParity(reference, {}, { minAgreement: 0 });
  assert.equal(r.missing.length, 1);
  assert.equal(r.pass, false);
});

test('compareParity reports the largest per-category probability delta', () => {
  const reference = {
    a: { category: 'simple', confidence: 0.9, probabilities: { simple: 0.9, standard: 0.1 } },
  };
  const observed = {
    a: { category: 'simple', confidence: 0.8, probabilities: { simple: 0.8, standard: 0.2 } },
  };
  const r = compareParity(reference, observed, { minAgreement: 1 });
  assert.ok(Math.abs(r.maxProbDelta - 0.1) < 1e-9, String(r.maxProbDelta));
});
