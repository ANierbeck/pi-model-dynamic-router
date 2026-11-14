// src/classifier-summary.ts — ADR-0027 Phase 5: `/router classifier [days]`.
//
// Reads the classifier decision log (`~/.pi/logs/classifier-decisions.jsonl`
// and its rotated files `.1`, `.2`, …) and summarises the routing decisions of
// a time window. The summary survives restarts because it reads the files, not
// the in-memory counters. Pure functions (`parseSummaryRecords`,
// `summarizeClassifierLog`, `formatClassifierSummary`) carry the logic; the
// file system is touched only by `readLogSnapshot` and `readClassifierSummary`.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  decisionLogPath,
  isRoutingRecord,
  parseDecisionLogText,
  type DecisionRecord,
} from './classifier-decision-log.ts';

export const DEFAULT_SUMMARY_DAYS = 7;
export const MAX_SUMMARY_DAYS = 90;
const DAY_MS = 86_400_000;
/** Upper bound for the rotated-file scan (`keep` defaults to 5 in the logger). */
const MAX_ROTATED_FILES = 20;
/** Attempts before a read that keeps racing a rotation is reported as approximate. */
const READ_ATTEMPTS = 3;

export interface ClassifierSummary {
  days: number;
  /** Routing records in the window (observation/comparator/pool records excluded). */
  total: number;
  /** Stage counts, most frequent first. */
  stages: Array<[string, number]>;
  /** Records whose raw classifier answer was `continue`, before inheritance. */
  continueRaw: { count: number; of: number };
  /** Records still `continue` after inheritance (no earlier category to keep). */
  continueFinal: { count: number; of: number };
  /**
   * Records of stage `fallback`: the chain had no answer and the static
   * `continue` result was used. The retired category `fallback` never appears
   * in the log, so this counts the stage, not a category.
   */
  noAnswer: { count: number; of: number };
  /** Failed chain attempts out of all attempts (skips included). */
  chainAttempts: { failed: number; total: number };
  /** Nearest-rank percentiles of the classification time; null without records. */
  latencyMs: { p50: number; p95: number } | null;
  /** Laya said X, the chain decided Y, Laya did not act. Top 5 by count. */
  disagreements: Array<{ pair: string; count: number }>;
}

/** The fields the summary reads, checked before a record is trusted. */
function hasRecordShape(v: Record<string, unknown>): boolean {
  const isObjectOrNull = (x: unknown): boolean =>
    x === undefined || x === null || typeof x === 'object';
  return (
    typeof v.ts === 'string' &&
    typeof v.stage === 'string' &&
    (v.chain === undefined ||
      (Array.isArray(v.chain) && v.chain.every((a) => a !== null && typeof a === 'object'))) &&
    isObjectOrNull(v.raw) &&
    isObjectOrNull(v.final) &&
    isObjectOrNull(v.laya)
  );
}

/**
 * The summary's records: the shared parser's output (window, torn lines and
 * unparseable timestamps already handled there), minus records whose fields
 * have the wrong shape, so the summary cannot throw on them. Records dated
 * after `untilMs` are skipped: clock skew or a hand edit must not inflate the
 * window.
 */
