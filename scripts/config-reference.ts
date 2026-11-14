// scripts/config-reference.ts
// Renders docs/config-reference.md from the key table (src/config-keys.ts) and
// the chain the shipped config produces (src/classifier-chain.ts). Config plan
// 2026-11-14, Phase 5. The committed file is checked for staleness by
// test/config-reference-docs.test.ts; regenerate it with:
//
//   node scripts/config-reference.ts --write

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_KEYS, type ConfigKeySpec } from '../src/config-keys.ts';
import { describeClassifierChain } from '../src/classifier-chain.ts';
import type { Config } from '../src/types.ts';
import { invokedDirectly } from './lib/cli.ts';

const HEADER = [
  '<!-- Generated from src/config-keys.ts by scripts/config-reference.ts. Do not edit by hand:',
  '     run `node scripts/config-reference.ts --write` after changing the key table. -->',
  '',
  '# Config reference',
  '',
  'Every key in the table that `/router config` documents. Defaults are the shipped',
  '`router-config.json` values; keys the shipped file does not set show the code default.',
  'Concepts (order, privacy, when cloud is used) are in `README.md` and',
  '`docs/config-override.md`; this page lists the keys.',
  '',
  '## Classifier chain (computed from the shipped config)',
  '',
  'The order is fixed in code: Laya, then the local Ollama leg, then the cloud leg, then',
  'the static rules. The config only switches legs on and off and names their models.',
  '',
];

/** The key entry: how it is set, what it means, and any pre-2.0 name it replaces. */
function renderKey(spec: ConfigKeySpec): string[] {
  const how =
    spec.via === 'set'
      ? `\`/router config set ${spec.path} <value>\`${spec.wizard ? ' (also in the guided menu)' : ''}`
      : spec.via === 'alias'
        ? `\`/router ${spec.alias}\``
        : 'hand-edit the user layer (`router-config.user.json`)';
  const lines = [
    `### \`${spec.path}\``,
    '',
    `- Shipped: \`${spec.shipped}\``,
    `- Set by: ${how}`,
    `- Meaning: ${spec.meaning}`,
  ];
  if (spec.legacy && spec.legacy.length > 0) {
    lines.push(
      `- Pre-2.0 name, read once with a warning: ${spec.legacy.map((l) => `\`${l}\``).join(', ')}`
    );
  }
  lines.push('');
  return lines;
}

/** The full reference page for the given shipped config. */
export function renderConfigReference(shipped: Config): string {
  const chain = describeClassifierChain(shipped);
  const lines = [...HEADER];
  for (const step of chain) {
    lines.push(`- **${step.label}** — ${step.active ? 'on' : 'off'}: ${step.detail}`);
  }
  lines.push('', '## Keys', '');
  for (const spec of CONFIG_KEYS) lines.push(...renderKey(spec));
  return lines.join('\n');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

function main(): void {
  const shipped = JSON.parse(
    fs.readFileSync(path.join(repo, 'router-config.json'), 'utf-8')
  ) as Config;
  const text = renderConfigReference(shipped);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(path.join(repo, 'docs', 'config-reference.md'), text);
    console.log('wrote docs/config-reference.md');
  } else {
    console.log(text);
  }
}

if (invokedDirectly(import.meta.url)) main();
