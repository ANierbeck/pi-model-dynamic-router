// test/classifier-summary.test.ts — ADR-0027 Phase 5 (`/router classifier`).
// The summary reads the decision-log JSONL: stage mix, raw vs. post-inheritance
// fallback rate, chain failure rate, p50/p95 latency and the top Laya/chain
// disagreements. Pure functions, so the pins run on fixture records.

import { describe, it, expect } from 'vitest';
import {
  parseDecisionLogText,
  summarizeClassifierLog,
  formatClassifierSummary,
} from '../src/classifier-summary.ts';
import type { DecisionRecord } from '../src/classifier-decision-log.ts';

const NOW = Date.parse('2026-11-14T12:00:00Z');

function rec(over: Partial<DecisionRecord> & { stage: string }): DecisionRecord {
  const { stage, ...rest } = over;
  return {
    v: 1,
    ts: new Date(NOW - 60_000).toISOString(),
    proc: 'test',
    stage,
    answered_by: null,
    chain: [],
    cache_origin: null,
    raw: { category: 'code_simple', confidence: 0.9, reason: null },
    prev: null,
    final: { category: 'code_simple', group: 'simple', hint: null, reason: null },
    steps: [],
    ms: 100,
    input: { sha: 'x', len: 10, words: 2, lang: 'en' } as unknown as DecisionRecord['input'],
    ...rest,
  } as DecisionRecord;
}

describe('summarizeClassifierLog — routing records only', () => {
  it('counts the stage mix over routing stages and ignores observation records', () => {
    const records = [
      rec({ stage: 'llm-cloud' }),
      rec({ stage: 'llm-cloud' }),
      rec({ stage: 'cache' }),
      rec({ stage: 'observation' }),
      rec({ stage: 'comparator' }),
    ];
    const s = summarizeClassifierLog(records, { nowMs: NOW, days: 7 });
    expect(s.total).toBe(3);
    expect(s.stages).toEqual([
      ['llm-cloud', 2],
      ['cache', 1],
    ]);
  });
});

describe('summarizeClassifierLog — fallback rates', () => {
  it('reports the raw fallback rate next to the rate left after inheritance', () => {
    const records = [
      // raw fallback, rescued by inheritance (final is a real category)
      rec({
        stage: 'llm-local',
        raw: { category: 'fallback', confidence: 0.2, reason: 'low' },
        final: { category: 'design', group: 'design', hint: null, reason: null },
        steps: ['fallback-inherit'],
      }),
      // raw fallback, not rescued
      rec({
        stage: 'llm-local',
        raw: { category: 'fallback', confidence: 0.2, reason: 'low' },
        final: { category: 'fallback', group: 'standard', hint: null, reason: null },
      }),
      rec({ stage: 'llm-local' }),
      rec({ stage: 'llm-local' }),
    ];
    const s = summarizeClassifierLog(records, { nowMs: NOW, days: 7 });
    expect(s.rawUnresolved).toEqual({ count: 2, of: 4 });
    expect(s.finalUnresolved).toEqual({ count: 1, of: 4 });
  });
});

describe('summarizeClassifierLog — chain failures and latency', () => {
  it('counts failed attempts over all chain attempts', () => {
    const records = [
      rec({
        stage: 'llm-cloud',
        chain: [
          { ref: 'a/x', outcome: 'failed', why: 'timeout', ms: 5 },
          { ref: 'b/y', outcome: 'ok', ms: 5 },
        ],
      }),
      rec({ stage: 'cache', chain: [] }),
      rec({
        stage: 'llm-cloud',
        chain: [{ ref: 'b/y', outcome: 'skipped', why: 'no-credentials' }],
      }),
    ];
    const s = summarizeClassifierLog(records, { nowMs: NOW, days: 7 });
    expect(s.chainAttempts).toEqual({ failed: 1, total: 3 });
  });

  it('p50 and p95 use the nearest-rank method on the routing records', () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      rec({ stage: 'llm-cloud', ms: (i + 1) * 10 })
    );
    const s = summarizeClassifierLog(records, { nowMs: NOW, days: 7 });
    expect(s.latencyMs).toEqual({ p50: 100, p95: 190 });
  });
});

describe('summarizeClassifierLog — Laya disagreements', () => {
  it('counts Laya-vs-chain pairs only when Laya did not act and the categories differ', () => {
    const laya = (category: string, acted: boolean) => ({
      ref: 'laya:x',
      category,
      confidence: 0.9,
      acted,
      ms: 5,
    });
    const records = [
      rec({
        stage: 'llm-cloud',
        final: { category: 'design', group: 'design', hint: null, reason: null },
        laya: laya('planning', false),
      }),
      rec({
        stage: 'llm-cloud',
        final: { category: 'design', group: 'design', hint: null, reason: null },
        laya: laya('planning', false),
      }),
      // acted: not a disagreement, Laya's answer was the route
      rec({
        stage: 'laya',
        final: { category: 'planning', group: 'planning', hint: null, reason: null },
        laya: laya('planning', true),
      }),
      // Laya acted and its category differs from the chain's: still not a disagreement,
      // because Laya's answer was the route (acted: true).
      rec({
        stage: 'llm-cloud',
        final: { category: 'design', group: 'design', hint: null, reason: null },
        laya: laya('planning', true),
      }),
      // same category: no disagreement
      rec({ stage: 'llm-cloud', laya: laya('code_simple', false) }),
    ];
    const s = summarizeClassifierLog(records, { nowMs: NOW, days: 7 });
    expect(s.disagreements).toEqual([{ pair: 'planning -> design', count: 2 }]);
  });
});

describe('parseDecisionLogText — window and torn lines', () => {
  it('skips torn lines and records older than the window', () => {
    const fresh = JSON.stringify(rec({ stage: 'cache' }));
    const old = JSON.stringify(
      rec({ stage: 'cache', ts: new Date(NOW - 30 * 86_400_000).toISOString() })
    );
    const text = [fresh, '{"torn": ', '', old, '[1,2]'].join('\n');
    const kept = parseDecisionLogText(text, { sinceMs: NOW - 7 * 86_400_000 });
    expect(kept).toHaveLength(1);
    expect(kept[0]!.stage).toBe('cache');
  });
});

describe('formatClassifierSummary', () => {
  it('says so plainly when the window holds no routing decisions', () => {
    const s = summarizeClassifierLog([], { nowMs: NOW, days: 7 });
    const text = formatClassifierSummary(s, 7).join('\n');
    expect(text).toMatch(/no routing decisions in the last 7 days/);
  });

  it('shows the raw and the post-inheritance fallback rate side by side', () => {
    const records = [
      rec({
        stage: 'llm-local',
        raw: { category: 'fallback', confidence: 0.2, reason: 'low' },
        final: { category: 'design', group: 'design', hint: null, reason: null },
      }),
    ];
    const text = formatClassifierSummary(
      summarizeClassifierLog(records, { nowMs: NOW, days: 7 }),
      7
    ).join('\n');
    expect(text).toMatch(/raw fallback.*100\.0 %/);
    expect(text).toMatch(/after inheritance.*0\.0 %/);
  });
});
