// Decision-time candidate pools read from router.log (docs/research/2026-10-27-pool-replay.md,
// route 1): each `[routing] group=…` line is the ranked pool the router computed
// for one group at one moment. The pure parser and the turn join live in
// scripts/route-pool-log.ts. Synthetic lines only.

import { describe, it, expect } from 'vitest';
import {
  parseRoutingLine,
  firstChoiceAsOf,
  calibrate,
  type RoutingLine,
} from '../scripts/route-pool-log.ts';

const line = (ts: string, group: string, candidates: string, excluded = '(none)') =>
  `${ts}  [proj/2559] [routing] group=${group} method=best candidates: ${candidates} || excluded: ${excluded}`;

const T = '2026-10-27T14:47:29.346Z';
const T_MS = Date.parse(T);

describe('parseRoutingLine', () => {
  it('reads the timestamp, process, group, method and the ranked candidates with their columns', () => {
    const r = parseRoutingLine(
      line(T, 'tactical', '1. claude-bridge/claude-sonnet-5-5 gdp=1837.82 cost=0.000002 score=1909 | 2. mistral/zai-glm-5-3 gdp=1650.73 cost=1.4 score=1771 [paced]'),
    )!;
    expect(r.ts).toBe(T_MS);
    expect(r.proc).toBe('proj/2559');
    expect(r.group).toBe('tactical');
    expect(r.method).toBe('best');
    expect(r.candidates).toEqual([
      { ref: 'claude-bridge/claude-sonnet-5-5', gdp: 1837.82, cost: 0.000002, score: 1909, flags: [] },
      { ref: 'mistral/zai-glm-5-3', gdp: 1650.73, cost: 1.4, score: 1771, flags: ['paced'] },
    ]);
  });

  it('keeps an unknown cost as null and a missing score as undefined', () => {
    const r = parseRoutingLine(line(T, 'operational', '1. mistral/x gdp=none cost=unknown'))!;
    expect(r.candidates[0].cost).toBeNull();
    expect(r.candidates[0].gdp).toBeNull();
    expect(r.candidates[0].score).toBeUndefined();
  });

  it('reads an empty pool "(none)" as no candidates', () => {
    const r = parseRoutingLine(line(T, 'planning', '(none)'))!;
    expect(r.candidates).toEqual([]);
  });

  it('returns null for lines that are not routing lines', () => {
    expect(parseRoutingLine(`${T}  [proj/2559] [stream] claude-bridge/x finished`)).toBeNull();
    expect(parseRoutingLine('garbage')).toBeNull();
  });
});

describe('firstChoiceAsOf — the pool in effect at the decision time', () => {
  // The router writes a routing line only when a group's pool changes (debugLogOnce),
  // so the pool in effect is the last line of that group and process at or before the decision.
  const at = (sec: number) => Date.parse(`2026-10-27T14:00:00.000Z`) + sec * 1000;
  const L = (sec: number, group: string, proc: string, pool: string) =>
    parseRoutingLine(`${new Date(at(sec)).toISOString()}  [${proc}] [routing] group=${group} method=best candidates: ${pool} || excluded: (none)`)!;

  const lines: RoutingLine[] = [
    L(0, 'planning', 'proj/2559', '1. claude-bridge/claude-sonnet-5-5 gdp=1837.82 cost=0.000002'),
    L(100, 'planning', 'proj/2559', '(none)'),
    L(50, 'planning', 'other/89083', '1. mistral/zai-glm-5-3 gdp=1650.73 cost=1.4'),
  ];

  it('takes the latest line of the same group and process at or before the decision', () => {
    expect(firstChoiceAsOf(lines, 'planning', 'proj/2559', at(60))).toEqual({
      status: 'matched',
      ref: 'claude-bridge/claude-sonnet-5-5',
      lineTs: at(0),
    });
  });

  it('a later line does not count, even if it is the next state', () => {
    expect(firstChoiceAsOf(lines, 'planning', 'proj/2559', at(60)).status).toBe('matched');
    expect(firstChoiceAsOf(lines, 'planning', 'proj/2559', at(120))).toEqual({
      status: 'empty',
      ref: null,
      lineTs: at(100),
    });
  });

  it('ignores other processes', () => {
    expect(firstChoiceAsOf(lines, 'planning', 'other/89083', at(60))).toEqual({
      status: 'matched',
      ref: 'mistral/zai-glm-5-3',
      lineTs: at(50),
    });
  });

  it('ignores other groups', () => {
    expect(firstChoiceAsOf(lines, 'tactical', 'proj/2559', at(60))).toEqual({
      status: 'none',
      ref: null,
      lineTs: null,
    });
  });
});

describe('calibrate', () => {
  it('counts how often the logged first choice equals the model that served the turn', () => {
    const rows = [
      { served: 'claude-bridge/claude-sonnet-5-5', ref: 'claude-bridge/claude-sonnet-5-5' },
      { served: 'mistral/zai-glm-5-3', ref: 'claude-bridge/claude-sonnet-5-5' },
      { served: 'mistral/zai-glm-5-3', ref: null },
    ];
    expect(calibrate(rows)).toEqual({ compared: 2, agree: 1, unmatched: 1 });
  });
});
