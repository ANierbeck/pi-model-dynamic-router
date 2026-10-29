// Failover walk per routed turn (docs/research/2026-10-28-failover-walk-baseline.md).
//
//   npx tsx scripts/failover-walk.ts [--log=<router.log>] [--decisions=<file>]
//                                     [--since=<iso>] [--until=<iso>]
//
// For every routed decision the walk is the sequence of stream attempts the
// router made for that process, from the decision until the first
// `[stream] <ref> finished` (or until the next decision of the same process,
// or ten minutes). A turn without a success is `no-success`.
// `firstAttempt` is the observed first choice; `erstwahl` is the first
// candidate of the pool the router logged for the decided group, a cross-check
// that is often absent (pool lines are written on recompute only).
//
// Limits (stated in the research note): an attempt that belongs to a
// cross-group cascade is attributed to the decided group; the walk stops at the
// first success, so later steps of a tool loop are not counted.
//
// The report prints counts and model refs only, never prompt text.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseRoutingLine } from './route-pool-log.ts';

export interface WalkDecision {
  ts: number;
  proc: string;
  group: string | null;
  stage: string;
}

export interface WalkRow {
  ts: number;
  proc: string;
  group: string;
  /** The first stream attempt of the turn: the router's observed first choice. */
  firstAttempt: string | null;
  /** First candidate of the logged pool — a cross-check, null when no pool line is in reach. */
  erstwahl: string | null;
  /** `turn`: the pool was logged during the turn; `earlier`: last logged pool of the group, up to 30 min before. */
  erstwahlSource: 'turn' | 'earlier' | null;
  attempts: string[];
  success: string | null;
  outcome: 'success' | 'no-success';
}

/** Longest window after a decision when no later decision of the process follows. */
const MAX_WINDOW_MS = 10 * 60_000;
/** A pool line this long before the decision still belongs to it (logged during resolve). */
const POOL_LEAD_MS = 5_000;
/** The router logs a pool line only when it recomputes a pool; an older one is a stale guess beyond this. */
const POOL_STALE_MS = 30 * 60_000;

type Event =
  | { kind: 'try'; ts: number; proc: string; ref: string }
  | { kind: 'done'; ts: number; proc: string; ref: string }
  | { kind: 'pool'; ts: number; proc: string; group: string; first: string | null };

const LINE = /^(\S+)\s+\[([^\]]+)\]\s+(.*)$/;

