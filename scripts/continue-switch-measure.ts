// `continue` model-switch measurement
// (docs/plans/2026-10-26-continue-keeps-model.md, Step 1).
//
//   npx tsx scripts/continue-switch-measure.ts
//       [--sessions=<dir>] [--logs=<f1>,<f2>] [--routerlog=<f1>,<f2>]
//       [--since=<iso>] [--until=<iso>] [--window-sec=<n>] [--cause-sec=<n>]
//
// Question: how often does a `continue` turn serve a DIFFERENT model than the
// turn before it, and what explains the switch? The plan's premise is that
// these switches are ranking changes — nothing new was said, but health
// demotion, pacing or a cost tie moved the group's ranking — and that they
// cost a cold prompt cache. The cause split checks that premise instead of
// assuming it: a router.log line naming the previous model (rate limit,
// breaker, context window) in a window before the turn explains the switch;
// a switch with no such line is the ranking-change bucket.
//
// Reproducibility (the lesson of the 2026-10-27 attempt,
// docs/research/2026-10-27-continue-switch-measurement.md): this script is
// committed, the join is the same one as turn-decision-join.ts (prompt hash +
// time window), and the report prints the exact bounds. Pass the same
// --since/--until to reproduce a number.
//
// The report contains counts and category names only. Prompt text and hashes
// are never printed.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readDecisionLog } from './lib/decision-log.ts';
import { isRoutingRecord } from '../src/classifier-decision-log.ts';
import {
  readSessionTurns,
  DEFAULT_WINDOW,
  type Bounds,
  type SessionTurn,
} from './turn-decision-join.ts';
import { arg, invokedDirectly } from './lib/cli.ts';

/** A routing decision with the pre-inheritance category, from one or more (rotated) log files. */
export interface RoutingRow {
  ts: number;
  sha: string;
  /** The classifier's raw answer — `continue` before inheritPreviousCategory replaces it. */
  rawCategory: string | null;
  finalCategory: string | null;
  group: string | null;
}

/**
 * Routing records from every given log file, in file order. Pool records carry
 * no prompt hash and never route; the comparator stage is the detached
 * background snapshot and never routes either (same rules as the join).
 */
export function readRoutingRows(paths: string[], bounds: Bounds = {}): RoutingRow[] {
  const rows: RoutingRow[] = [];
  for (const path of paths) {
    for (const row of readDecisionLog(path, bounds)) {
      if (!isRoutingRecord(row.record) || row.sha === null) continue;
      rows.push({
        ts: row.ts,
        sha: row.sha,
        rawCategory: row.record.raw?.category ?? null,
        finalCategory: row.category,
        group: row.group,
      });
    }
  }
  return rows;
}

/** A router.log line: leading ISO timestamp plus the rest of the line. */
export interface RouterLine {
  ts: number;
  text: string;
}

/** Parses the `2026-11-07T15:39:14.159Z  [tags] message` shape; other lines are skipped. */
export function parseRouterLogLines(path: string, bounds: Bounds = {}): RouterLine[] {
  const out: RouterLine[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const ts = Date.parse(line.slice(0, 24));
    if (Number.isNaN(ts)) continue;
    if (bounds.since !== undefined && ts < bounds.since) continue;
    if (bounds.until !== undefined && ts > bounds.until) continue;
    out.push({ ts, text: line.slice(24) });
  }
  return out;
}

export type SwitchCause = 'limit' | 'breaker' | 'overflow' | 'unexplained';

const CAUSE_PATTERNS: Array<{ cause: SwitchCause; re: RegExp }> = [
  // The pre-flight breaker narration ("looks wedged") and the cooldown skip.
  { cause: 'breaker', re: /looks wedged|breaker/i },
  { cause: 'limit', re: /rate limit|backing off|still failing after waiting/i },
  { cause: 'overflow', re: /context window/i },
];

/**
 * What explains a model switch on a turn: the first matching router.log line
 * in the window before the turn that names the previous model. No such line
 * means `unexplained` — the ranking-change bucket the plan targets (a switch
 * with no failure behind it is exactly what model stickiness would prevent).
 */
export function classifySwitchCause(
  lines: RouterLine[],
  turnTs: number,
  previousModel: string,
  opts: { beforeMs: number }
): SwitchCause {
  for (const { ts, text } of lines) {
    if (ts < turnTs - opts.beforeMs || ts > turnTs) continue;
    if (!text.includes(previousModel)) continue;
    for (const { cause, re } of CAUSE_PATTERNS) {
      if (re.test(text)) return cause;
    }
  }
  return 'unexplained';
}

export type PairKind = 'continue' | 'other' | 'unmatched';

export interface TurnPair {
  session: string;
  ts: number;
  kind: PairKind;
  /** The model served by the previous turn (the one kept or lost). */
  previousModel: string;
  served: string;
  switched: boolean;
  group: string | null;
  /** True when the current turn's routed group differs from the previous
   * turn's — a switch across groups is a classifier decision, not a ranking
   * change, and is out of the plan's scope. Null when either group is
   * unknown (unmatched turns). */
  groupChanged: boolean | null;
}

/**
 * Pairs of consecutive turns of one session whose served models are both
 * known. The kind is the CURRENT turn's raw category — `continue` is what the
 * classifier answered before the inheritance replaced it; a turn without a
 * matched decision has no kind and is excluded from the kind split.
 */
