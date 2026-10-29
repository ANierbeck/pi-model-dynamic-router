// Join of pi session turns with the classifier decision log
// (docs/plans/2026-10-26-continue-keeps-model.md, measurement prerequisite).
//
//   npx tsx scripts/turn-decision-join.ts [--sessions=<dir>] [--log=<file>]
//                                         [--since=<iso>] [--until=<iso>]
//
// A turn is a user message in a pi session file. Its routing decision is the
// decision-log record with the same prompt hash (`input.sha`) whose timestamp
// falls shortly after the message (window: 2 s before to 30 s after). Two rules
// keep the join honest:
//   - the background `comparator` stage never routes, so its records are never
//     candidates for a turn;
//   - more than one candidate is reported as `ambiguous` and never picked, so a
//     common prompt such as "continue" cannot silently borrow another turn's
//     decision.
//
// `served` is the provider/model of the first assistant reply after the user
// message. `switched` compares it with the last served model of the same
// session; it is null when either side is unknown.
//
// Reproducibility: the report prints the exact bounds and a fingerprint of the
// joined rows. Pass the same --since/--until to reproduce a number; without
// --until the newest turns of a live session can change the result.
//
// The report contains counts and category names only. Prompt text and hashes
// are never printed.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { messageText, stripRouterNarration } from '../src/utils.ts';
import { NON_ROUTING_STAGES } from '../src/classifier-decision-log.ts';

export interface SessionTurn {
  session: string;
  ts: number;
  sha: string;
  served: string | null;
}

export interface DecisionRow {
  ts: number;
  sha: string;
  stage: string;
  category: string | null;
  group: string | null;
  /** Process tag of the router that made the decision (`<project>/<pid>`). */
  proc?: string | null;
}

export interface JoinedTurn extends SessionTurn {
  status: 'matched' | 'ambiguous' | 'unmatched';
  category: string | null;
  group: string | null;
  switched: boolean | null;
  /** Time and process of the matched decision; null unless matched. */
  decisionTs: number | null;
  proc: string | null;
}

export interface JoinWindow {
  beforeMs: number;
  afterMs: number;
}

export const DEFAULT_WINDOW: JoinWindow = { beforeMs: 2_000, afterMs: 30_000 };

export interface Bounds {
  since?: number;
  until?: number;
}

/** Same hash as the decision log: sha256 of the UTF-8 prompt, first 12 hex chars. */
export function promptSha(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex').slice(0, 12);
}

function inBounds(ts: number, b: Bounds): boolean {
  return (b.since === undefined || ts >= b.since) && (b.until === undefined || ts <= b.until);
}

/**
 * The text the router classified: `extractLastUserPrompt` (src/context-utils.ts)
 * hashes `stripRouterNarration(messageText(content))`, so the join must too —
 * otherwise a message with a "> [router]" line, outer whitespace or several
 * text blocks never meets its own decision record.
 */
function userText(content: unknown): string {
  return stripRouterNarration(messageText(content));
}

function parseLines(path: string): unknown[] {
  const out: unknown[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn last line (the log is still being written) is skipped, not fatal.
    }
  }
  return out;
}

/** User turns of every `*.jsonl` session file in `dir`, with the first served model after each. */
export function readSessionTurns(dir: string, bounds: Bounds): SessionTurn[] {
  const turns: SessionTurn[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    let pending: SessionTurn | null = null;
    for (const rec of parseLines(join(dir, file)) as Array<Record<string, any>>) {
      if (rec?.type !== 'message' || !rec.message || typeof rec.message !== 'object') continue;
      const m = rec.message;
      if (m.role === 'user') {
        const text = userText(m.content);
        if (text.startsWith('<memory>')) continue; // memory block, not a prompt
        const ts = typeof m.timestamp === 'number' ? m.timestamp : Date.parse(rec.timestamp);
        pending = { session: file, ts, sha: promptSha(text), served: null };
        if (inBounds(ts, bounds)) turns.push(pending);
      } else if (m.role === 'assistant' && pending && pending.served === null) {
        if (m.provider && m.model) pending.served = `${m.provider}/${m.model}`;
        pending = null;
      }
    }
  }
  return turns;
}