export function parseSummaryRecords(
  text: string,
  bounds: { sinceMs: number; untilMs: number }
): DecisionRecord[] {
  return parseDecisionLogText(text, { since: bounds.sinceMs, until: bounds.untilMs }).filter(
    (rec) => hasRecordShape(rec as unknown as Record<string, unknown>)
  );
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
  let continueRaw = 0;
  let continueFinal = 0;
  let noAnswer = 0;
  let attemptsFailed = 0;
  let attemptsTotal = 0;
  const latencies: number[] = [];
  const pairCounts = new Map<string, number>();

  for (const r of routing) {
    stageCounts.set(r.stage, (stageCounts.get(r.stage) ?? 0) + 1);
    if (r.raw?.category === 'continue') continueRaw++;
    if (r.final?.category === 'continue') continueFinal++;
    if (r.stage === 'fallback') noAnswer++;
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
    continueRaw: { count: continueRaw, of: routing.length },
    continueFinal: { count: continueFinal, of: routing.length },
    noAnswer: { count: noAnswer, of: routing.length },
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
    `continue, raw: ${percentText(s.continueRaw.count, s.continueRaw.of)} (${s.continueRaw.count} of ${s.continueRaw.of})`,
    `continue after inheritance: ${percentText(s.continueFinal.count, s.continueFinal.of)} (${s.continueFinal.count} of ${s.continueFinal.of})`,
    `no classifier answer (chain exhausted): ${s.noAnswer.count} of ${s.noAnswer.of}`,
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

// ── file system ────────────────────────────────────────────────────────────

export interface LogSnapshot {
  /** Concatenated text of every readable file, oldest rotated file first. */
  text: string;
  /** Files that were read successfully. */
  files: number;
  /** Error code of the first failure that was not ENOENT, else null. */
  error: string | null;
  /** False when the file set kept changing (rotation) on every attempt. */
  stable: boolean;
}

function errorCode(e: unknown): string {
  return (e as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
}

/** The base file plus its contiguous rotated files `.1`, `.2`, …, oldest first. */
function logFileSet(base: string): string[] {
  const rotated: string[] = [];
  for (let i = 1; i <= MAX_ROTATED_FILES && existsSync(`${base}.${i}`); i++) {
    rotated.push(`${base}.${i}`);
  }
  // `.N` is the oldest; the base file is the newest.
  const ordered = rotated.reverse();
  if (existsSync(base)) ordered.push(base);
  return ordered;
}

/** Name and inode of each file: a rotation renames files, an append changes neither. */
function fileIdentity(files: string[]): string {
  return files
    .map((f) => {
      try {
        return `${f}:${statSync(f).ino}`;
      } catch {
        return `${f}:gone`;
      }
    })
    .join('|');
}

/**
 * Reads the base log and its rotated files. A rotation between the listing and
 * the reads would drop or repeat a file's records, so the file set is compared
 * before and after the reads, and the read is repeated when it changed.
 */
export function readLogSnapshot(base: string): LogSnapshot {
  let last: LogSnapshot = { text: '', files: 0, error: null, stable: false };
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    const files = logFileSet(base);
    const before = fileIdentity(files);
    let text = '';
    let read = 0;
    let error: string | null = null;
    for (const f of files) {
      try {
        text += readFileSync(f, 'utf8') + '\n';
        read++;
      } catch (e) {
        // A file that vanished between listing and reading is a rotation, not an error.
        const code = errorCode(e);
        if (code !== 'ENOENT' && error === null) error = code;
      }
    }
    last = { text, files: read, error, stable: fileIdentity(logFileSet(base)) === before };
    if (last.stable) return last;
  }
  return last;
}

/** Reads the decision log of the owner's home and returns the summary lines. */
export function readClassifierSummary(days: number, nowMs = Date.now()): string[] {
  const base = decisionLogPath(homedir());
  const snap = readLogSnapshot(base);
  if (snap.files === 0) {
    if (snap.error !== null) {
      return [`Classifier: decision log unreadable (${snap.error}) at ${base}.`];
    }
    return [
      `Classifier: no decision log at ${base} (classifier_log disabled, or nothing routed yet).`,
    ];
  }
  const lines: string[] = [];
  if (snap.error !== null) {
    lines.push(
      `Warning: part of the decision log is unreadable (${snap.error}); counts are partial.`
    );
  }
  if (!snap.stable) {
    lines.push('Note: the log kept rotating while it was read; counts may be off by one rotation.');
  }
  const records = parseSummaryRecords(snap.text, {
    sinceMs: nowMs - days * DAY_MS,
    untilMs: nowMs,
  });
  return [
    ...lines,
    ...formatClassifierSummary(summarizeClassifierLog(records, { nowMs, days }), days),
  ];
}
