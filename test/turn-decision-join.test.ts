// Join of pi session turns with the classifier decision log
// (docs/plans/2026-10-26-continue-keeps-model.md, measurement prerequisite).
//
// A turn is a user message in a pi session file. Its routing decision is the
// decision-log record with the same prompt hash (`input.sha`) whose timestamp
// falls shortly after the message. Two rules keep the join honest:
//   - the background `comparator` stage never routes, so its records are never
//     candidates for a turn;
//   - more than one candidate is reported as `ambiguous` and never picked, so a
//     common prompt such as "continue" cannot silently borrow another turn's
//     decision.
// Synthetic records only — no dependency on the real decision log.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  joinTurns,
  readSessionTurns,
  readDecisions,
  summarizeJoin,
  promptSha,
  type SessionTurn,
  type DecisionRow,
} from '../scripts/turn-decision-join.ts';

const T0 = Date.parse('2026-10-26T10:00:00.000Z');
const at = (sec: number) => T0 + sec * 1000;

const turn = (session: string, sec: number, sha: string, served: string | null = 'p/m'): SessionTurn => ({
  session,
  ts: at(sec),
  sha,
  served,
});

const decision = (sec: number, sha: string, over: Partial<DecisionRow> = {}): DecisionRow => ({
  ts: at(sec),
  sha,
  stage: 'laya',
  category: 'standard',
  group: 'operational',
  ...over,
});

describe('promptSha', () => {
  it('is the decision log hash: sha256 of the UTF-8 prompt, first 12 hex chars', () => {
    const expected = createHash('sha256').update('continue', 'utf8').digest('hex').slice(0, 12);
    expect(promptSha('continue')).toBe(expected);
  });
});

describe('joinTurns — matching', () => {
  it('matches a turn to the single decision with the same hash shortly after it', () => {
    const [j] = joinTurns([turn('s', 0, 'aaa')], [decision(1, 'aaa', { category: 'planning', group: 'planning' })]);
    expect(j.status).toBe('matched');
    expect(j.category).toBe('planning');
    expect(j.group).toBe('planning');
  });

  it('ignores a decision with the same hash that is outside the window', () => {
    const before = joinTurns([turn('s', 10, 'aaa')], [decision(7, 'aaa')]);
    const after = joinTurns([turn('s', 0, 'aaa')], [decision(60, 'aaa')]);
    expect(before[0].status).toBe('unmatched');
    expect(after[0].status).toBe('unmatched');
  });

  it('ignores a decision with a different hash', () => {
    const [j] = joinTurns([turn('s', 0, 'aaa')], [decision(1, 'bbb')]);
    expect(j.status).toBe('unmatched');
  });

  it('never routes through the comparator stage', () => {
    const [j] = joinTurns([turn('s', 0, 'aaa')], [decision(1, 'aaa', { stage: 'comparator' })]);
    expect(j.status).toBe('unmatched');
  });

  it('reports two routing decisions in the window as ambiguous and picks neither', () => {
    const [j] = joinTurns(
      [turn('s', 0, 'aaa')],
      [decision(1, 'aaa', { category: 'simple' }), decision(3, 'aaa', { category: 'standard' })],
    );
    expect(j.status).toBe('ambiguous');
    expect(j.category).toBeNull();
    expect(j.group).toBeNull();
  });

  it('a laya routing record next to its comparator record is one candidate, not two', () => {
    const [j] = joinTurns(
      [turn('s', 0, 'aaa')],
      [decision(1, 'aaa', { stage: 'laya' }), decision(1, 'aaa', { stage: 'comparator', category: 'simple' })],
    );
    expect(j.status).toBe('matched');
    expect(j.category).toBe('standard');
  });
});

describe('joinTurns — the matched decision carries its process and time', () => {
  it('exposes the process tag and the decision time of the single matched record', () => {
    const [j] = joinTurns(
      [turn('s', 0, 'aaa')],
      [decision(1, 'aaa', { proc: 'proj/2559' })],
    );
    expect(j.decisionTs).toBe(at(1));
    expect(j.proc).toBe('proj/2559');
  });

  it('leaves both null when the turn is not matched', () => {
    const [j] = joinTurns([turn('s', 0, 'aaa')], []);
    expect(j.decisionTs).toBeNull();
    expect(j.proc).toBeNull();
  });
});

