// One reader for the classifier decision log
// (hygiene Phase 5 Step 1, docs/plans/2026-10-29-repo-hygiene.md).
//
// Before this module, six scripts each carried their own record type and their
// own JSONL loop for the same file, and they disagreed: some skipped a
// malformed line, some threw; some honoured a time window, some did not;
// several required `input.sha` and silently dropped the pool records. The
// record type is owned by the writer (src/classifier-decision-log.ts) — this
// module only reads it, so there is exactly one definition.

import { readFileSync } from 'node:fs';
import type { DecisionRecord } from '../../src/classifier-decision-log.ts';

export { NON_ROUTING_STAGES, isRoutingRecord } from '../../src/classifier-decision-log.ts';
export type { DecisionRecord } from '../../src/classifier-decision-log.ts';

export interface LogBounds {
  /** Epoch ms, inclusive. */
  since?: number;
  /** Epoch ms, inclusive. */
  until?: number;
}

/**
 * Every parseable record in the file, in file order.
 *
 * Contract:
 * - a blank line is skipped;
 * - a line that is not valid JSON is skipped (the log is appended to while it
 *   is read, so a torn last line is normal, not an error);
 * - a line that parses to a non-object is skipped;
 * - a record whose `ts` is unparseable is skipped when bounds are given
 *   (it cannot be placed in time), kept otherwise.
 *
 * Pool records have no `input` block — they are returned as they are.
 */
export function readDecisionLogRecords(path: string, bounds: LogBounds = {}): DecisionRecord[] {
  const out: DecisionRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const rec = parsed as DecisionRecord;
    if (bounds.since !== undefined || bounds.until !== undefined) {
      const ts = Date.parse(String(rec.ts));
      if (Number.isNaN(ts)) continue;
      if (bounds.since !== undefined && ts < bounds.since) continue;
      if (bounds.until !== undefined && ts > bounds.until) continue;
    }
    out.push(rec);
  }
  return out;
}

/** The flat shape the join / walk / replay scripts work with. */
export interface DecisionRow {
  ts: number;
  /** Prompt hash of the record; null for records that carry no input (pool). */
  sha: string | null;
  stage: string;
  category: string | null;
  group: string | null;
  /** Process tag of the router that made the decision (`<project>/<pid>`). */
  proc: string | null;
  /** The record itself, for callers that need more than the summary. */
  record: DecisionRecord;
}

/**
 * The records as flat rows, with the same skipping rules as the raw reader,
 * plus one: a record whose `ts` cannot be parsed is dropped even when no
 * bounds are given. Every caller sorts or windows on `ts`, so a NaN row is
 * unusable — and the per-script loops this reader replaced always dropped
 * those records (PR #85 review round, Important 1). The raw reader keeps
 * them: classifier-replay and laya-pair-stats never looked at `ts` and must
 * not lose records.
 */
export function readDecisionLog(path: string, bounds: LogBounds = {}): DecisionRow[] {
  const rows: DecisionRow[] = [];
  for (const rec of readDecisionLogRecords(path, bounds)) {
    const ts = Date.parse(String(rec.ts));
    if (Number.isNaN(ts)) continue;
    rows.push({
      ts,
      sha: typeof rec.input?.sha === 'string' ? rec.input.sha : null,
      stage: String(rec.stage ?? ''),
      category: rec.final?.category ?? null,
      group: rec.final?.group ?? null,
      proc: typeof rec.proc === 'string' ? rec.proc : null,
      record: rec,
    });
  }
  return rows;
}
