// Statistics about Laya shadow observations in the classifier decision log.
// Reads ~/.pi/logs/classifier-decisions.jsonl (or --file=<log>) and summarizes:
//   - how often Laya ran next to the real chain (shadow mode) and how often it
//     disagreed
//   - how often Laya exceeded confidence_threshold (= "would have decided in
//     active mode")
//   - the most frequent disagreement pairs
//   - DISAGREEMENTS: prompts where Laya disagreed with the chain with high
//     confidence - exactly the raw material for the golden set (Task 7).
//     input.text is only present if classifier_log.store_text is "full".
//
//   npx tsx scripts/laya-shadow-stats.ts [--file=<log>] [--threshold=0.8]

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRoutingRecord } from '../src/classifier-decision-log.ts';

interface DecisionRecord {
  stage: string;
  final: { category: string | null; hint?: { target: string } };
  laya?: { category: string; confidence: number; acted: boolean; ms: number };
  input?: { text: { prompt: string } | null };
}

const LOG_FILE = join(homedir(), '.pi', 'logs', 'classifier-decisions.jsonl');

const args = process.argv.slice(2);
const file = args.find((a) => a.startsWith('--file='))?.split('=', 2)[1] ?? LOG_FILE;
const threshold = parseFloat(args.find((a) => a.startsWith('--threshold='))?.split('=', 2)[1] ?? '0.8');

const raw = (() => {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`No decision log yet at ${file} — run some prompts and come back.`);
      process.exit(0);
    }
    throw err;
  }
})();
const records: DecisionRecord[] = raw.split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const withLaya = records.filter((r) => r.laya && isRoutingRecord(r));
const disagree = withLaya.filter((r) => {
  const finalCat = r.final.hint?.target ?? r.final.category;
  return r.laya && finalCat && r.laya.category !== finalCat;
});

type Bucket = '≥ 0.95' | '0.90-0.95' | '0.80-0.90' | '0.70-0.80' | '< 0.70';
const buckets = new Map<Bucket, number>();
const confByOutcome = new Map<
  'agree' | 'disagree' | 'decided',
  { sum: number; n: number }
>();
const confusion = new Map<string, number>();
const decided = [] as DecisionRecord[];
for (const r of withLaya) {
  const c = r.laya!.confidence;
  const b: Bucket = c >= 0.95
    ? '≥ 0.95' : c >= 0.90 ? '0.90-0.95' : c >= 0.80 ? '0.80-0.90' : c >= 0.70 ? '0.70-0.80' : '< 0.70';
  buckets.set(b, (buckets.get(b) ?? 0) + 1);
  const finalCat = r.final.hint?.target ?? r.final.category;
  const outcome = finalCat ? (r.laya!.category === finalCat ? 'agree' : 'disagree') : 'decided';
  const m = confByOutcome.get(outcome) ?? { sum: 0, n: 0 };
  confByOutcome.set(outcome, m);
  m.sum += c; m.n += 1;
  if (outcome === 'disagree') {
    const key = r.laya!.category + ' |→ ' + finalCat!;
    confusion.set(key, (confusion.get(key) ?? 0) + 1);
  }
  if (c >= threshold) decided.push(r);
}

const disagreeRate = withLaya.length ? (disagree.length / withLaya.length * 100).toFixed(1) : '0.0';
const decidedRate = withLaya.length ? (decided.length / withLaya.length * 100).toFixed(1) : '0.0';
const avgConf = (m: { sum: number; n: number }) => (m.n ? (m.sum / m.n * 100).toFixed(1) : '-');
const avgConfAgree = avgConf(confByOutcome.get('agree') ?? { sum: 0, n: 0 });
const avgConfDisagree = avgConf(confByOutcome.get('disagree') ?? { sum: 0, n: 0 });

console.log(`\nLaya shadow statistics — ${file}`);
console.log(`  Laya invocations across ${withLaya.length} classifications`);
console.log(`  Agreement chain | Laya:      ${(100 - Number(disagreeRate)).toFixed(1)} % (${disagree.length} of ${withLaya.length} different)`);
console.log(`  Laya ≥ ${threshold.toFixed(2)} (would have decided): ${decided.length} of ${withLaya.length} (${decidedRate} %)  Avg confidence: agree ${avgConfAgree} | disagree ${avgConfDisagree}`);
console.log(`  Latency:  avg ${withLaya.length ? (withLaya.reduce((a, r) => a + r.laya!.ms, 0) / withLaya.length).toFixed(0) : 0} ms`);
console.log(`\n  Confidence buckets: ${withLaya.length ? Array.from(buckets.entries()).map(([k, v]) => `${k}=${v}`).join(' ') : '(no Laya calls)'}`);
console.log(`\n  Top-5 disagreement pairs:`);
for (const [k, v] of Array.from(confusion.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  const [layaPart, finalPart] = k.split(' |→ ');
  console.log(`    ${layaPart.padEnd(12)} → ${finalPart} ${v}`);
}

console.log(
  `\nImportant: Laya disagreed with the chain at ≥${threshold.toFixed(2)} confidence (${disagree.filter((r) => r.laya!.confidence >= threshold).length}x). ` +
  `This is the raw material for the golden set (Task 7):`
);
let n = 0;
for (const r of disagree.filter((r) => r.laya!.confidence >= threshold)) {
  n += 1;
  const prompt = r.input?.text?.prompt?.slice(0, 140) ?? '(no prompt stored - store_text != "full")';
  console.log(`    #${n}  ${r.laya!.category} (${r.laya!.confidence.toFixed(2)}) Laya vs ${r.final.hint?.target ?? r.final.category} chain`);
  console.log(`       "${prompt}"`);
}
if (n === 0) console.log('    (no high-confidence disagreements yet - keep working and come back later)');
console.log();
