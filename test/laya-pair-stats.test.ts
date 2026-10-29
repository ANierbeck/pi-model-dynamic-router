// Pair evaluation of the live A/B snapshot (docs/plans/2026-10-25-laya-sole-classifier.md,
// Step 2): join each `laya` record with its detached `comparator` record by
// `input.sha` and report where the two classifiers agree. Synthetic records
// only — no dependency on the real decision log.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pairRecords,
  effectiveCategory,
  observedGroupMap,
  summarizePairs,
  formatPairReport,
  wilsonInterval,
  type PairLogRecord,
} from '../scripts/laya-pair-stats.ts';

const T0 = Date.parse('2026-10-26T10:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

interface Opts {
  sha?: string;
  ts?: number;
  category: string | null;
  prev?: string | null;
  group?: string | null;
  conf?: number;
  ms?: number;
}

function laya(o: Opts): PairLogRecord {
  return {
    ts: at(o.ts ?? 0),
    stage: 'laya',
    raw: o.category === null ? null : { category: o.category, confidence: o.conf ?? 0.9, reason: 'LEAK-LAYA-REASON' },
    prev: o.prev === undefined ? null : { category: o.prev, group: null },
    final: { category: o.category, group: o.group ?? null },
    ms: o.ms ?? 100,
    laya: { category: o.category ?? 'x', confidence: o.conf ?? 0.9, acted: true, ms: o.ms ?? 100 },
    input: { sha: o.sha ?? 'aaaaaaaaaaaa', text: { prompt: 'LEAK-PROMPT-TEXT' } },
  } as PairLogRecord;
}

function cmp(o: Opts): PairLogRecord {
  return {
    ts: at(o.ts ?? 15),
    stage: 'comparator',
    raw: o.category === null ? null : { category: o.category, confidence: 1, reason: 'LEAK-CMP-REASON' },
    prev: o.prev === undefined ? null : { category: o.prev, group: null },
    final: { category: o.category, group: o.group ?? null },
    ms: o.ms ?? 900,
    input: { sha: o.sha ?? 'aaaaaaaaaaaa', text: { prompt: 'LEAK-PROMPT-TEXT' } },
  } as PairLogRecord;
}

describe('pairRecords', () => {
  it('joins laya and comparator by input.sha, comparator after laya', () => {
    const { pairs, unpairedLaya, orphanComparators } = pairRecords([
      laya({ sha: 's1', category: 'design', ts: 0 }),
      cmp({ sha: 's1', category: 'design', ts: 15 }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].laya.input.sha).toBe('s1');
    expect(unpairedLaya).toBe(0);
    expect(orphanComparators).toBe(0);
  });

  it('pairs a repeated prompt (same sha) in order, each comparator used once', () => {
    const { pairs, unpairedLaya, orphanComparators } = pairRecords([
      laya({ sha: 's1', category: 'standard', ts: 0 }),
      cmp({ sha: 's1', category: 'standard', ts: 15 }),
      laya({ sha: 's1', category: 'design', ts: 100 }),
      cmp({ sha: 's1', category: 'planning', ts: 115 }),
    ]);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].comparator.raw?.category).toBe('standard');
    expect(pairs[1].comparator.raw?.category).toBe('planning');
    expect(unpairedLaya + orphanComparators).toBe(0);
  });

  it('uses a comparator at most once: two close laya records of one prompt, one comparator', () => {
    const { pairs, unpairedLaya } = pairRecords([
      laya({ sha: 's1', category: 'design', ts: 0 }),
      laya({ sha: 's1', category: 'design', ts: 5 }),
      cmp({ sha: 's1', category: 'design', ts: 15 }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(unpairedLaya).toBe(1);
  });

  it('does not pair a comparator that precedes its laya record', () => {
    const { pairs, unpairedLaya, orphanComparators } = pairRecords([
      cmp({ sha: 's1', category: 'design', ts: 5 }),
      laya({ sha: 's1', category: 'design', ts: 10 }),
    ]);
    expect(pairs).toHaveLength(0);
    expect(unpairedLaya).toBe(1);
    expect(orphanComparators).toBe(1);
  });

  it('does not pair across the time window', () => {
    const { pairs, unpairedLaya, orphanComparators } = pairRecords(
      [
        laya({ sha: 's1', category: 'design', ts: 0 }),
        cmp({ sha: 's1', category: 'design', ts: 600 }),
      ],
      300_000,
    );
    expect(pairs).toHaveLength(0);
    expect(unpairedLaya).toBe(1);
    expect(orphanComparators).toBe(1);
  });

  it('ignores laya records that did not act and other stages', () => {
    const notActed = laya({ sha: 's1', category: 'design' });
    (notActed.laya as { acted: boolean }).acted = false;
    const { pairs, unpairedLaya } = pairRecords([
      notActed,
      { ...laya({ sha: 's2', category: 'design' }), stage: 'hint' } as PairLogRecord,
      cmp({ sha: 's1', category: 'design' }),
    ]);
    expect(pairs).toHaveLength(0);
    expect(unpairedLaya).toBe(0);
  });
});

describe('effectiveCategory', () => {
  it('resolves continue to the previous category, like the router does', () => {
    expect(effectiveCategory(laya({ category: 'continue', prev: 'design' }))).toBe('design');
  });
  it('keeps continue when there is no usable predecessor', () => {
    expect(effectiveCategory(cmp({ category: 'continue', prev: null }))).toBe('continue');
    expect(effectiveCategory(cmp({ category: 'continue', prev: 'continue' }))).toBe('continue');
  });
  it("uses the classifier's own answer (raw), not the post-processed final", () => {
    const r = laya({ category: 'design' });
    r.final.category = 'planning'; // a router step changed it after the classifier answered
    expect(effectiveCategory(r)).toBe('design');
  });
  it('is null when the classifier gave no category', () => {
    expect(effectiveCategory(cmp({ category: null }))).toBeNull();
  });
});

describe('observedGroupMap', () => {
  it('skips non-routing stages — observations and comparators never routed anything', () => {
    // Regression (review round on laya-spike, 2026-10-29): observedGroupMap
    // only skipped 'hint' records, so detached observation / comparator /
    // pool records fed the category->group map as if they had routed.
    const obs = (stage: string): PairLogRecord =>
      ({ ...laya({ category: 'design', group: 'planning' }), stage }) as PairLogRecord;
    const m = observedGroupMap([
      obs('observation'),
      obs('observation-comparator'),
      obs('comparator'),
      obs('pool'),
    ]);
    expect(m).toEqual({});
  });

  it('learns category -> group from the log, never from continue', () => {
    const m = observedGroupMap([
      laya({ category: 'code_complex', group: 'tactical' }),
      cmp({ category: 'code_complex', group: 'tactical' }),
      laya({ category: 'code_complex', group: 'tactical' }),
      cmp({ category: 'continue', group: 'tactical' }),
      laya({ category: 'design', group: 'planning' }),
    ]);
    expect(m).toEqual({ code_complex: 'tactical', design: 'planning' });
  });
  it('takes the most frequent group when a category was routed to two', () => {
    const m = observedGroupMap([
      laya({ category: 'simple', group: 'scout' }),
      laya({ category: 'simple', group: 'scout' }),
      laya({ category: 'simple', group: 'fallback' }),
    ]);
    expect(m.simple).toBe('scout');
  });
});

describe('summarizePairs', () => {
  const groupOf = { simple: 'scout', code_simple: 'simple', standard: 'operational', design: 'planning', planning: 'planning', code_complex: 'tactical' };
  const records: PairLogRecord[] = [
    // 1 agree (design = design)
    laya({ sha: 'a', category: 'design', conf: 0.97, ts: 0, ms: 100 }),
    cmp({ sha: 'a', category: 'design', ts: 15, ms: 800 }),
    // 2 category differs, group agrees (design vs planning -> both planning)
    laya({ sha: 'b', category: 'design', conf: 0.85, ts: 100, ms: 200 }),
    cmp({ sha: 'b', category: 'planning', ts: 115, ms: 1000 }),
    // 3 differs in category and group
    laya({ sha: 'c', category: 'code_complex', conf: 0.55, ts: 200, ms: 300 }),
    cmp({ sha: 'c', category: 'standard', ts: 215, ms: 900 }),
    // 4 laya continue inherits design, chain says design -> agree after inheritance
    laya({ sha: 'd', category: 'continue', prev: 'design', conf: 0.6, ts: 300 }),
    cmp({ sha: 'd', category: 'design', ts: 315 }),
    // 5 chain says continue, laya a real category, no predecessor -> disagree
    laya({ sha: 'e', category: 'code_complex', conf: 0.7, ts: 400 }),
    cmp({ sha: 'e', category: 'continue', prev: null, ts: 415 }),
  ];
  const { pairs } = pairRecords(records);
  const s = summarizePairs(pairs, groupOf);

  it('counts pairs and category agreement after continue inheritance', () => {
    expect(s.n).toBe(5);
    expect(s.categoryAgree).toBe(2); // a, d
  });

  it('counts group agreement through the observed category -> group map', () => {
    expect(s.groupKnown).toBe(4); // e: the chain's `continue` has no predecessor, so no group
    expect(s.groupAgree).toBe(3); // a, b (design/planning same group), d
  });

  it('breaks agreement down per Laya category', () => {
    expect(s.byLayaCategory.design).toEqual({ n: 3, agree: 2 }); // a, b(no), d(inherited design)
    expect(s.byLayaCategory.code_complex).toEqual({ n: 2, agree: 0 });
  });

  it('lists the disagreements as laya -> chain pairs, most frequent first', () => {
    expect(s.confusion).toEqual(
      expect.arrayContaining([
        { laya: 'design', chain: 'planning', n: 1 },
        { laya: 'code_complex', chain: 'standard', n: 1 },
        { laya: 'code_complex', chain: 'continue', n: 1 },
      ]),
    );
    expect(s.confusion).toHaveLength(3);
  });

  it('reports agreement per Laya confidence bucket', () => {
    expect(s.confidenceBuckets['≥ 0.95']).toEqual({ n: 1, agree: 1 });
    expect(s.confidenceBuckets['0.80-0.90']).toEqual({ n: 1, agree: 0 });
    expect(s.confidenceBuckets['< 0.70']).toEqual({ n: 2, agree: 1 }); // c (0.55) no, d (0.6) yes
    expect(s.confidenceBuckets['0.70-0.80']).toEqual({ n: 1, agree: 0 });
  });

  it('shows the continue confusion on the raw answers', () => {
    expect(s.continue).toEqual({ both: 0, layaOnly: 1, chainOnly: 1, neither: 3 });
  });

  it('reports median latency of both stages', () => {
    expect(s.latency.layaMedianMs).toBe(100); // 100,200,300,100,100 -> 100
    expect(s.latency.chainMedianMs).toBe(900);
  });

  it('excludes pairs without a category from the agreement counts', () => {
    const p = pairRecords([laya({ sha: 'z', category: 'design' }), cmp({ sha: 'z', category: null })]).pairs;
    const t = summarizePairs(p, groupOf);
    expect(t.n).toBe(1);
    expect(t.noAnswer).toBe(1);
    expect(t.categoryAgree).toBe(0);
    expect(t.byLayaCategory).toEqual({});
  });
});

describe('wilsonInterval', () => {
  it('gives the 95 % Wilson interval for 8 of 27', () => {
    const [lo, hi] = wilsonInterval(8, 27);
    expect(lo).toBeCloseTo(0.1585, 3);
    expect(hi).toBeCloseTo(0.4849, 3);
  });
  it('is [0, 0] without a sample', () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 0]);
  });
});

