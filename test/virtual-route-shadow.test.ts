// Virtual-model shadow report (docs/plans/2026-11-04-virtual-models-routing.md,
// spike step 2). The report answers one question from real router logs: if the
// turn had been routed by a virtual model — one physical model per request, no
// failover inside the request — would Pi's own retry have recovered the turn?
//
// Synthetic log lines only; the report is pure (lines and decisions in, rows out).

import { describe, it, expect } from 'vitest';
import {
  classifyPiRetry,
  shadowTurns,
  summarizeShadow,
  type WalkDecision,
} from '../scripts/virtual-route-shadow.ts';

const ISO = (sec: number) =>
  new Date(Date.parse('2026-11-05T10:00:00.000Z') + sec * 1000).toISOString();
const POOL = (sec: number, proc: string, group: string, refs: string[]) =>
  `${ISO(sec)}  [${proc}] [routing] group=${group} method=tiered candidates: ${refs
    .map((r, i) => `${i + 1}. ${r} gdp=1 cost=0`)
    .join(' | ')} || excluded: (none)`;
const TRY = (sec: number, proc: string, ref: string) =>
  `${ISO(sec)}  [${proc}] [diag] tryStream streaming "${ref}" via host runtime`;
const FAIL = (sec: number, proc: string, ref: string, narration: string, next: string) =>
  `${ISO(sec)}  [${proc}] [router] ${ref} — ${narration}, trying ${next} …`;
const BODY = (sec: number, proc: string, ref: string, body: string) =>
  `${ISO(sec)}  [${proc}] [router] ${ref} 429 body: ${body}`;
const DONE = (sec: number, proc: string, ref: string) =>
  `${ISO(sec)}  [${proc}] [stream] ${ref} finished (stopReason: stop, 10 chars)`;
const dec = (sec: number, proc: string, group: string): WalkDecision => ({
  ts: Date.parse('2026-11-05T10:00:00.000Z') + sec * 1000,
  proc,
  group,
  stage: 'llm-cloud',
});

describe('classifyPiRetry — what Pi would do with the failure the router saw', () => {
  it('treats a plain 429 as retryable', () => {
    const c = classifyPiRetry(
      'provider error: 429: {"message":"rate limit exceeded","type":"rate_limit_error"}'
    );
    expect(c.verdict).toBe('pi-retry');
  });

  it('treats a 429 whose body names a spent quota as not retryable', () => {
    const c = classifyPiRetry(
      'provider error: 429: {"message":"Claude quota exceeded - rate limit (five_hour)"}'
    );
    expect(c.verdict).toBe('pi-no-retry');
  });

  it('ignores the router annotation when matching the provider text', () => {
    // Pi sees "422 status code (no body)", not the router's "(likely rate limit)".
    const c = classifyPiRetry(
      'provider error: 422 status code (no body) (likely rate limit) (resets 5.11.2026, 10:37:24)'
    );
    expect(c.verdict).toBe('pi-no-retry');
  });

  it('prefers the logged 429 body over the router narration', () => {
    const c = classifyPiRetry(
      'rate limit/spend limit reached (resets in 3h 12m, at 13:12)',
      "You've hit your session limit. It resets in 3 hours."
    );
    expect(c.verdict).toBe('pi-retry');
    const quota = classifyPiRetry(
      'rate limit/spend limit reached (resets in 3h 12m, at 13:12)',
      'quota exceeded for this month'
    );
    expect(quota.verdict).toBe('pi-no-retry');
  });

  it.each([
    ['empty response (no content, no error reported) (backing off 60s, until 11:12)'],
    ['empty response (likely rate limit) (resets 5.11.2026, 10:37:24)'],
    ['no response within timeout'],
    ['stuck in a repetition loop ("Grep">'],
    ['output truncated at max tokens (task incomplete)'],
  ])('counts %s as invisible to Pi', (narration) => {
    expect(classifyPiRetry(narration).verdict).toBe('pi-blind');
  });

  it('counts an exhausted cooldown ladder as router state, not a provider failure', () => {
    expect(classifyPiRetry('all 4 candidate(s) in cooldown.').verdict).toBe('router-state');
  });

  it('treats an unrecognised error as not retryable', () => {
    expect(classifyPiRetry('provider error: something odd happened').verdict).toBe('pi-no-retry');
  });
});