/** Decision-log records as rows; the record text itself is not kept. */
export function readDecisions(path: string, bounds: Bounds): DecisionRow[] {
  const rows: DecisionRow[] = [];
  for (const rec of parseLines(path) as Array<Record<string, any>>) {
    const sha = rec?.input?.sha;
    const ts = Date.parse(rec?.ts);
    if (typeof sha !== 'string' || Number.isNaN(ts) || !inBounds(ts, bounds)) continue;
    rows.push({
      ts,
      sha,
      stage: String(rec.stage ?? ''),
      category: rec.final?.category ?? null,
      group: rec.final?.group ?? null,
      proc: typeof rec.proc === 'string' ? rec.proc : null,
    });
  }
  return rows;
}

const byTsThenSession = (a: SessionTurn, b: SessionTurn) =>
  a.session.localeCompare(b.session) || a.ts - b.ts || a.sha.localeCompare(b.sha);

/** Join turns with their routing decisions and compute switches per session. */
export function joinTurns(
  turns: SessionTurn[],
  decisions: DecisionRow[],
  window: JoinWindow = DEFAULT_WINDOW,
): JoinedTurn[] {
  const routing = new Map<string, DecisionRow[]>();
  for (const d of decisions) {
    if (NON_ROUTING_STAGES.has(d.stage)) continue;
    const list = routing.get(d.sha) ?? [];
    list.push(d);
    routing.set(d.sha, list);
  }

  const ordered = [...turns].sort(byTsThenSession);
  const lastServed = new Map<string, string>();
  return ordered.map((t) => {
    const hits = (routing.get(t.sha) ?? []).filter(
      (d) => d.ts >= t.ts - window.beforeMs && d.ts <= t.ts + window.afterMs,
    );
    const status: JoinedTurn['status'] = hits.length === 1 ? 'matched' : hits.length === 0 ? 'unmatched' : 'ambiguous';
    const prev = lastServed.get(t.session);
    const switched = t.served !== null && prev !== undefined ? t.served !== prev : null;
    if (t.served !== null) lastServed.set(t.session, t.served);
    return {
      ...t,
      status,
      category: status === 'matched' ? hits[0].category : null,
      group: status === 'matched' ? hits[0].group : null,
      switched,
      decisionTs: status === 'matched' ? hits[0].ts : null,
      proc: status === 'matched' ? (hits[0].proc ?? null) : null,
    };
  });
}

export interface JoinSummary {
  turns: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  byCategory: Record<string, { turns: number; switches: number }>;
}

export function summarizeJoin(joined: JoinedTurn[]): JoinSummary {
  const s: JoinSummary = { turns: joined.length, matched: 0, ambiguous: 0, unmatched: 0, byCategory: {} };
  for (const j of joined) {
    s[j.status === 'matched' ? 'matched' : j.status === 'ambiguous' ? 'ambiguous' : 'unmatched'] += 1;
    if (j.status !== 'matched' || j.category === null) continue;
    const c = (s.byCategory[j.category] ??= { turns: 0, switches: 0 });
    c.turns += 1;
    if (j.switched === true) c.switches += 1;
  }
  return s;
}

function fingerprint(joined: JoinedTurn[]): string {
  const rows = joined.map((j) => [j.session, j.ts, j.sha, j.status, j.category, j.group, j.served, j.switched]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
}

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

/** pi names a session directory after the working directory: /a/b -> --a-b-- */
function defaultSessionsDir(): string {
  const encoded = process.cwd().replace(/^\//, '').replace(/\//g, '-');
  return join(homedir(), '.pi', 'agent', 'sessions', `--${encoded}--`);
}

function main(): void {
  const sessions = arg('sessions') ?? defaultSessionsDir();
  const log = arg('log') ?? join(homedir(), '.pi', 'logs', 'classifier-decisions.jsonl');
  const bounds: Bounds = {};
  const since = arg('since');
  const until = arg('until');
  if (since) bounds.since = Date.parse(since);
  if (until) bounds.until = Date.parse(until);

  const joined = joinTurns(readSessionTurns(sessions, bounds), readDecisions(log, bounds));
  const s = summarizeJoin(joined);
  console.log(`bounds: since=${since ?? '-'} until=${until ?? '-'}`);
  console.log(`turns=${s.turns} matched=${s.matched} ambiguous=${s.ambiguous} unmatched=${s.unmatched}`);
  console.log(`fingerprint=${fingerprint(joined)}`);
  for (const [cat, c] of Object.entries(s.byCategory).sort()) {
    console.log(`  ${cat.padEnd(14)} turns=${c.turns} switches=${c.switches}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('turn-decision-join.ts')) main();
