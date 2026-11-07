// Measurement core of scripts/continue-switch-measure.ts
// (docs/plans/2026-10-26-continue-keeps-model.md, Step 1: how often does a
// `continue` turn switch the serving model, and why).
//
// The kind of a turn is its RAW category — `continue` is replaced by the
// inherited category in `final`, so the join's final category can never see
// it. A pair is two consecutive turns of one session whose served models are
// both known. The cause split reads router.log lines in a window before the
// turn: a limit, breaker or overflow line naming the previous model explains
// the switch; anything else is "unexplained" — the ranking-change bucket the
// plan targets.
//
// Synthetic records only — no dependency on the real logs.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRoutingRows,
  parseRouterLogLines,
  classifySwitchCause,
  measurePairs,
  summarizeSwitchPairs,
  type RoutingRow,
} from '../scripts/continue-switch-measure.ts';
import type { SessionTurn } from '../scripts/turn-decision-join.ts';

type SessionTurnWithServed = SessionTurn;

const T0 = Date.parse('2026-11-08T10:00:00.000Z');
const at = (sec: number) => T0 + sec * 1000;

const turn = (
  session: string,
  sec: number,
  sha: string,
  served: string | null
): SessionTurnWithServed => ({ session, ts: at(sec), sha, served });

const row = (sec: number, sha: string, over: Partial<RoutingRow> = {}): RoutingRow => ({
  ts: at(sec),
  sha,
  rawCategory: 'code_complex',
  finalCategory: 'code_complex',
  group: 'code',
  ...over,
});

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'csm-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readRoutingRows', () => {
  it('reads routing records from several (rotated) log files and keeps the raw category', () => {
    const line = (sec: number, sha: string, raw: string, final: string) =>
      JSON.stringify({
        v: 1,
        ts: new Date(at(sec)).toISOString(),
        proc: 'p/1',
        stage: 'llm-cloud',
        raw: { category: raw, confidence: 1, reason: null },
        prev: null,
        final: { category: final, group: 'g', hint: null, reason: null },
        input: { chars: 1, words: 1, sha, text: { prompt: 'x' } },
        steps: [],
      });
    const f1 = join(dir, 'a.jsonl');
    const f2 = join(dir, 'b.jsonl');
    writeFileSync(f1, `${line(0, 'aaa', 'continue', 'standard')}\n`);
    writeFileSync(
      f2,
      `${line(1, 'bbb', 'planning', 'planning')}\n${line(2, 'ccc', 'continue', 'standard')}\n`
    );
    const rows = readRoutingRows([f1, f2]);
    expect(rows.map((r) => r.sha)).toEqual(['aaa', 'bbb', 'ccc']);
    expect(rows[0].rawCategory).toBe('continue');
    expect(rows[0].finalCategory).toBe('standard');
  });

  it('drops pool and comparator records — they never route a turn', () => {
    const rec = (stage: string, sha: string | null) =>
      JSON.stringify({
        v: 1,
        ts: new Date(at(0)).toISOString(),
        proc: 'p/1',
        stage,
        raw: null,
        final: { category: 'standard', group: 'g', hint: null, reason: null },
        input: sha ? { chars: 1, words: 1, sha, text: { prompt: 'x' } } : { chars: 1, words: 1 },
      });
    const f = join(dir, 'c.jsonl');
    writeFileSync(f, `${rec('pool', null)}\n${rec('comparator', 'ddd')}\n${rec('laya', 'eee')}\n`);
    const rows = readRoutingRows([f]);
    expect(rows.map((r) => r.sha)).toEqual(['eee']);
  });
});

describe('classifySwitchCause', () => {
  const lines = (spec: Array<[sec: number, text: string]>) =>
    spec.map(([sec, text]) => ({ ts: at(sec), text }));

  it('a rate-limit line naming the previous model explains the switch', () => {
    const cause = classifySwitchCause(
      lines([[-10, '[router] p/prev — rate limited — backing off']]),
      at(0),
      'p/prev',
      { beforeMs: 45_000 }
    );
    expect(cause).toBe('limit');
  });

  it('a breaker line naming the previous model explains the switch', () => {
    const cause = classifySwitchCause(
      lines([[-5, '[router] p/prev looks wedged: evidence. Skipping p/prev models']]),
      at(0),
      'p/prev',
      { beforeMs: 45_000 }
    );
    expect(cause).toBe('breaker');
  });

  it('a context-window line naming the previous model explains the switch', () => {
    const cause = classifySwitchCause(
      lines([[-5, '[router] p/prev — context window too small, trying next']]),
      at(0),
      'p/prev',
      { beforeMs: 45_000 }
    );
    expect(cause).toBe('overflow');
  });

  it('lines outside the window are ignored; no line leaves the switch unexplained', () => {
    const old = lines([[-100, '[router] p/prev — rate limited — backing off']]);
    const none = lines([[-10, '[router] other/next selected']]);
    expect(classifySwitchCause(old, at(0), 'p/prev', { beforeMs: 45_000 })).toBe('unexplained');
    expect(classifySwitchCause(none, at(0), 'p/prev', { beforeMs: 45_000 })).toBe('unexplained');
  });

  it('a line that names a DIFFERENT model does not explain the switch', () => {
    const cause = classifySwitchCause(
      lines([[-10, '[router] p/other — rate limited — backing off']]),
      at(0),
      'p/prev',
      { beforeMs: 45_000 }
    );
    expect(cause).toBe('unexplained');
  });
});