describe('shadowTurns — would a virtual model have survived the turn?', () => {
  it('leaves a turn alone when the first choice served it', () => {
    const lines = [
      POOL(0, 'p/1', 'standard', ['a/one', 'b/two']),
      TRY(0.1, 'p/1', 'a/one'),
      DONE(1, 'p/1', 'a/one'),
    ];
    const [row] = shadowTurns(lines, [dec(0, 'p/1', 'standard')]);
    expect(row.virtualOutcome).toBe('same');
    expect(row.verdict).toBeNull();
  });

  it('recovers a 429 turn through Pi retry plus a route() switch', () => {
    const lines = [
      POOL(0, 'p/1', 'standard', ['a/one', 'b/two']),
      TRY(0.1, 'p/1', 'a/one'),
      FAIL(0.2, 'p/1', 'a/one', 'provider error: 429: rate limit exceeded', 'b/two'),
      TRY(0.3, 'p/1', 'b/two'),
      DONE(1, 'p/1', 'b/two'),
    ];
    const [row] = shadowTurns(lines, [dec(0, 'p/1', 'standard')]);
    expect(row.virtualOutcome).toBe('recovered');
    expect(row.verdict).toBe('pi-retry');
  });

  it('loses a turn whose first attempt returned an empty response', () => {
    const lines = [
      POOL(0, 'p/1', 'code_complex', ['a/one', 'b/two']),
      TRY(0.1, 'p/1', 'a/one'),
      FAIL(
        0.2,
        'p/1',
        'a/one',
        'empty response (no content, no error reported) (backing off 60s, until 11:12)',
        'b/two'
      ),
      TRY(0.3, 'p/1', 'b/two'),
      DONE(1, 'p/1', 'b/two'),
    ];
    const [row] = shadowTurns(lines, [dec(0, 'p/1', 'code_complex')]);
    expect(row.virtualOutcome).toBe('lost');
    expect(row.lostBecause).toBe('pi-blind: empty response');
  });

  it('reads the logged 429 body and loses a turn Pi will not retry', () => {
    const lines = [
      POOL(0, 'p/1', 'code_complex', ['claude-bridge/sonnet', 'mistral/glm']),
      TRY(0.1, 'p/1', 'claude-bridge/sonnet'),
      BODY(
        0.15,
        'p/1',
        'claude-bridge/sonnet',
        'Claude quota exceeded — rate limit (five_hour) — resets 10:10:00 PM'
      ),
      FAIL(
        0.2,
        'p/1',
        'claude-bridge/sonnet',
        'rate limit/spend limit reached (resets in 1h 37m, at 22:10)',
        'mistral/glm'
      ),
      TRY(0.3, 'p/1', 'mistral/glm'),
      DONE(1, 'p/1', 'mistral/glm'),
    ];
    const [row] = shadowTurns(lines, [dec(0, 'p/1', 'code_complex')]);
    expect(row.verdict).toBe('pi-no-retry');
    expect(row.lostBecause).toBe('pi-no-retry: quota or limit wording');
  });

  it('loses a turn that needed more attempts than Pi retries', () => {
    const refs = ['a/1', 'a/2', 'a/3', 'a/4', 'a/5'];
    const lines = [POOL(0, 'p/1', 'standard', refs)];
    refs.forEach((ref, i) => {
      lines.push(TRY(i + 0.1, 'p/1', ref));
      if (i < refs.length - 1) {
        lines.push(
          FAIL(i + 0.2, 'p/1', ref, 'provider error: 429: rate limit exceeded', refs[i + 1])
        );
      }
    });
    lines.push(DONE(6, 'p/1', 'a/5'));
    const [row] = shadowTurns(lines, [dec(0, 'p/1', 'standard')]);
    expect(row.virtualOutcome).toBe('lost');
    expect(row.lostBecause).toBe('retry budget: needed 5 attempts, Pi allows 4');
  });

  it('loses a turn whose LATER failure is not Pi-retryable (recovered was overstated)', () => {
    // The old report classified only the FIRST failure: a retryable 429 on the
    // first candidate, then a spent-quota 429 mid-chain, still counted as
    // "recovered" although Pi's retry would have stopped at the second one.
    const lines = [
      POOL(0, 'p/1', 'standard', ['a/one', 'b/two', 'c/three']),
      TRY(0.1, 'p/1', 'a/one'),
      FAIL(1, 'p/1', 'a/one', 'provider error: 429: {"message":"rate limit exceeded"}', 'b/two'),
      TRY(1.5, 'p/1', 'b/two'),
      FAIL(2, 'p/1', 'b/two', 'provider error: 429: {"message":"quota exceeded"}', 'c/three'),
      TRY(2.5, 'p/1', 'c/three'),
      DONE(3, 'p/1', 'c/three'),
    ];
    const [row] = shadowTurns(lines, [dec(0, 'p/1', 'standard')]);
    expect(row.virtualOutcome).toBe('lost');
    expect(row.lostBecause).toContain('later failure');
    expect(row.lostBecause).toContain('pi-no-retry');
  });

  it('keeps counting a turn as recovered when every failure is Pi-retryable', () => {
    const lines = [
      POOL(0, 'p/1', 'standard', ['a/one', 'b/two']),
      TRY(0.1, 'p/1', 'a/one'),
      FAIL(1, 'p/1', 'a/one', 'provider error: 429: {"message":"rate limit exceeded"}', 'b/two'),
      TRY(1.5, 'p/1', 'b/two'),
      FAIL(2, 'p/1', 'b/two', 'provider error: 503: overloaded', 'c/three'),
      TRY(2.5, 'p/1', 'c/three'),
      DONE(3, 'p/1', 'c/three'),
    ];
    const [row] = shadowTurns(lines, [dec(0, 'p/1', 'standard')]);
    expect(row.virtualOutcome).toBe('recovered');
  });

  it('binds failures to the turn window, not to the next decision of the process', () => {
    // A failure after the turn's success belongs to the NEXT turn and must not
    // lose this one.
    const lines = [
      POOL(0, 'p/1', 'standard', ['a/one', 'b/two']),
      TRY(0.1, 'p/1', 'a/one'),
      FAIL(1, 'p/1', 'a/one', 'provider error: 429: {"message":"rate limit exceeded"}', 'b/two'),
      TRY(1.5, 'p/1', 'b/two'),
      DONE(2, 'p/1', 'b/two'),
      // next turn, same process
      POOL(10, 'p/1', 'code_complex', ['a/one']),
      TRY(10.1, 'p/1', 'a/one'),
      FAIL(11, 'p/1', 'a/one', 'provider error: 429: {"message":"quota exceeded"}', 'b/other'),
    ];
    const rows = shadowTurns(lines, [dec(0, 'p/1', 'standard'), dec(10, 'p/1', 'code_complex')]);
    expect(rows[0].virtualOutcome).toBe('recovered');
    expect(rows[1].virtualOutcome).toBe('lost');
  });

  it('summarises per group', () => {
    const lines = [
      POOL(0, 'p/1', 'standard', ['a/one', 'b/two']),
      TRY(0.1, 'p/1', 'a/one'),
      DONE(1, 'p/1', 'a/one'),
      POOL(2, 'p/1', 'simple', ['a/one', 'b/two']),
      TRY(2.1, 'p/1', 'a/one'),
      FAIL(2.2, 'p/1', 'a/one', 'no response within timeout', 'b/two'),
      TRY(2.3, 'p/1', 'b/two'),
      DONE(3, 'p/1', 'b/two'),
    ];
    const rows = shadowTurns(lines, [dec(0, 'p/1', 'standard'), dec(2, 'p/1', 'simple')]);
    const summary = summarizeShadow(rows);
    expect(summary.standard.turns).toBe(1);
    expect(summary.standard.same).toBe(1);
    expect(summary.simple.lost).toBe(1);
    expect(summary.simple.lostBy['pi-blind: no response within timeout']).toBe(1);
  });
});
