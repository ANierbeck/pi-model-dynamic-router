// Target layout of the 5-group plan (docs/plans/2026-10-25-category-group-mismatch.md,
// Step 2): the category → group mapping and the layout as a pure config transform.
//
// `--calibrate` (route 1) reads the pool in effect at each decision from
// router.log and compares its first candidate with the served model. The layout
// replay that runs targetLayout() against the decision log is NOT here yet: the
// first choice does not reproduce (see docs/research/2026-10-28-route-calibration.md),
// so the replay must first model the failover order. Its earlier attempt used the
// scan cache, which does not carry the claude-bridge models (docs/research/2026-10-27-pool-replay.md).

import type { Config, Group } from '../src/types.ts';

const CATEGORY_TARGET: Record<string, string | null> = {
  simple: 'simple',
  code_simple: 'simple',
  standard: 'standard',
  code_complex: 'code_complex',
  design: 'design',
  planning: 'planning',
  continue: null,
};

/** Target group for a category (D4, D7); null when the category is not replayed. */
export function targetGroupFor(category: string): string | null {
  return Object.prototype.hasOwnProperty.call(CATEGORY_TARGET, category) ? CATEGORY_TARGET[category] : null;
}

/**
 * The five-group layout as a config transform (D2, D4, D5). Pure: the shipped
 * config is not mutated. Failover chains are cleared, so the replay compares
 * first choices only.
 *   standard    ← operational   (rename)
 *   simple      ← scout         (the equivalence note: identical lists)
 *   code_complex← tactical      (rename)
 *   planning    ← planning      (unchanged)
 *   design      ← planning, floor 1600 (D5)
 */
export function targetLayout(shipped: Config): Config {
  const g = shipped.model_groups as Record<string, Group>;
  const bare = (name: string): Group => ({ ...g[name], fallback_groups: [] });
  const model_groups: Record<string, Group> = {
    simple: bare('scout'),
    standard: bare('operational'),
    code_complex: bare('tactical'),
    planning: bare('planning'),
    design: { ...bare('planning'), min_gdpval: 1600 },
  };
  if (g.dynamic) model_groups.dynamic = g.dynamic;
  return { ...shipped, model_groups };
}



// ── Route 1 driver: decision-time pools from router.log ───────────────────
// Calibration: for each matched turn, the first candidate of the routing line
// of the group the decision was routed to, compared with the model that
// served the turn. This checks the pool source before any layout is replayed.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseRoutingLine, firstChoiceAsOf, calibrate, type RoutingLine } from './route-pool-log.ts';
import { readSessionTurns, readDecisions, joinTurns, type Bounds } from './turn-decision-join.ts';

const flagValue = (name: string): string | undefined =>
  process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

function calibrationMain(): void {
  const since = flagValue('since');
  const until = flagValue('until');
  const bounds: Bounds = {};
  if (since) bounds.since = Date.parse(since);
  if (until) bounds.until = Date.parse(until);
  const encoded = process.cwd().replace(/^\//, '').replace(/\//g, '-');
  const sessions = flagValue('sessions') ?? join(homedir(), '.pi', 'agent', 'sessions', `--${encoded}--`);
  const log = flagValue('log') ?? join(homedir(), '.pi', 'logs', 'classifier-decisions.jsonl');
  const routerLog = flagValue('router-log') ?? join(homedir(), '.pi', 'logs', 'router.log');

  const lines: RoutingLine[] = readFileSync(routerLog, 'utf8')
    .split('\n')
    .map(parseRoutingLine)
    .filter((l): l is RoutingLine => l !== null);

  const joined = joinTurns(readSessionTurns(sessions, bounds), readDecisions(log, bounds));
  const matched = joined.filter((j) => j.status === 'matched' && j.group !== null && j.category !== 'continue');

  // The pool in effect when the decision was made: the latest routing line of
  // that group and process at or before the decision time.
  const rows = matched.map((t) => {
    const state = t.proc && t.decisionTs !== null
      ? firstChoiceAsOf(lines, t.group as string, t.proc, t.decisionTs)
      : { status: 'none' as const, ref: null, lineTs: null };
    return { category: t.category as string, served: t.served, ref: state.ref, status: state.status };
  });
  const c = calibrate(rows);
  const byStatus = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});

  console.log(`bounds: since=${since ?? '-'} until=${until ?? '-'}`);
  console.log(`routing lines=${lines.length} matched turns=${matched.length}`);
  console.log(`pool state: ${JSON.stringify(byStatus)}`);
  console.log(`calibration (pool first choice = served model): agree ${c.agree}/${c.compared} compared, ${c.unmatched} without a pool line`);
}

if (process.argv[1] && process.argv[1].endsWith('pool-replay.ts') && process.argv.includes('--calibrate')) calibrationMain();
