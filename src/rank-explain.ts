// Why a model sits where it does in a `best` group. Pure: the final order and
// the scoring functions in, one short reason per model out.
//
// The ranking itself lives in Router.rankByScore (score order, then a price
// rule inside the quality window, ADR-0023); this module only describes its
// outcome so the `/router` overview can show it. It never decides anything.

export interface ExplainInput {
  /** Refs in the order the router ranks them. */
  ranked: string[];
  /** The group's sort key for a model (GDPval, briefcase or coding score). */
  scoreOf: (ref: string) => number;
  costOf: (ref: string) => number | 'unknown';
  /** Whether the model has a value for the group's score column. */
  isProfiled: (ref: string) => boolean;
  /** Relative width of the quality window (0.05 = 5 %); 0 or absent = off. */
  window?: number | undefined;
}

const MINUS = '−';

const pct = (gap: number): string => `${MINUS}${(gap * 100).toFixed(1)}%`;

/**
 * One reason per model, keyed by ref. Empty for fewer than two models: a lone
 * candidate has no ranking to explain.
 *
 * - `top score`: the highest sort key in the group.
 * - `−x.x% score`: the gap to the top. Inside the window a model that the
 *   router ranked ahead of the top-scoring one adds `in window` and why:
 *   `cheaper`, `same price`, or nothing when a cost is unknown.
 * - `no profile, by GDPval`: no value for the score column; ranked after every
 *   profiled model on GDPval.
 */
export function explainBestRanking(input: ExplainInput): Map<string, string> {
  const { ranked, scoreOf, costOf, isProfiled } = input;
  const out = new Map<string, string>();
  if (ranked.length < 2) return out;

  const profiled = ranked.filter(isProfiled);
  for (const ref of ranked) if (!isProfiled(ref)) out.set(ref, 'no profile, by GDPval');
  if (profiled.length === 0) return out;

  const top = profiled.reduce((a, b) => (scoreOf(b) > scoreOf(a) ? b : a));
  const topScore = scoreOf(top);
  const w = input.window && input.window > 0 ? input.window : 0;
  const topIndex = ranked.indexOf(top);

  for (const ref of profiled) {
    if (ref === top) {
      out.set(ref, 'top score');
      continue;
    }
    const gap = topScore > 0 ? (topScore - scoreOf(ref)) / topScore : 0;
    const base = `${pct(gap)} score`;
    const inWindow = w > 0 && scoreOf(ref) >= topScore * (1 - w);
    if (!inWindow || ranked.indexOf(ref) > topIndex) {
      out.set(ref, base);
      continue;
    }
    // Ranked ahead of the top-scoring model although it scores lower: the window's price rule did it.
    const mine = costOf(ref);
    const theirs = costOf(top);
    const why = mine === 'unknown' || theirs === 'unknown' ? '' : mine < theirs ? ', cheaper' : mine === theirs ? ', same price' : '';
    out.set(ref, `${base}, in window${why}`);
  }
  return out;
}

/** Header text of a `best` group: the real sort key and the window, not a fixed "gdpval". */
export function describeBestMethod(scoreBy: string | undefined, window: number | undefined): string {
  const column = scoreBy === 'briefcase' || scoreBy === 'coding' ? scoreBy : 'gdpval';
  const w = window && window > 0 ? ` · ${Number((window * 100).toFixed(1))}% window` : '';
  return `best by ${column}${w}`;
}
