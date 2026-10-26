// Pair evaluation of the live A/B snapshot (docs/plans/2026-10-25-laya-sole-classifier.md,
// Step 2). Laya decides every prompt; a detached background chain answers the
// same input afterwards and is written as a `comparator` record with the same
// `input.sha`. This tool joins the two and reports where they agree.
//
//   npx tsx scripts/laya-pair-stats.ts [--file=<log>] [--window=<seconds>]
//
// Fairness rules:
//   - Answers are compared on `raw.category`, the classifier's own output.
//     `final` is not comparable: Laya's `final` already carries the router's
//     `continue` inheritance, the comparator's does not.
//   - `continue` is resolved the same way for both sides: with the previous
//     category of that record, exactly like `inheritPreviousCategory`.
//   - The group each side would have routed to comes from a category -> group
//     map OBSERVED in the log, never from a hard-coded table.
//
// The report contains counts and category names only. It never prints prompt
// text or the classifiers' free-text reasons (a reason can quote the prompt).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PairLogRecord {
  ts: string;
  stage: string;
  raw: null | { category: string | null; confidence: number | null };
  prev: null | { category: string | null; group: string | null };
  final: { category: string | null; group: string | null };
  ms: number;
  laya?: { category: string; confidence: number; acted: boolean; ms: number };
  input: { sha: string };
}

export interface Pair {
  laya: PairLogRecord;
  comparator: PairLogRecord;
}

export interface PairingResult {
  pairs: Pair[];
  unpairedLaya: number;
  orphanComparators: number;
}

export const DEFAULT_WINDOW_MS = 5 * 60_000;

/**
 * Joins each acted `laya` record with the first unused `comparator` record of
 * the same `input.sha` that follows it within `windowMs`. A repeated prompt
 * (same sha) pairs in order; every comparator is used at most once.
 */
export function pairRecords(records: PairLogRecord[], windowMs: number = DEFAULT_WINDOW_MS): PairingResult {
  const time = (r: PairLogRecord) => Date.parse(r.ts);
  const layas = records.filter((r) => r.stage === 'laya' && r.laya?.acted).sort((a, b) => time(a) - time(b));
  const comparators = records.filter((r) => r.stage === 'comparator').sort((a, b) => time(a) - time(b));

  const bySha = new Map<string, PairLogRecord[]>();
  for (const c of comparators) {
    const list = bySha.get(c.input.sha) ?? [];
    list.push(c);
    bySha.set(c.input.sha, list);
  }

  const used = new Set<PairLogRecord>();
  const pairs: Pair[] = [];
  for (const l of layas) {
    const candidates = bySha.get(l.input.sha) ?? [];
    const match = candidates.find((c) => {
      if (used.has(c)) return false;
      const dt = time(c) - time(l);
      return dt >= 0 && dt <= windowMs;
    });
    if (!match) continue;
    used.add(match);
    pairs.push({ laya: l, comparator: match });
  }
  return {
    pairs,
    unpairedLaya: layas.length - pairs.length,
    orphanComparators: comparators.length - pairs.length,
  };
}

/** The category the router would act on: `continue` takes the previous category. */
export function effectiveCategory(r: PairLogRecord): string | null {
  const c = r.raw?.category ?? null;
  if (c === null) return null;
  const prev = r.prev?.category;
  if (c === 'continue' && prev && prev !== 'continue') return prev;
  return c;
}

/**
 * category -> group as the router actually routed it, most frequent group per
 * category. `continue` is excluded (it has no group of its own) and so are
 * hints (their category is imposed by the target).
 */
export function observedGroupMap(records: PairLogRecord[]): Record<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const r of records) {
    if (r.stage === 'hint') continue;
    const cat = r.final?.category;
    const group = r.final?.group;
    if (!cat || cat === 'continue' || !group) continue;
    const m = counts.get(cat) ?? new Map<string, number>();
    m.set(group, (m.get(group) ?? 0) + 1);
    counts.set(cat, m);
  }
  const out: Record<string, string> = {};
  for (const [cat, m] of counts) {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    out[cat] = best[0];
  }
  return out;
}

