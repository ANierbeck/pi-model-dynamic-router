// Why a model sits where it does in a `best` group (src/rank-explain.ts).
// Pure: the final order and the scoring functions in, one short reason per
// model out. Regression behind it: the overview said "best gdpval" and showed
// a GDP column that contradicted the order (sonnet before opus), with nothing
// saying that the order follows the group's score column and a price rule
// inside a quality window.

import { describe, it, expect } from 'vitest';
import { explainBestRanking, describeBestMethod } from '../src/rank-explain.ts';

const scores: Record<string, number> = { sonnet: 1823, opus: 1807, glm: 1500, tiny: 1000 };
const costs: Record<string, number | 'unknown'> = { sonnet: 2, opus: 4, glm: 0, tiny: 'unknown' };
const base = {
  scoreOf: (r: string) => scores[r],
  costOf: (r: string) => costs[r],
  isProfiled: () => true,
  window: 0.05,
};

describe('explainBestRanking', () => {
  it('names the top score and the gap of the runner-up when the score order stands', () => {
    const why = explainBestRanking({ ...base, ranked: ['sonnet', 'opus'] });
    expect(why.get('sonnet')).toBe('top score');
    expect(why.get('opus')).toBe('−0.9% score');
  });

  it('says a model is first despite a lower score because it is cheaper inside the window', () => {
    // opus (top score) is ranked behind the cheaper sonnet: sonnet is 4.9 % below it
    const s = { ...scores, sonnet: 1909, opus: 2007 };
    const why = explainBestRanking({ ...base, scoreOf: (r) => s[r], ranked: ['sonnet', 'opus', 'glm'] });
    expect(why.get('sonnet')).toBe('−4.9% score, in window, cheaper');
    expect(why.get('opus')).toBe('top score');
    expect(why.get('glm')).toMatch(/^−\d+\.\d% score$/);
  });

  it('says "same price" when the promoted model costs the same as the top-scoring one', () => {
    const s = { ...scores, sonnet: 1909, opus: 2007 };
    const why = explainBestRanking({
      ...base,
      scoreOf: (r) => s[r],
      costOf: () => 0,
      ranked: ['sonnet', 'opus'],
    });
    expect(why.get('sonnet')).toBe('−4.9% score, in window, same price');
  });

  it('does not claim "cheaper" when a cost is unknown', () => {
    const s = { ...scores, sonnet: 1909, opus: 2007 };
    const why = explainBestRanking({
      ...base,
      scoreOf: (r) => s[r],
      costOf: (r) => (r === 'opus' ? 'unknown' : 2),
      ranked: ['sonnet', 'opus'],
    });
    expect(why.get('sonnet')).toBe('−4.9% score, in window');
  });

  it('never mentions a window when none is configured', () => {
    const s = { ...scores, sonnet: 1909, opus: 2007 };
    const why = explainBestRanking({ ...base, scoreOf: (r) => s[r], window: 0, ranked: ['opus', 'sonnet'] });
    expect(why.get('opus')).toBe('top score');
    expect(why.get('sonnet')).toBe('−4.9% score');
  });

  it('marks models without a profile value, which rank after all profiled ones', () => {
    const why = explainBestRanking({ ...base, isProfiled: (r) => r !== 'tiny', ranked: ['sonnet', 'opus', 'tiny'] });
    expect(why.get('tiny')).toBe('no profile, by GDPval');
    expect(why.get('sonnet')).toBe('top score');
  });

  it('explains nothing for a single model', () => {
    expect(explainBestRanking({ ...base, ranked: ['sonnet'] }).size).toBe(0);
  });
});

describe('describeBestMethod — the header names the real sort key', () => {
  it('names the score column and the window', () => {
    expect(describeBestMethod('briefcase', 0.05)).toBe('best by briefcase · 5% window');
    expect(describeBestMethod('coding', 0.05)).toBe('best by coding · 5% window');
  });

  it('falls back to gdpval and omits the window when it is off', () => {
    expect(describeBestMethod(undefined, 0)).toBe('best by gdpval');
    expect(describeBestMethod('gdpval', undefined)).toBe('best by gdpval');
  });

  it('prints a fractional window without float noise', () => {
    expect(describeBestMethod('briefcase', 0.075)).toBe('best by briefcase · 7.5% window');
  });
});