describe('formatPairReport', () => {
  const { pairs, unpairedLaya, orphanComparators } = pairRecords([
    laya({ sha: 'a', category: 'design' }),
    cmp({ sha: 'a', category: 'planning' }),
    laya({ sha: 'u', category: 'design', ts: 500 }),
  ]);
  const text = formatPairReport(summarizePairs(pairs, { design: 'planning', planning: 'planning' }), {
    file: '/x/log.jsonl',
    unpairedLaya,
    orphanComparators,
  });

  it('names the numbers a reader needs', () => {
    expect(text).toContain('Laya vs comparator');
    expect(text).toContain('1 pair');
    expect(text).toContain('1 laya record without comparator');
    expect(text).toContain('design');
    expect(text).toContain('planning');
  });

  it('prints a malformed category label as (other), never as free text', () => {
    const p = pairRecords([
      laya({ sha: 'q', category: 'design' }),
      cmp({ sha: 'q', category: 'Fix the login bug in my private project please' }),
    ]).pairs;
    const t = formatPairReport(summarizePairs(p, {}), { file: '/x', unpairedLaya: 0, orphanComparators: 0 });
    expect(t).toContain('(other)');
    expect(t).not.toContain('login');
    expect(t).not.toContain('private');
  });

  it('never prints prompt text or classifier reasons', () => {
    expect(text).not.toContain('LEAK-PROMPT-TEXT');
    expect(text).not.toContain('LEAK-LAYA-REASON');
    expect(text).not.toContain('LEAK-CMP-REASON');
  });
});

describe('laya-pair-stats CLI', () => {
  it('prints the report for a log file and handles a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'laya-pairs-'));
    const file = join(dir, 'log.jsonl');
    writeFileSync(file, [laya({ sha: 'a', category: 'design' }), cmp({ sha: 'a', category: 'design' })].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const run = (f: string) =>
      spawnSync('npx', ['tsx', 'scripts/laya-pair-stats.ts', `--file=${f}`], { cwd: process.cwd(), encoding: 'utf8' });
    const ok = run(file);
    const missing = run(join(dir, 'nope.jsonl'));
    rmSync(dir, { recursive: true, force: true });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('Laya vs comparator');
    expect(ok.stdout).not.toContain('LEAK-PROMPT-TEXT');
    expect(missing.status).toBe(0);
    expect(missing.stdout).toContain('No decision log yet');
  });
});