export function measurePairs(
  turns: SessionTurn[],
  decisions: RoutingRow[],
  window: { beforeMs: number; afterMs: number } = DEFAULT_WINDOW
): TurnPair[] {
  const routing = new Map<string, RoutingRow[]>();
  for (const d of decisions) {
    const list = routing.get(d.sha) ?? [];
    list.push(d);
    routing.set(d.sha, list);
  }
  const lastServed = new Map<string, string>();
  const lastGroup = new Map<string, string | null>();
  const pairs: TurnPair[] = [];
  for (const t of [...turns].sort((a, b) => a.session.localeCompare(b.session) || a.ts - b.ts)) {
    const prev = lastServed.get(t.session);
    const prevGroup = lastGroup.get(t.session);
    const hits = (routing.get(t.sha) ?? []).filter(
      (d) => d.ts >= t.ts - window.beforeMs && d.ts <= t.ts + window.afterMs
    );
    const group = hits.length === 1 ? hits[0].group : null;
    if (t.served !== null) lastServed.set(t.session, t.served);
    lastGroup.set(t.session, group);
    if (prev === undefined || t.served === null) continue;
    const matched = hits.length === 1;
    pairs.push({
      session: t.session,
      ts: t.ts,
      kind: matched ? (hits[0].rawCategory === 'continue' ? 'continue' : 'other') : 'unmatched',
      previousModel: prev,
      served: t.served,
      switched: t.served !== prev,
      group,
      groupChanged: matched && prevGroup !== undefined ? group !== prevGroup : null,
    });
  }
  return pairs;
}

export interface PairSummary {
  byKind: Record<
    PairKind,
    {
      pairs: number;
      switches: number;
      causes: Partial<Record<SwitchCause, number>>;
      /** Switches whose routed group changed between the turns. */
      groupChangedSwitches: number;
      /** Switches inside the same routed group — the plan's target set. */
      sameGroupSwitches: number;
    }
  >;
}

/** Counts per kind, with the cause split for the switches (needs the router.log lines). */
export function summarizePairs(
  pairs: TurnPair[],
  routerLines: RouterLine[] = [],
  causeBeforeMs = 45_000
): PairSummary {
  const byKind: PairSummary['byKind'] = {
    continue: { pairs: 0, switches: 0, causes: {}, groupChangedSwitches: 0, sameGroupSwitches: 0 },
    other: { pairs: 0, switches: 0, causes: {}, groupChangedSwitches: 0, sameGroupSwitches: 0 },
    unmatched: { pairs: 0, switches: 0, causes: {}, groupChangedSwitches: 0, sameGroupSwitches: 0 },
  };
  for (const p of pairs) {
    const k = byKind[p.kind];
    k.pairs += 1;
    if (!p.switched) continue;
    k.switches += 1;
    if (p.groupChanged === true) k.groupChangedSwitches += 1;
    if (p.groupChanged === false) k.sameGroupSwitches += 1;
    const cause = classifySwitchCause(routerLines, p.ts, p.previousModel, {
      beforeMs: causeBeforeMs,
    });
    k.causes[cause] = (k.causes[cause] ?? 0) + 1;
  }
  return { byKind };
}

function splitArg(name: string): string[] {
  const v = arg(name);
  return v ? v.split(',').filter((s) => s.length > 0) : [];
}

function main(): void {
  const sessions =
    arg('sessions') ??
    join(
      homedir(),
      '.pi',
      'agent',
      'sessions',
      `--${process.cwd().replace(/^\//, '').replace(/\//g, '-')}--`
    );
  const logs = splitArg('logs') ?? [join(homedir(), '.pi', 'logs', 'classifier-decisions.jsonl')];
  const routerLogs = splitArg('routerlog') ?? [join(homedir(), '.pi', 'logs', 'router.log')];
  const bounds: Bounds = {};
  const since = arg('since');
  const until = arg('until');
  if (since) bounds.since = Date.parse(since);
  if (until) bounds.until = Date.parse(until);
  const causeSec = Number(arg('cause-sec') ?? 45);

  const turns = readSessionTurns(sessions, bounds);
  const decisions = readRoutingRows(logs, bounds);
  const pairs = measurePairs(turns, decisions);
  const routerLines = routerLogs.flatMap((p) => parseRouterLogLines(p, bounds));
  const s = summarizePairs(pairs, routerLines, causeSec * 1000);

  console.log(`bounds: since=${since ?? '-'} until=${until ?? '-'} cause-window=${causeSec}s`);
  console.log(`turns=${turns.length} routing-rows=${decisions.length} pairs=${pairs.length}`);
  for (const kind of ['continue', 'other', 'unmatched'] as const) {
    const k = s.byKind[kind];
    const causes = Object.entries(k.causes)
      .sort()
      .map(([c, n]) => `${c}=${n}`)
      .join(' ');
    console.log(
      `  ${kind.padEnd(10)} pairs=${k.pairs} switches=${k.switches} same-group=${k.sameGroupSwitches} group-changed=${k.groupChangedSwitches}${causes ? ` (${causes})` : ''}`
    );
  }
}

if (invokedDirectly(import.meta.url)) main();
