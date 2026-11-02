// Decision-time candidate pools read from router.log (docs/research/2026-10-27-pool-replay.md,
// route 1). Every `[routing] group=…` line is the ranked pool the router computed
// for one group at one moment, so it is the pool the decision was made from.
//
// Pure functions only: parsing, matching a turn to its line, and calibration
// against the model that served the turn. The file reading happens in the
// caller. Lines carry model refs and numbers, never prompt text.

export interface PoolCandidate {
  ref: string;
  gdp: number | null;
  cost: number | null;
  score?: number;
  flags: string[];
}

export interface RoutingLine {
  ts: number;
  proc: string;
  group: string;
  method: string;
  candidates: PoolCandidate[];
}

const LINE = /^(\S+)\s+\[([^\]]+)\]\s+\[routing\] group=(\S+) method=(\S+) candidates: (.*?) \|\| excluded: (.*)$/;

function parseCandidate(part: string): PoolCandidate | null {
  const tokens = part.trim().split(/\s+/);
  // The rank ("1.") comes first; the ref is the token after it.
  const refIndex = /^\d+\.$/.test(tokens[0] ?? '') ? 1 : 0;
  const ref = tokens[refIndex];
  if (!ref) return null;
  const c: PoolCandidate = { ref, gdp: null, cost: null, flags: [] };
  for (const tok of tokens.slice(refIndex + 1)) {
    const flag = tok.match(/^\[(\w+)\]$/);
    if (flag) {
      c.flags.push(flag[1]);
      continue;
    }
    const kv = tok.match(/^(gdp|cost|score)=(.+)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'score') c.score = Number(value);
    else {
      const n = Number(value);
      c[key as 'gdp' | 'cost'] = Number.isFinite(n) ? n : null;
    }
  }
  return c;
}

/** One routing line, or null when the line is not a routing line. */
export function parseRoutingLine(text: string): RoutingLine | null {
  const m = text.match(LINE);
  if (!m) return null;
  const [, iso, proc, group, method, pool] = m;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const candidates =
    pool.trim() === '(none)'
      ? []
      : pool
          .split(' | ')
          .map(parseCandidate)
          .filter((c): c is PoolCandidate => c !== null);
  return { ts, proc, group, method, candidates };
}

export type PoolState =
  | { status: 'matched'; ref: string; lineTs: number }
  | { status: 'empty'; ref: null; lineTs: number }
  | { status: 'none'; ref: null; lineTs: null };

/**
 * The pool in effect for `group` in process `proc` at time `at`: the latest
 * routing line of that group and process at or before `at`. The router writes
 * a line only when the group's pool changes, so the latest line is the state
 * until the next change.
 */
export function firstChoiceAsOf(lines: RoutingLine[], group: string, proc: string, at: number): PoolState {
  let latest: RoutingLine | null = null;
  for (const l of lines) {
    if (l.group !== group || l.proc !== proc || l.ts > at) continue;
    if (latest === null || l.ts > latest.ts) latest = l;
  }
  if (latest === null) return { status: 'none', ref: null, lineTs: null };
  const first = latest.candidates[0];
  return first
    ? { status: 'matched', ref: first.ref, lineTs: latest.ts }
    : { status: 'empty', ref: null, lineTs: latest.ts };
}

/** How often the logged first choice equals the model that served the turn. */
export function calibrate(rows: Array<{ served: string | null; ref: string | null }>): {
  compared: number;
  agree: number;
  unmatched: number;
} {
  let compared = 0;
  let agree = 0;
  let unmatched = 0;
  for (const r of rows) {
    if (r.ref === null) {
      unmatched += 1;
      continue;
    }
    compared += 1;
    if (r.served === r.ref) agree += 1;
  }
  return { compared, agree, unmatched };
}