describe('measurePairs', () => {
  const cont = (sec: number, sha: string) =>
    row(sec, sha, { rawCategory: 'continue', finalCategory: 'standard', group: 'operational' });

  it('a continue turn that keeps the model is a kept pair', () => {
    const pairs = measurePairs(
      [turn('s', 0, 'aaa', 'p/a'), turn('s', 10, 'bbb', 'p/a')],
      [cont(11, 'bbb')]
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].kind).toBe('continue');
    expect(pairs[0].switched).toBe(false);
  });

  it('a continue turn that switches model is a switch with its cause', () => {
    const pairs = measurePairs(
      [turn('s', 0, 'aaa', 'p/a'), turn('s', 10, 'bbb', 'p/b')],
      [cont(11, 'bbb')]
    );
    expect(pairs[0].kind).toBe('continue');
    expect(pairs[0].switched).toBe(true);
  });

  it('an unmatched turn has no kind and forms no continue pair', () => {
    const pairs = measurePairs(
      [turn('s', 0, 'aaa', 'p/a'), turn('s', 10, 'zzz', 'p/b')],
      [cont(1, 'bbb')]
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].kind).toBe('unmatched');
  });

  it('pairs do not cross sessions and need both served models', () => {
    const pairs = measurePairs(
      [
        turn('s1', 0, 'aaa', 'p/a'),
        turn('s2', 10, 'bbb', 'p/b'),
        turn('s1', 20, 'ccc', null),
        turn('s1', 30, 'ddd', 'p/a'),
      ],
      [cont(11, 'bbb'), cont(31, 'ddd')]
    );
    // s1: aaa -> (ccc unserved, skipped) -> ddd vs p/a: kept.
    // s2: first turn, no pair.
    expect(pairs).toHaveLength(1);
    expect(pairs[0].kind).toBe('continue');
    expect(pairs[0].switched).toBe(false);
  });

  it('a pair knows whether the group changed between the turns', () => {
    const pairs = measurePairs(
      [turn('s', 0, 'aaa', 'p/a'), turn('s', 10, 'bbb', 'p/b'), turn('s', 20, 'ccc', 'p/c')],
      [
        cont(1, 'aaa'),
        cont(11, 'bbb'),
        row(21, 'ccc', { rawCategory: 'continue', finalCategory: 'planning', group: 'planning' }),
      ]
    );
    // aaa -> bbb: same group (operational); bbb -> ccc: group moved to planning.
    expect(pairs[0].groupChanged).toBe(false);
    expect(pairs[1].groupChanged).toBe(true);
    const s = summarizeSwitchPairs(pairs);
    expect(s.byKind.continue.pairs).toBe(2);
    expect(s.byKind.continue.groupChangedSwitches).toBe(1);
    expect(s.byKind.continue.sameGroupSwitches).toBe(1);
  });

  it('summarizeSwitchPairs counts kinds and switch causes', () => {
    const pairs = measurePairs(
      [
        turn('s', 0, 'aaa', 'p/a'),
        turn('s', 10, 'bbb', 'p/b'),
        turn('s', 20, 'ccc', 'p/b'),
        turn('s', 30, 'ddd', 'p/c'),
      ],
      [
        cont(11, 'bbb'),
        cont(21, 'ccc'),
        row(31, 'ddd', {
          rawCategory: 'code_complex',
          finalCategory: 'code_complex',
          group: 'code',
        }),
      ]
    );
    const s = summarizeSwitchPairs(pairs, [
      { ts: at(5), text: '[router] p/a — rate limited — backing off' },
    ]);
    expect(s.byKind.continue.pairs).toBe(2);
    expect(s.byKind.continue.switches).toBe(1);
    expect(s.byKind.continue.causes).toEqual({ limit: 1 });
    expect(s.byKind.other.pairs).toBe(1);
    expect(s.byKind.other.switches).toBe(1);
    expect(s.byKind.other.causes).toEqual({ unexplained: 1 });
  });
});

describe('parseRouterLogLines', () => {
  it('parses the leading ISO timestamp and skips unparseable lines', () => {
    const f = join(dir, 'router.log');
    writeFileSync(
      f,
      [
        `${new Date(at(-10)).toISOString()}  [p/1] [router] p/prev — rate limited`,
        'not a log line',
        `${new Date(at(-5)).toISOString()}  [p/1] [stream] p/x finished`,
      ].join('\n')
    );
    const lines = parseRouterLogLines(f, { since: at(-20), until: at(0) });
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toContain('rate limited');
  });
});
