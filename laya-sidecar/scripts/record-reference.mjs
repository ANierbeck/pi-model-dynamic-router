#!/usr/bin/env node
// Records the reference answers of a running server (the MLX sidecar on the owner's Mac) for a
// fixed item set. Usage: record-reference.mjs --items <jsonl> --server <url> --name <mlx> --out <json>
import { readFileSync, writeFileSync } from 'node:fs';
import { classify, health } from './sidecar-client.mjs';
import { toReference } from './parity-items.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

export async function record({ items, server, name }) {
  const h = await health(server);
  if (!h.head_sha256) throw new Error(`${server} reports no head_sha256; cannot pin the head`);
  const answers = {};
  for (const it of items) answers[it.key] = await classify(server, it);
  return toReference(items, answers, {
    server: name,
    url: server,
    head_sha256: h.head_sha256,
    recorded_at: new Date().toISOString(),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs(process.argv.slice(2));
  const items = readFileSync(a.items, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const ref = await record({ items, server: a.server, name: a.name ?? 'mlx' });
  writeFileSync(a.out, JSON.stringify(ref, null, 1), { mode: 0o600 });
  console.log(
    `recorded ${ref.meta.count} items from ${a.server} (head ${ref.meta.head_sha256.slice(0, 12)}) -> ${a.out}`
  );
}
