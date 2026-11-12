#!/usr/bin/env node
// Parity gate: the running ONNX sidecar must agree with the stored MLX reference on the same items
// (plan docs/plans/2026-11-11-onnx-sidecar-package.md, step 2).
//
// Usage: parity.mjs --items <jsonl> --reference <json> --sidecar <url> --gate <0..1>
// Exit codes: 0 pass, 1 below the gate, 2 usage, missing input or head mismatch.
import { existsSync, readFileSync } from 'node:fs';
import { compareParity } from './parity-lib.mjs';
import { classify, health } from './sidecar-client.mjs';
import { itemsDigest } from './parity-items.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

export async function run({ items, reference, sidecar, gate }) {
  const h = await health(sidecar);
  if (h.head_sha256 !== reference.meta.head_sha256) {
    return {
      code: 2,
      message: `head mismatch: sidecar ${h.head_sha256} vs reference ${reference.meta.head_sha256}`,
    };
  }
  if (itemsDigest(items) !== reference.meta.items_sha256) {
    return { code: 2, message: 'items differ from the ones the reference was recorded on' };
  }
  const observed = {};
  for (const it of items) observed[it.key] = await classify(sidecar, it);
  const r = compareParity(reference.items, observed, { minAgreement: gate });
  return { code: r.pass ? 0 : 1, result: r };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.items || !a.reference || !a.sidecar || a.gate === undefined) {
    console.error(
      'usage: parity.mjs --items <jsonl> --reference <json> --sidecar <url> --gate <0..1>'
    );
    process.exitCode = 2;
  } else if (!existsSync(a.reference)) {
    console.error(`reference ${a.reference} not found: record it with record-reference.mjs first`);
    process.exitCode = 2;
  } else {
    const items = readFileSync(a.items, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const reference = JSON.parse(readFileSync(a.reference, 'utf8'));
    const out = await run({ items, reference, sidecar: a.sidecar, gate: Number(a.gate) });
    if (out.message) console.error(out.message);
    if (out.result) {
      const r = out.result;
      console.log(
        `agree ${r.agree}/${r.total} (${(100 * r.rate).toFixed(1)} %), gate ${(100 * Number(a.gate)).toFixed(1)} %, ` +
          `max prob delta ${r.maxProbDelta.toFixed(4)}, confidence drift >0.05: ${r.confidenceDriftCount}`
      );
      if (r.disagree.length) console.log(`disagree: ${r.disagree.slice(0, 20).join(', ')}`);
      if (r.missing.length) console.log(`missing: ${r.missing.length}`);
    }
    process.exitCode = out.code;
  }
}

export { parseArgs };
