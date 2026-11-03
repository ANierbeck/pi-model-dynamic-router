// scripts/lib/decision-log.ts — one reader for the classifier decision log
// (hygiene Phase 5 Step 1, docs/plans/2026-10-29-repo-hygiene.md).
//
// Six scripts each declared their own record type and their own JSONL reader
// for the same file (turn-decision-join, failover-walk, pool-replay,
// laya-pair-stats, laya-shadow-stats, classifier-replay). They disagreed on
// the details that matter: some skipped a malformed line, some threw; some
// honoured bounds, some did not; pool records have no `input` at all. One
// reader with one contract is the fix.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDecisionLog, readDecisionLogRecords, NON_ROUTING_STAGES } from '../scripts/lib/decision-log.ts';

function withLog(lines: string[], fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'decision-log-'));
  const path = join(dir, 'classifier-decisions.jsonl');
  try {
    writeFileSync(path, lines.join('\n'));
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rec = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    ts: '2026-11-01T10:00:00.000Z',
    proc: 'proj/123',
    stage: 'llm-cloud',
    answered_by: 'prov/m',
    chain: [],
    cache_origin: null,
    raw: { category: 'standard', confidence: 0.9, reason: null },
    prev: null,
    final: { category: 'standard', group: 'standard', hint: null, reason: null },
    steps: [],
    ms: 12,
    input: { sha: 'abcdef123456', chars: 40 },
    ...over,
  });

describe('readDecisionLog', () => {
  it('parses records and skips a torn last line instead of throwing', () => {
    withLog([rec(), '{"v":1,"ts":"2026-11-01T10:00:01.000Z"', ''], (path) => {
      const rows = readDecisionLog(path, {});
      expect(rows).toHaveLength(1);
      expect(rows[0]!.stage).toBe('llm-cloud');
    });
  });

  it('honours since/until bounds on the record timestamp', () => {
    withLog(
      [
        rec({ ts: '2026-11-01T09:00:00.000Z' }),
        rec({ ts: '2026-11-01T10:00:00.000Z' }),
        rec({ ts: '2026-11-01T11:00:00.000Z' }),
      ],
      (path) => {
        const rows = readDecisionLog(path, {
          since: Date.parse('2026-11-01T09:30:00.000Z'),
          until: Date.parse('2026-11-01T10:30:00.000Z'),
        });
        expect(rows.map((r) => new Date(r.ts).toISOString())).toEqual(['2026-11-01T10:00:00.000Z']);
      }
    );
  });

  it('keeps a pool record, which has no input block at all', () => {
    // The pool record (docs/research/2026-10-27-pool-replay.md) carries refs
    // and metrics, no prompt: a reader that requires `input.sha` drops it.
    const pool = JSON.stringify({
      v: 1,
      ts: '2026-11-01T10:00:02.000Z',
      proc: 'proj/123',
      stage: 'pool',
      group: 'standard',
      method: 'tiered',
      candidates: [],
    });
    withLog([rec(), pool], (path) => {
      const rows = readDecisionLog(path, {});
      expect(rows.map((r) => r.stage)).toEqual(['llm-cloud', 'pool']);
      expect(rows[1]!.sha).toBeNull();
    });
  });

  it('drops a record whose ts cannot be parsed even without bounds', () => {
    // PR #85 review round, Important 1: the old per-script loops in
    // turn-decision-join and pool-replay ALWAYS dropped an unparseable ts, not
    // only when bounds were given. A DecisionRow with ts NaN breaks every
    // sort and window downstream, so the row reader drops it — while the raw
    // reader keeps it (classifier-replay and laya-pair-stats never checked ts
    // and must not lose records).
    const torn = JSON.stringify({ v: 1, ts: 'not-a-date', stage: 'llm-cloud', final: { category: 'standard', group: 'standard' } });
    withLog([rec(), torn], (path) => {
      expect(readDecisionLog(path, {})).toHaveLength(1);
      expect(readDecisionLogRecords(path, {})).toHaveLength(2);
    });
  });

  it('skips a line that is valid JSON but not an object', () => {
    withLog(['42', '"a string"', rec()], (path) => {
      expect(readDecisionLog(path, {})).toHaveLength(1);
    });
  });

  it('re-exports the non-routing stages so callers do not re-declare them', () => {
    expect(NON_ROUTING_STAGES.has('pool')).toBe(true);
    expect(NON_ROUTING_STAGES.has('comparator')).toBe(true);
    expect(NON_ROUTING_STAGES.has('llm-cloud')).toBe(false);
  });

  it('readDecisionLogRecords returns the raw records for scripts that need more than the summary', () => {
    withLog([rec({ stage: 'cache' })], (path) => {
      const raw = readDecisionLogRecords(path);
      expect(raw).toHaveLength(1);
      expect(raw[0]!.final.group).toBe('standard');
    });
  });
});
