// End-to-end check of the Laya stage: the REAL classifyPrompt chain against a
// REAL running HTTP wrapper (no mocks, no stub server). The unit and chain
// tests use a stub that mirrors the wrapper's contract; this script is the
// check that the contract itself still holds - it is how the endpoint-path and
// nested-context defects (found 2026-10-09) would have been caught the first
// time. Run it after every change to the client or the wrapper.
//
//   # 1. start the wrapper (see docs/research/2026-10-09-laya-spike.md, "Start here")
//   # 2. run with a throw-away HOME so the decision log does not touch yours:
//   HOME=$(mktemp -d) PI_ROUTER_STATE_DIR=$HOME \
//     npx tsx scripts/laya-e2e.ts --checkpoint <repo@rev> [--mode active|shadow] [--endpoint http://127.0.0.1:8089]
//
// The checkpoint is only a label for `laya:<checkpoint>` in this script (the
// wrapper decides which weights it serves); it is a CLI argument, never a
// literal, in line with ADR-0025. Without a local Ollama the prompts Laya
// declines end in the static `fallback` - that is the chain without Laya, not
// a failure of the stage.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyPrompt, getLastClassificationSource } from '../src/content-classifier.ts';
import { validateClassifierLaya } from '../src/config-loader.ts';
import { getLastProbeError, layaAvailabilityState } from '../src/laya-classifier.ts';
import type { Config } from '../src/types.ts';
import { textOf } from '../src/utils.ts';
import { arg } from './lib/cli.ts';

const checkpoint = arg('checkpoint');
if (!checkpoint) {
  console.error(
    'usage: npx tsx scripts/laya-e2e.ts --checkpoint <repo@rev> [--mode active|shadow] [--endpoint <base url>]'
  );
  process.exit(2);
}
const mode = arg('mode') === 'shadow' ? 'shadow' : 'active';

const cfg = {
  providers: {},
  model_groups: {},
  model_metrics: {},
  classifier_log: { enabled: true, store_text: 'none' },
  classifier_laya: {
    enabled: true,
    checkpoint,
    mode,
    ...(arg('endpoint') ? { endpoint: arg('endpoint') } : {}),
  },
} as unknown as Config;
validateClassifierLaya(cfg); // the real validator fills the defaults, like a real config load

console.log(`classifier_laya: ${JSON.stringify(cfg.classifier_laya)}`);
console.log(`state before first use: ${layaAvailabilityState()}`);

const cases: Array<[string, string, Record<string, string>?]> = [
  [
    'EN design',
    'Design the module boundaries and the data flow for a new billing service that has to support multi-tenant invoicing.',
  ],
  [
    'DE design',
    'Entwirf die Modulgrenzen und den Datenfluss für einen neuen Abrechnungsdienst mit Mandantenfähigkeit.',
  ],
  ['DE trivial', 'Was bedeutet das Kürzel API?'],
  ['EN code_simple', 'Rename the variable `cnt` to `count` in utils.ts'],
  ['HINT', 'HINT: use group strategic\nplease review this module'],
  [
    'with context',
    'und wie sieht das für die Rechnungsstellung aus?',
    {
      previousUserMessage: 'Wir bauen einen Abrechnungsdienst',
      lastAssistantSnippet: 'Ich schlage drei Module vor',
    },
  ],
  [
    'long (6 kB)',
    'Please analyse this log and tell me what is wrong: ' +
      'ERROR connection reset by peer at worker-3 while flushing batch\n'.repeat(100),
  ],
];

for (const [name, text, context] of cases) {
  const t0 = Date.now();
  // The real result type, not a Record<string, unknown>: the verdict is a
  // category or a hint, and both are strings (a bare String() of an unknown
  // would print "[object Object]" if the shape ever changed).
  const r = await classifyPrompt(text, {
    cfg,
    model: 'none',
    timeoutMs: 500,
    context: context ?? {},
  });
  const verdict = 'category' in r ? r.category : `${r.hintType}:${r.hintTarget}`;
  console.log(
    `${name.padEnd(15)} -> ${verdict.padEnd(18)} via ${getLastClassificationSource()?.source}  ${Date.now() - t0}ms`
  );
}

console.log(
  `state after use: ${layaAvailabilityState()}${getLastProbeError() ? ` (${getLastProbeError()})` : ''}`
);
const log = join(homedir(), '.pi', 'logs', 'classifier-decisions.jsonl');
if (existsSync(log)) {
  console.log('decision log (what Laya said vs what was decided):');
  for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
    const rec = JSON.parse(line) as {
      stage?: unknown;
      laya?: { category?: unknown; confidence?: unknown; acted?: unknown; ms?: unknown } | null;
      final?: { category?: unknown; hint?: { target?: unknown } | null };
    };
    const l = rec.laya
      ? `${textOf(rec.laya.category)} ${textOf(rec.laya.confidence)} acted=${textOf(
          rec.laya.acted
        )} ${textOf(rec.laya.ms)}ms`
      : '-';
    console.log(
      `  stage=${String(rec.stage).padEnd(9)} final=${textOf(
        rec.final?.category ?? rec.final?.hint?.target
      )}  laya: ${l}`
    );
  }
}
