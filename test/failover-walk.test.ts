// Failover walk per routed turn (docs/research/2026-10-28-failover-walk-baseline.md).
// Synthetic router.log lines only — the walk is pure: lines and decisions in,
// one row per routed decision out.

import { describe, it, expect } from 'vitest';
import { walkDecisions, type WalkDecision } from '../scripts/failover-walk.ts';

const ISO = (sec: number) => new Date(Date.parse('2026-10-22T10:00:00.000Z') + sec * 1000).toISOString();
const POOL = (sec: number, proc: string, group: string, refs: string[]) =>
  `${ISO(sec)}  [${proc}] [routing] group=${group} method=tiered candidates: ${refs
    .map((r, i) => `${i + 1}. ${r} gdp=1 cost=0`)
    .join(' | ')} || excluded: (none)`;
const TRY = (sec: number, proc: string, ref: string) =>
  `${ISO(sec)}  [${proc}] [diag] tryStream streaming "${ref}" via host runtime`;
const FAIL = (sec: number, proc: string, ref: string, next: string) =>
  `${ISO(sec)}  [${proc}] [router] ${ref} — provider error: 429: rate limit, trying ${next} …`;
const DONE = (sec: number, proc: string, ref: string) =>
  `${ISO(sec)}  [${proc}] [stream] ${ref} finished (stopReason: stop, 10 chars)`;
const dec = (sec: number, proc: string, group: string | null): WalkDecision => ({
  ts: Date.parse('2026-10-22T10:00:00.000Z') + sec * 1000,
  proc,
  group,
  stage: 'llm-cloud',
});

describe('walkDecisions — one row per routed decision', () => {
  it.each(['observation', 'observation-comparator', 'comparator'])('does not count a %s record as a routed decision', (stage) => {
    const lines = [POOL(0, 'p/1', 'standard', ['a/one']), TRY(0.1, 'p/1', 'a/one'), DONE(0.5, 'p/1', 'a/one')];
    const rows = walkDecisions(lines, [dec(0, 'p/1', 'standard'), { ...dec(1, 'p/1', 'planning'), stage }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].group).toBe('standard');
  });

  it('lists the attempts up to the first success and flags a failover away from the first choice', () => {
    const lines = [
      POOL(0, 'p/1', 'standard', ['mistral/a', 'mistral/b']),
      TRY(0.1, 'p/1', 'mistral/a'),
      FAIL(0.2, 'p/1', 'mistral/a', 'mistral/b'),
      TRY(0.3, 'p/1', 'mistral/b'),
      DONE(0.9, 'p/1', 'mistral/b'),
    ];
    const [row] = walkDecisions(lines, [dec(0, 'p/1', 'standard')]);
    expect(row).toMatchObject({
      group: 'standard',
      erstwahl: 'mistral/a',
      attempts: ['mistral/a', 'mistral/b'],
      success: 'mistral/b',
      outcome: 'success',
    });
  });

  it('counts a first-choice success as no failover', () => {
    const lines = [POOL(0, 'p/1', 'simple', ['x/free']), TRY(0.1, 'p/1', 'x/free'), DONE(0.5, 'p/1', 'x/free')];
    const [row] = walkDecisions(lines, [dec(0, 'p/1', 'simple')]);
    expect(row).toMatchObject({ attempts: ['x/free'], success: 'x/free', erstwahl: 'x/free' });
  });

  it('ends the window at the next decision of the same process', () => {
    const lines = [
      POOL(0, 'p/1', 'standard', ['a/one']),
      TRY(0.1, 'p/1', 'a/one'),
      POOL(20, 'p/1', 'standard', ['b/two']),
      TRY(20.1, 'p/1', 'b/two'),
      DONE(20.5, 'p/1', 'b/two'),
    ];
    const rows = walkDecisions(lines, [dec(0, 'p/1', 'standard'), dec(20, 'p/1', 'standard')]);
    expect(rows[0]).toMatchObject({ attempts: ['a/one'], outcome: 'no-success' });
    expect(rows[1]).toMatchObject({ attempts: ['b/two'], success: 'b/two' });
  });

  it('ignores attempts of other processes', () => {
    const lines = [
      POOL(0, 'p/1', 'simple', ['a/one']),
      TRY(0.1, 'q/2', 'z/other'),
      TRY(0.2, 'p/1', 'a/one'),
      DONE(0.4, 'p/1', 'a/one'),
    ];
    const [row] = walkDecisions(lines, [dec(0, 'p/1', 'simple')]);
    expect(row.attempts).toEqual(['a/one']);
  });

  it('marks a turn without any success as no-success, with the attempts it made', () => {
    const lines = [POOL(0, 'p/1', 'planning', ['a/one', 'a/two']), TRY(0.1, 'p/1', 'a/one'), FAIL(0.2, 'p/1', 'a/one', 'a/two')];
    const [row] = walkDecisions(lines, [dec(0, 'p/1', 'planning')]);
    expect(row).toMatchObject({ outcome: 'no-success', attempts: ['a/one'] });
  });

  it('takes the last pool line of the group before the turn when none was logged during it, and says so', () => {
    // The router logs a pool line only when it recomputes a pool, not per decision.
    const lines = [
      POOL(-600, 'p/1', 'simple', ['a/earlier']),
      TRY(0.1, 'p/1', 'a/earlier'),
      DONE(0.4, 'p/1', 'a/earlier'),
    ];
    const [row] = walkDecisions(lines, [dec(0, 'p/1', 'simple')]);
    expect(row).toMatchObject({ erstwahl: 'a/earlier', erstwahlSource: 'earlier' });
  });

  it('prefers the pool logged during the turn over an earlier one', () => {
    const lines = [POOL(-600, 'p/1', 'simple', ['a/old']), POOL(0, 'p/1', 'simple', ['b/now']), TRY(0.1, 'p/1', 'b/now'), DONE(0.4, 'p/1', 'b/now')];
    const [row] = walkDecisions(lines, [dec(0, 'p/1', 'simple')]);
    expect(row).toMatchObject({ erstwahl: 'b/now', erstwahlSource: 'turn' });
  });

  it('ignores a pool line older than thirty minutes', () => {
    const lines = [POOL(-1900, 'p/1', 'simple', ['a/stale']), TRY(0.1, 'p/1', 'a/stale'), DONE(0.4, 'p/1', 'a/stale')];
    const [row] = walkDecisions(lines, [dec(0, 'p/1', 'simple')]);
    expect(row).toMatchObject({ erstwahl: null, erstwahlSource: null });
  });

  it('takes the first attempt as the observed first choice, whatever the pool log says', () => {
    const lines = [TRY(0.1, 'p/1', 'a/one'), FAIL(0.2, 'p/1', 'a/one', 'a/two'), TRY(0.3, 'p/1', 'a/two'), DONE(0.6, 'p/1', 'a/two')];
    const [row] = walkDecisions(lines, [dec(0, 'p/1', 'simple')]);
    expect(row).toMatchObject({ firstAttempt: 'a/one', erstwahl: null });
  });

  it('reports a missing pool line as erstwahl null instead of guessing', () => {
    const lines = [TRY(0.1, 'p/1', 'a/one'), DONE(0.4, 'p/1', 'a/one')];
    const [row] = walkDecisions(lines, [dec(0, 'p/1', 'simple')]);
    expect(row.erstwahl).toBeNull();
  });

  it('skips decisions without a group (hints, classifier fallbacks)', () => {
    const lines = [TRY(0.1, 'p/1', 'a/one'), DONE(0.4, 'p/1', 'a/one')];
    expect(walkDecisions(lines, [dec(0, 'p/1', null)])).toEqual([]);
  });
});
