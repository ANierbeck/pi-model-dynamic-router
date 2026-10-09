// Classifier replay harness (docs/plans/2026-10-08-classifier-decision-log.md,
// Phase 3). Offline comparison of a candidate classifier (e.g. a local Laya
// service) against the KNOWN classifier's recorded decisions:
//
//   1. Build a corpus of real prompts:
//      - decision-log records (store_text: "full" — prompt + known decision)
//      - backfilled session files (~/.pi/agent/sessions/**/*.jsonl) — the
//        router era predating the log; these have NO known decision, they are
//        golden-set candidates (label via replay disagreement + sample).
//   2. POST each prompt to a candidate endpoint (generic HTTP contract, no
//      Laya specifics: POST /classify {prompt} → {category, confidence?}).
//   3. Report agreement rate + every disagreement, both as categories and
//      routed groups.
//
// Usage:
//   npx tsx scripts/classifier-replay.ts \
//     --records ~/.pi/logs/classifier-decisions.jsonl \
//     --sessions ~/.pi/agent/sessions/--Users-anierbeck-git-pi-model-router-fork-- \
//     --since 2026-09-27 --endpoint http://127.0.0.1:8080 \
//     --limit 200 --report /tmp/replay-report.json

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGroupForCategory } from '../src/content-classifier.ts';

export interface SessionPrompt {
  text: string;
  ts: string;
  source: string;
  hasAttachment: boolean;
}

export interface DecisionRecordLite {
  v: number;
  ts: string;
  stage: string;
  final: { category: string | null; group: string | null };
  input: {
    text: { prompt: string; previousUserMessage?: string; lastAssistantSnippet?: string } | null;
    sha: string;
  };
}

/** Background context the known classifier saw (store_text "full" records only). */
export interface CorpusContext {
  previousUserMessage?: string;
  lastAssistantSnippet?: string;
}

export interface CorpusItem {
  prompt: string;
  knownCategory: string | null;
  knownGroup: string | null;
  source: string;
  ts: string;
  hasAttachment: boolean;
  duplicates: number;
  /** Present when the decision record stored the context texts. */
  context?: CorpusContext;
}

export interface Disagreement {
  prompt: string;
  knownCategory: string | null;
  knownGroup: string | null;
  candidateCategory: string | null;
  candidateGroup: string | null;
  invalidCategory: boolean;
  source: string;
  ts: string;
}

export interface ReplayResult {
  total: number;
  classified: number;
  agree: number;
  errors: number;
  disagreements: Disagreement[];
}

// ── corpus sources ────────────────────────────────────────────────────────

/** User prompts from session JSONL files (malformed lines are skipped). */
export function extractSessionPrompts(paths: string[]): SessionPrompt[] {
  const out: SessionPrompt[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const lines = readFileLinesSync(p);
    for (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== 'message' || entry?.message?.role !== 'user') continue;
      const blocks = entry.message.content;
      if (!Array.isArray(blocks)) continue;
      let text = '';
      let hasAttachment = false;
      for (const b of blocks) {
        if (b?.type === 'text' && typeof b.text === 'string') text += b.text;
        else hasAttachment = true;
      }
      text = text.trim();
      if (!text) continue;
      out.push({ text, ts: entry.timestamp ?? '', source: p, hasAttachment });
    }
  }
  return out;
}

function readFileLinesSync(p: string): string[] {
  // Session files are small (MBs) — a sync read keeps the reader dependency-free.
  return readFileSync(p, 'utf8').split('\n');
}

/** Decision-log records (JSONL); malformed lines are skipped, v is pinned. */
export function readDecisionRecords(paths: string[]): DecisionRecordLite[] {
  const out: DecisionRecordLite[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec?.v === 1) out.push(rec);
      } catch {
        // A torn line (two processes appending) — skip, the next one is fine.
      }
    }
  }
  return out;
}

/** Corpus: full-text records (with known decision) + session prompts, deduped. */
export function buildCorpus(opts: {
  records?: DecisionRecordLite[];
  sessionPrompts?: SessionPrompt[];
  since?: string | undefined;
  limit?: number | undefined;
}): CorpusItem[] {
  const byPrompt = new Map<string, CorpusItem>();
  const add = (item: CorpusItem) => {
    const existing = byPrompt.get(item.prompt);
    if (existing) {
      existing.duplicates++;
      return;
    }
    byPrompt.set(item.prompt, item);
  };
  for (const r of opts.records ?? []) {
    if (opts.since && r.ts < opts.since) continue;
    const prompt = r.input?.text?.prompt;
    if (!prompt) continue; // store_text "none" — no prompt, nothing to replay
    const t = r.input.text!;
    const context: CorpusContext = {
      ...(t.previousUserMessage ? { previousUserMessage: t.previousUserMessage } : {}),
      ...(t.lastAssistantSnippet ? { lastAssistantSnippet: t.lastAssistantSnippet } : {}),
    };
    add({
      prompt,
      knownCategory: r.final?.category ?? null,
      knownGroup: r.final?.group ?? null,
      source: 'decision-log',
      ts: r.ts,
      hasAttachment: false,
      duplicates: 0,
      ...(Object.keys(context).length ? { context } : {}),
    });
  }
  for (const s of opts.sessionPrompts ?? []) {
    if (opts.since && s.ts && s.ts < opts.since) continue;
    add({
      prompt: s.text,
      knownCategory: null,
      knownGroup: null,
      source: s.source,
      ts: s.ts,
      hasAttachment: s.hasAttachment,
      duplicates: 0,
    });
  }
  let items = [...byPrompt.values()];
  if (opts.limit) items = items.slice(0, opts.limit);
  return items;
}

function sessionFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const stat = statSync(dir);
  if (stat.isFile()) return [dir];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...sessionFilesUnder(full));
    else if (name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

// ── candidate endpoint ────────────────────────────────────────────────────

const KNOWN_CATEGORIES = new Set([
  'trivial', 'simple', 'code_simple', 'standard', 'code_complex',
  'design', 'planning', 'exploration', 'fallback',
]);

async function classifyViaEndpoint(
  endpoint: string,
  item: { prompt: string; context?: CorpusContext },
): Promise<{ category: string | null; invalid: boolean; error: boolean }> {
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Same inputs the known classifier saw: the prompt plus, when the
      // decision record stored them, the two background context texts.
      body: JSON.stringify({ prompt: item.prompt, ...(item.context ? { context: item.context } : {}) }),
    });
    if (!res.ok) return { category: null, invalid: false, error: true };
    const body = (await res.json().catch(() => null)) as any;
    const category = typeof body?.category === 'string' ? body.category : null;
    return { category, invalid: category !== null && !KNOWN_CATEGORIES.has(category), error: category === null };
  } catch {
    return { category: null, invalid: false, error: true };
  }
}

/** Replay a corpus against the candidate endpoint and compare to the known decisions. */
export async function replayAgainstEndpoint(
  corpus: CorpusItem[],
  opts: { endpoint: string; concurrency?: number },
): Promise<ReplayResult> {
  const result: ReplayResult = {
    total: corpus.length,
    classified: 0,
    agree: 0,
    errors: 0,
    disagreements: [],
  };
  const queue = [...corpus];
  const workers = Math.max(1, Math.min(opts.concurrency ?? 4, queue.length || 1));
  const runWorker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const { category, invalid, error } = await classifyViaEndpoint(opts.endpoint, item);
      if (error) {
        result.errors++;
        continue;
      }
      result.classified++;
      const candidateGroup = getGroupForCategory(category!);
      const sameGroup = item.knownGroup ? candidateGroup === item.knownGroup : null;
      const sameCategory = item.knownCategory ? category === item.knownCategory : null;
      if (item.knownCategory !== null && sameCategory) {
        result.agree++;
        continue;
      }
      result.disagreements.push({
        prompt: item.prompt,
        knownCategory: item.knownCategory,
        knownGroup: item.knownGroup,
        candidateCategory: category,
        candidateGroup,
        invalidCategory: invalid,
        source: item.source,
        ts: item.ts,
      });
      void sameGroup;
    }
  };
  await Promise.all(Array.from({ length: workers }, runWorker));
  return result;
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const recordsPaths = flag('records') ? [flag('records')!] : [];
  const sessionsDir = flag('sessions');
  const sessionPrompts = sessionsDir ? extractSessionPrompts(sessionFilesUnder(sessionsDir)) : [];
  const corpus = buildCorpus({
    records: readDecisionRecords(recordsPaths),
    sessionPrompts,
    since: flag('since'),
    limit: flag('limit') ? Number(flag('limit')) : undefined,
  });
  const endpoint = flag('endpoint');
  if (!endpoint) {
    console.log(`corpus: ${corpus.length} unique prompts (from ${recordsPaths.length} record file(s), ${sessionPrompts.length} session prompt(s))`);
    console.log('pass --endpoint http://… to replay against a candidate classifier');
    return;
  }
  const result = await replayAgainstEndpoint(corpus, { endpoint });
  const rate = result.classified ? Math.round((100 * result.agree) / result.classified) : 0;
  console.log(`replayed ${result.total}: ${result.classified} classified, ${result.agree} agree (${rate}%), ${result.disagreements.length} disagree, ${result.errors} endpoint error(s)`);
  const report = flag('report');
  if (report) {
    writeFileSync(report, JSON.stringify({ corpusSize: corpus.length, result }, null, 2));
    console.log(`report: ${report}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('classifier-replay.ts')) {
  await main();
}