export interface Tally {
  n: number;
  agree: number;
}

export interface PairSummary {
  /** All joined pairs, including those where a side gave no category. */
  n: number;
  /** Pairs where at least one side gave no category — excluded from agreement. */
  noAnswer: number;
  categoryAgree: number;
  groupKnown: number;
  groupAgree: number;
  byLayaCategory: Record<string, Tally>;
  /** Category disagreements as laya -> chain, most frequent first. */
  confusion: Array<{ laya: string; chain: string; n: number }>;
  confidenceBuckets: Record<string, Tally>;
  /** Raw `continue` answers: did Laya, the chain, both or neither say it. */
  continue: { both: number; layaOnly: number; chainOnly: number; neither: number };
  latency: { layaMedianMs: number; chainMedianMs: number };
}

const BUCKETS = ['≥ 0.95', '0.90-0.95', '0.80-0.90', '0.70-0.80', '< 0.70'] as const;

function bucketOf(c: number): (typeof BUCKETS)[number] {
  return c >= 0.95 ? '≥ 0.95' : c >= 0.9 ? '0.90-0.95' : c >= 0.8 ? '0.80-0.90' : c >= 0.7 ? '0.70-0.80' : '< 0.70';
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function summarizePairs(pairs: Pair[], groupOf: Record<string, string>): PairSummary {
  const summary: PairSummary = {
    n: pairs.length,
    noAnswer: 0,
    categoryAgree: 0,
    groupKnown: 0,
    groupAgree: 0,
    byLayaCategory: {},
    confusion: [],
    confidenceBuckets: Object.fromEntries(BUCKETS.map((b) => [b, { n: 0, agree: 0 }])),
    continue: { both: 0, layaOnly: 0, chainOnly: 0, neither: 0 },
    latency: {
      layaMedianMs: median(pairs.map((p) => p.laya.laya?.ms ?? p.laya.ms)),
      chainMedianMs: median(pairs.map((p) => p.comparator.ms)),
    },
  };
  const confusion = new Map<string, number>();

  for (const p of pairs) {
    const l = effectiveCategory(p.laya);
    const c = effectiveCategory(p.comparator);
    if (l === null || c === null) {
      summary.noAnswer += 1;
      continue;
    }
    const agree = l === c;
    if (agree) summary.categoryAgree += 1;
    else confusion.set(`${l}\u0000${c}`, (confusion.get(`${l}\u0000${c}`) ?? 0) + 1);

    const t = (summary.byLayaCategory[l] ??= { n: 0, agree: 0 });
    t.n += 1;
    if (agree) t.agree += 1;

    const gl = groupOf[l];
    const gc = groupOf[c];
    if (gl && gc) {
      summary.groupKnown += 1;
      if (gl === gc) summary.groupAgree += 1;
    }

    const conf = p.laya.laya?.confidence ?? p.laya.raw?.confidence ?? 0;
    const b = summary.confidenceBuckets[bucketOf(conf)];
    b.n += 1;
    if (agree) b.agree += 1;

    const layaCont = p.laya.raw?.category === 'continue';
    const chainCont = p.comparator.raw?.category === 'continue';
    if (layaCont && chainCont) summary.continue.both += 1;
    else if (layaCont) summary.continue.layaOnly += 1;
    else if (chainCont) summary.continue.chainOnly += 1;
    else summary.continue.neither += 1;
  }

  summary.confusion = [...confusion.entries()]
    .map(([k, n]) => {
      const [laya, chain] = k.split('\u0000');
      return { laya, chain, n };
    })
    .sort((a, b) => b.n - a.n || a.laya.localeCompare(b.laya) || a.chain.localeCompare(b.chain));
  return summary;
}

/** Wilson score interval (95 %) for k of n — honest about small samples. */
export function wilsonInterval(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

// Category names come from model output; print only well-formed labels so a
// malformed answer can never smuggle free text into the report.
const label = (s: string): string => (/^[a-z_]{1,24}$/.test(s) ? s : '(other)');

const pct = (k: number, n: number): string => (n ? `${((k / n) * 100).toFixed(1)} %` : '–');
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function rate(k: number, n: number): string {
  if (!n) return `${k} of ${n}`;
  const [lo, hi] = wilsonInterval(k, n);
  return `${k} of ${n} (${pct(k, n)}, 95 % CI ${(lo * 100).toFixed(1)}…${(hi * 100).toFixed(1)})`;
}

export function formatPairReport(
  s: PairSummary,
  meta: { file: string; unpairedLaya: number; orphanComparators: number },
): string {
  const answered = s.n - s.noAnswer;
  const lines: string[] = [];
  lines.push(`\nLaya vs comparator — ${meta.file}`);
  lines.push(
    `  ${plural(s.n, 'pair', 'pairs')} joined by input.sha` +
      ` (${plural(meta.unpairedLaya, 'laya record', 'laya records')} without comparator,` +
      ` ${plural(meta.orphanComparators, 'comparator record', 'comparator records')} without laya,` +
      ` ${s.noAnswer} without a category on one side)`,
  );
  lines.push(`\n  Category agreement (continue resolved with the previous category): ${rate(s.categoryAgree, answered)}`);
  lines.push(`  Group agreement (observed category -> group map): ${rate(s.groupAgree, s.groupKnown)}`);

  lines.push('\n  Per Laya category (resolved):');
  for (const [cat, t] of Object.entries(s.byLayaCategory).sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))) {
    lines.push(`    ${label(cat).padEnd(13)} n=${String(t.n).padStart(3)}  agree ${pct(t.agree, t.n)}`);
  }

  lines.push('\n  Disagreements (Laya → chain):');
  if (s.confusion.length === 0) lines.push('    (none)');
  for (const c of s.confusion.slice(0, 10)) {
    lines.push(`    ${label(c.laya).padEnd(13)} → ${label(c.chain).padEnd(13)} ${c.n}`);
  }

  lines.push('\n  Laya confidence → agreement with the chain:');
  for (const b of BUCKETS) {
    const t = s.confidenceBuckets[b];
    lines.push(`    ${b.padEnd(10)} n=${String(t.n).padStart(3)}  agree ${pct(t.agree, t.n)}`);
  }

  lines.push(
    `\n  Raw continue answers: both ${s.continue.both} | Laya only ${s.continue.layaOnly}` +
      ` | chain only ${s.continue.chainOnly} | neither ${s.continue.neither}`,
  );
  lines.push(`  Median latency: Laya ${s.latency.layaMedianMs} ms | chain (background) ${s.latency.chainMedianMs} ms`);
  lines.push(
    '\n  Agreement is not accuracy: the chain is a second opinion, not the truth.' +
      ' Truth comes from owner labels (live_label.py).\n',
  );
  return lines.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const file = args.find((a) => a.startsWith('--file='))?.split('=', 2)[1] ?? join(homedir(), '.pi', 'logs', 'classifier-decisions.jsonl');
  const windowSec = Number(args.find((a) => a.startsWith('--window='))?.split('=', 2)[1] ?? DEFAULT_WINDOW_MS / 1000);

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`No decision log yet at ${file} — run some prompts and come back.`);
      return;
    }
    throw err;
  }
  const records: PairLogRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as PairLogRecord);
    } catch {
      // torn line at a rotation boundary — skip it
    }
  }
  const { pairs, unpairedLaya, orphanComparators } = pairRecords(records, windowSec * 1000);
  console.log(formatPairReport(summarizePairs(pairs, observedGroupMap(records)), { file, unpairedLaya, orphanComparators }));
}

if (process.argv[1] && process.argv[1].endsWith('laya-pair-stats.ts')) main();
