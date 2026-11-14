// src/classifier-summary.ts — ADR-0027 Phase 5: `/router classifier [days]`.
//
// Reads the classifier decision log (`~/.pi/logs/classifier-decisions.jsonl`)
// and summarises the routing decisions of a time window. The summary survives
// restarts because it reads the file, not the in-memory counters. Pure
// functions (`parseDecisionLogText`, `summarizeClassifierLog`,
// `formatClassifierSummary`) carry the logic; `readClassifierSummary` is the
// only function that touches the file system.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  decisionLogPath,
  isRoutingRecord,
  type DecisionRecord,
} from './classifier-decision-log.ts';

export const DEFAULT_SUMMARY_DAYS = 7;
export const MAX_SUMMARY_DAYS = 90;
const DAY_MS = 86_400_000;

export interface ClassifierSummary {
  days: number;
  /** Routing records in the window (observation/comparator/pool records excluded). */
  total: number;
  /** Stage counts, most frequent first. */
  stages: Array<[string, number]>;
  /** Records whose raw model answer was `fallback`, before post-processing. */
  rawUnresolved: { count: number; of: number };
  /** Records still `fallback` after post-processing (inheritance applied). */
  finalUnresolved: { count: number; of: number };
  /** Failed chain attempts out of all attempts (skips included). */
  chainAttempts: { failed: number; total: number };
  /** Nearest-rank percentiles of the classification time; null without records. */
  latencyMs: { p50: number; p95: number } | null;
  /** Laya said X, the chain decided Y, Laya did not act. Top 5 by count. */
  disagreements: Array<{ pair: string; count: number }>;
}

/**
 * Records of the log text that fall inside the window. Blank lines, torn lines,
 * non-object JSON and records with an unparseable `ts` are skipped: the log is
 * appended to while it is read, so a torn last line is normal.
 */
export function parseDecisionLogText(text: string, bounds: { sinceMs: number }): DecisionRecord[] {
  const out: DecisionRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const rec = parsed as DecisionRecord;
    const ts = Date.parse(String(rec.ts));
    if (Number.isNaN(ts) || ts < bounds.sinceMs) continue;
    out.push(rec);
  }
  return out;
}

/** Nearest-rank percentile of an ascending-sorted, non-empty list. */
function nearestRank(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarizeClassifierLog(
  records: DecisionRecord[],
  opts: { nowMs: number; days: number }
): ClassifierSummary {
  const routing = records.filter((r) => isRoutingRecord(r));
  const stageCounts = new Map<string, number>();
  let rawUnresolved = 0;
  let finalUnresolved = 0;
  let attemptsFailed = 0;
  let attemptsTotal = 0;
  const latencies: number[] = [];
  const pairCounts = new Map<string, number>();

  for (const r of routing) {
    stageCounts.set(r.stage, (stageCounts.get(r.stage) ?? 0) + 1);
    if (r.raw?.category === 'fallback') rawUnresolved++;
    if (r.final?.category === 'fallback') finalUnresolved++;
    for (const a of r.chain ?? []) {
      attemptsTotal++;
      if (a.outcome === 'failed') attemptsFailed++;
    }
    if (typeof r.ms === 'number') latencies.push(r.ms);
    if (r.laya?.acted === false) {
      const chainCategory = r.final?.category ?? 'none';
      if (r.laya.category !== chainCategory) {
        const pair = `${r.laya.category} -> ${chainCategory}`;
        pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
      }
    }
  }

  latencies.sort((a, b) => a - b);
  return {
    days: opts.days,
    total: routing.length,
    stages: [...stageCounts.entries()].sort((a, b) => b[1] - a[1]),
    rawUnresolved: { count: rawUnresolved, of: routing.length },
    finalUnresolved: { count: finalUnresolved, of: routing.length },
    chainAttempts: { failed: attemptsFailed, total: attemptsTotal },
    latencyMs:
      latencies.length === 0
        ? null
        : { p50: nearestRank(latencies, 50), p95: nearestRank(latencies, 95) },
    disagreements: [...pairCounts.entries()]
      .map(([pair, count]) => ({ pair, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}

function percentText(part: number, of: number): string {
  return of === 0 ? '—' : `${((part / of) * 100).toFixed(1)} %`;
}

export function formatClassifierSummary(s: ClassifierSummary, days: number): string[] {
  if (s.total === 0) {
    return [`Classifier: no routing decisions in the last ${days} days.`];
  }
  const lines = [
    `Classifier decisions, last ${days} days: ${s.total}`,
    `Stages: ${s.stages.map(([stage, n]) => `${stage} ${n}`).join(', ')}`,
    `raw fallback: ${percentText(s.rawUnresolved.count, s.rawUnresolved.of)} (${s.rawUnresolved.count} of ${s.rawUnresolved.of})`,
    `after inheritance: ${percentText(s.finalUnresolved.count, s.finalUnresolved.of)} (${s.finalUnresolved.count} of ${s.finalUnresolved.of})`,
    `Chain attempts failed: ${s.chainAttempts.failed} of ${s.chainAttempts.total}` +
      (s.chainAttempts.total
        ? ` (${percentText(s.chainAttempts.failed, s.chainAttempts.total)})`
        : ''),
  ];
  lines.push(
    s.latencyMs
      ? `Classification time p50 / p95: ${s.latencyMs.p50} ms / ${s.latencyMs.p95} ms`
      : 'Classification time: no data'
  );
  if (s.disagreements.length === 0) {
    lines.push('Laya disagreements: none in the window (or Laya did not answer).');
  } else {
    lines.push('Top Laya disagreements (Laya did not act):');
    for (const d of s.disagreements) lines.push(`  ${d.count}× ${d.pair}`);
  }
  return lines;
}

/** Parses the `[days]` argument: default 7, integer 1..90, otherwise null. */
export function parseSummaryDays(arg: string): number | null {
  const trimmed = arg.trim();
  if (!trimmed) return DEFAULT_SUMMARY_DAYS;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 && n <= MAX_SUMMARY_DAYS ? n : null;
}

/** Reads the decision log of the owner's home and returns the summary lines. */
export function readClassifierSummary(days: number, nowMs = Date.now()): string[] {
  let text = '';
  try {
    text = readFileSync(decisionLogPath(homedir()), 'utf8');
  } catch {
    // No log yet (classifier logging off or nothing routed): an empty window.
  }
  const records = parseDecisionLogText(text, { sinceMs: nowMs - days * DAY_MS });
  return formatClassifierSummary(summarizeClassifierLog(records, { nowMs, days }), days);
}