/** Events of the router log lines the walk needs; everything else is skipped. */
export function parseWalkEvents(lines: string[]): Event[] {
  const out: Event[] = [];
  for (const line of lines) {
    const pool = parseRoutingLine(line);
    if (pool) {
      out.push({ kind: 'pool', ts: pool.ts, proc: pool.proc, group: pool.group, first: pool.candidates[0]?.ref ?? null });
      continue;
    }
    const m = line.match(LINE);
    if (!m) continue;
    const [, iso, tag, msg] = m;
    const ts = Date.parse(iso);
    if (Number.isNaN(ts) || !tag.includes('/')) continue; // only lines of a process tag (project/pid)
    const try_ = msg.match(/^\[diag\] tryStream streaming "([^"]+)"/);
    if (try_) {
      out.push({ kind: 'try', ts, proc: tag, ref: try_[1] });
      continue;
    }
    const done = msg.match(/^\[stream\] (\S+) finished/);
    if (done) out.push({ kind: 'done', ts, proc: tag, ref: done[1] });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export function walkDecisions(lines: string[], decisions: WalkDecision[]): WalkRow[] {
  const events = parseWalkEvents(lines);
  const routed = decisions
    .filter((d) => d.group !== null && d.stage !== 'comparator' && d.stage !== 'pool')
    .sort((a, b) => a.ts - b.ts);
  const rows: WalkRow[] = [];
  for (const d of routed) {
    const group = d.group as string;
    const next = routed.find((o) => o.proc === d.proc && o.ts > d.ts);
    const end = next ? next.ts : d.ts + MAX_WINDOW_MS;
    const own = events.filter((e) => e.proc === d.proc && e.ts >= d.ts - POOL_LEAD_MS && e.ts < end);
    const pool = own.find((e) => e.kind === 'pool' && e.group === group && e.ts >= d.ts - POOL_LEAD_MS);
    const earlier = pool
      ? undefined
      : events
          .filter((e): e is Extract<Event, { kind: 'pool' }> => e.kind === 'pool' && e.proc === d.proc && e.group === group)
          .filter((e) => e.ts < d.ts - POOL_LEAD_MS && e.ts >= d.ts - POOL_STALE_MS)
          .pop();
    const chosen = pool ?? earlier;
    const done = own.find((e) => e.kind === 'done' && e.ts >= d.ts);
    const tries = own.filter((e): e is Extract<Event, { kind: 'try' }> => e.kind === 'try' && e.ts >= d.ts);
    const walk = done ? tries.filter((e) => e.ts <= done.ts) : tries;
    rows.push({
      ts: d.ts,
      proc: d.proc,
      group,
      firstAttempt: walk[0]?.ref ?? null,
      erstwahl: chosen?.kind === 'pool' ? chosen.first : null,
      erstwahlSource: chosen ? (pool ? 'turn' : 'earlier') : null,
      attempts: walk.map((e) => e.ref),
      success: done?.kind === 'done' ? done.ref : null,
      outcome: done ? 'success' : 'no-success',
    });
  }
  return rows;
}

/** Per-group summary: how often the first choice served the turn, and how far the walk went. */
export function summarizeWalk(rows: WalkRow[]) {
  const groups: Record<string, { turns: number; success: number; firstChoiceServed: number; firstAttemptFailed: number; noPool: number; poolEarlier: number; maxAttempts: number; attemptsSum: number }> = {};
  for (const r of rows) {
    const g = (groups[r.group] ??= { turns: 0, success: 0, firstChoiceServed: 0, firstAttemptFailed: 0, noPool: 0, poolEarlier: 0, maxAttempts: 0, attemptsSum: 0 });
    g.turns++;
    g.attemptsSum += r.attempts.length;
    g.maxAttempts = Math.max(g.maxAttempts, r.attempts.length);
    if (r.erstwahl === null) g.noPool++;
    if (r.erstwahlSource === 'earlier') g.poolEarlier++;
    if (r.outcome === 'success') {
      g.success++;
      if (r.firstAttempt !== null && r.success === r.firstAttempt) g.firstChoiceServed++;
    }
    if (r.firstAttempt !== null && r.firstAttempt !== r.success) g.firstAttemptFailed++;
  }
  return groups;
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function main(): void {
  const logPath = arg('log') ?? join(homedir(), '.pi/logs/router.log');
  const decPath = arg('decisions') ?? join(homedir(), '.pi/logs/classifier-decisions.jsonl');
  const since = arg('since') ? Date.parse(arg('since') as string) : -Infinity;
  const until = arg('until') ? Date.parse(arg('until') as string) : Infinity;
  const lines = readFileSync(logPath, 'utf8').split('\n');
  const decisions: WalkDecision[] = [];
  for (const l of readFileSync(decPath, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let r: any;
    try {
      r = JSON.parse(l);
    } catch {
      continue;
    }
    const ts = Date.parse(r.ts);
    if (Number.isNaN(ts) || ts < since || ts > until || typeof r.proc !== 'string') continue;
    decisions.push({ ts, proc: r.proc, group: r.final?.group ?? null, stage: String(r.stage ?? '') });
  }
  const rows = walkDecisions(lines, decisions);
  console.log(`bounds: since=${arg('since') ?? '-'} until=${arg('until') ?? '-'}`);
  console.log(`routed turns=${rows.length} success=${rows.filter((r) => r.outcome === 'success').length}`);
  for (const [g, s] of Object.entries(summarizeWalk(rows))) {
    console.log(
      `  ${g.padEnd(14)} turns=${s.turns} success=${s.success} firstChoiceServed=${s.firstChoiceServed} firstAttemptFailed=${s.firstAttemptFailed} noPool=${s.noPool} poolEarlier=${s.poolEarlier} attempts(avg/max)=${(s.attemptsSum / s.turns).toFixed(2)}/${s.maxAttempts}`,
    );
  }
}

if (process.argv[1]?.endsWith('failover-walk.ts')) main();