describe('joinTurns — switches', () => {
  it('marks a switch when the served model differs from the previous turn of the same session', () => {
    const out = joinTurns(
      [turn('s', 0, 'a1', 'p/x'), turn('s', 100, 'a2', 'p/y')],
      [decision(1, 'a1'), decision(101, 'a2')],
    );
    expect(out.map((j) => j.switched)).toEqual([null, true]);
  });

  it('compares only within one session', () => {
    const out = joinTurns(
      [turn('s1', 0, 'a1', 'p/x'), turn('s2', 100, 'a2', 'p/y')],
      [decision(1, 'a1'), decision(101, 'a2')],
    );
    expect(out.map((j) => j.switched)).toEqual([null, null]);
  });

  it('skips turns without a served model as predecessors', () => {
    const out = joinTurns(
      [turn('s', 0, 'a1', 'p/x'), turn('s', 50, 'a2', null), turn('s', 100, 'a3', 'p/x')],
      [decision(1, 'a1'), decision(51, 'a2'), decision(101, 'a3')],
    );
    expect(out[1].switched).toBeNull();
    expect(out[2].switched).toBe(false);
  });

  it('still counts a switch for a turn whose decision is ambiguous', () => {
    const out = joinTurns(
      [turn('s', 0, 'a1', 'p/x'), turn('s', 100, 'a2', 'p/y')],
      [decision(1, 'a1'), decision(101, 'a2'), decision(103, 'a2')],
    );
    expect(out[1].status).toBe('ambiguous');
    expect(out[1].switched).toBe(true);
  });
});

describe('joinTurns — determinism', () => {
  it('gives the same result whatever the input order of turns and decisions', () => {
    const turns = [turn('s', 0, 'a1', 'p/x'), turn('s', 100, 'a2', 'p/y'), turn('t', 5, 'a1', 'p/z')];
    const decs = [decision(1, 'a1'), decision(101, 'a2'), decision(6, 'a1', { category: 'simple' })];
    const forward = joinTurns(turns, decs);
    const reversed = joinTurns([...turns].reverse(), [...decs].reverse());
    expect(reversed).toEqual(forward);
  });
});

describe('summarizeJoin', () => {
  it('counts statuses and switches per category, without any prompt text', () => {
    const joined = joinTurns(
      [turn('s', 0, 'a1', 'p/x'), turn('s', 100, 'a2', 'p/y'), turn('s', 200, 'a3', 'p/y')],
      [decision(1, 'a1', { category: 'continue' }), decision(101, 'a2', { category: 'continue' })],
    );
    const s = summarizeJoin(joined);
    expect(s.turns).toBe(3);
    expect(s.matched).toBe(2);
    expect(s.unmatched).toBe(1);
    expect(s.ambiguous).toBe(0);
    expect(s.byCategory.continue).toEqual({ turns: 2, switches: 1 });
    expect(JSON.stringify(s)).not.toContain('a1');
  });
});

describe('readSessionTurns / readDecisions — file parsing', () => {
  let dir = '';
  let sessDir = '';
  let logPath = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-join-'));
    sessDir = join(dir, 'sessions');
    mkdirSync(sessDir);
    logPath = join(dir, 'decisions.jsonl');

    const msg = (role: string, content: unknown, ms: number, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: 'message', timestamp: new Date(ms).toISOString(), message: { role, content, timestamp: ms, ...extra } });

    writeFileSync(
      join(sessDir, 'a.jsonl'),
      [
        msg('user', '<memory>context block</memory>', at(-5)), // not a turn
        msg('user', [{ type: 'text', text: 'continue' }], at(0)),
        msg('assistant', [{ type: 'text', text: 'ok' }], at(1), { provider: 'p', model: 'x' }),
        msg('user', 'do the next thing', at(100)),
        msg('assistant', [], at(101), { provider: 'p', model: 'y' }),
      ].join('\n') + '\n',
    );

    writeFileSync(
      logPath,
      [
        JSON.stringify({ ts: new Date(at(1)).toISOString(), stage: 'laya', input: { sha: promptSha('continue') }, final: { category: 'continue', group: 'tactical' } }),
        JSON.stringify({ ts: new Date(at(101)).toISOString(), stage: 'laya', input: { sha: promptSha('do the next thing') }, final: { category: 'standard', group: 'operational' } }),
      ].join('\n') + '\n',
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads user turns, skips the memory block, and takes the first assistant reply as the served model', () => {
    const turns = readSessionTurns(sessDir, {});
    expect(turns.map((t) => [t.sha, t.served])).toEqual([
      [promptSha('continue'), 'p/x'],
      [promptSha('do the next thing'), 'p/y'],
    ]);
  });

  it('honours the since/until bounds on the user message timestamp', () => {
    const turns = readSessionTurns(sessDir, { since: at(50), until: at(200) });
    expect(turns).toHaveLength(1);
    expect(turns[0].sha).toBe(promptSha('do the next thing'));
  });

  it('reads decision records with their hash, stage and final category', () => {
    const decs = readDecisions(logPath, {});
    expect(decs.map((d) => [d.stage, d.category, d.group])).toEqual([
      ['laya', 'continue', 'tactical'],
      ['laya', 'standard', 'operational'],
    ]);
  });
});
