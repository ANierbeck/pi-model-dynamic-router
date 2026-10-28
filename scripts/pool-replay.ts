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

// ── Step 3 driver: pool content under the target layout ───────────────────
// Only two category changes move a pool (docs/research/2026-10-27-replay-category-changes.md):
//   design   : planning (floor 1700) → design (floor 1600, D5)
//   continue : tactical → standard when the session has no predecessor (D6)
// The other categories are pure renames of groups with identical pools.
// Pools are compared by CONTENT and head, never by who served (failover decides that).

import { universeAsOf, admit, rankBy, diffPools } from './pool-delta.ts';
import * as metrics from '../src/metrics.ts';

interface RawDecision { ts: number; proc: string; stage: string; category: string | null; group: string | null; prevCategory: string | null }

function readRawDecisions(file: string, bounds: Bounds): RawDecision[] {
  const out: RawDecision[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(r?.ts);
    if (Number.isNaN(ts) || typeof r?.proc !== 'string' || r.stage === 'pool' || r.stage === 'comparator') continue;
    if ((bounds.since !== undefined && ts < bounds.since) || (bounds.until !== undefined && ts > bounds.until)) continue;
    out.push({ ts, proc: r.proc, stage: r.stage, category: r.final?.category ?? null, group: r.final?.group ?? null, prevCategory: r.prev?.category ?? null });
  }
  return out;
}

function tally(xs: string[]): Record<string, number> {
  return xs.reduce<Record<string, number>>((a, x) => ({ ...a, [x]: (a[x] ?? 0) + 1 }), {});
}

function replayMain(): void {
  const bounds: Bounds = {};
  const since = flagValue('since'); const until = flagValue('until');
  if (since) bounds.since = Date.parse(since);
  if (until) bounds.until = Date.parse(until);
  const log = flagValue('log') ?? join(homedir(), '.pi', 'logs', 'classifier-decisions.jsonl');
  const routerLog = flagValue('router-log') ?? join(homedir(), '.pi', 'logs', 'router.log');
  const shipped = JSON.parse(readFileSync('router-config.json', 'utf8')) as Config;
  const cache = JSON.parse(readFileSync(flagValue('scan-cache') ?? 'dist/.cache/scan-cache.json', 'utf8'));
  // Billing classification needs the user's provider billing (e.g. a subscription
  // provider); take ONLY the billing fields of the user layer, nothing else.
  const userPath = flagValue('user-config') ?? join(homedir(), '.pi', 'agent', 'router-config.user.json');
  try {
    const user = JSON.parse(readFileSync(userPath, 'utf8')) as Config;
    const providers: Record<string, Record<string, unknown>> = { ...(shipped.providers as object) };
    for (const [name, p] of Object.entries(user.providers ?? {})) {
      const { billing, free_models } = p as unknown as Record<string, unknown>;
      providers[name] = { ...providers[name], ...(billing !== undefined ? { billing } : {}), ...(free_models !== undefined ? { free_models } : {}) };
    }
    (shipped as { providers?: unknown }).providers = providers;
  } catch { /* no user layer: shipped billing only */ }
  metrics.setConfig(shipped); metrics.setCache(cache); metrics.setModelRegistry({ find: () => undefined } as any);
  const designFloor = (targetLayout(shipped).model_groups as Record<string, Group>).design.min_gdpval!;
  const planningScoreBy = (shipped.model_groups as Record<string, Group>).planning.score_by;
  const score = (ref: string) => metrics.calculateScore(ref, planningScoreBy, shipped);

  const lines: RoutingLine[] = readFileSync(routerLog, 'utf8').split('\n').map(parseRoutingLine).filter((l): l is RoutingLine => l !== null);
  const decisions = readRawDecisions(log, bounds);
  const poolAt = (group: string, proc: string, ts: number) =>
    lines.filter((l) => l.group === group && l.proc === proc && l.ts <= ts).sort((a, b) => b.ts - a.ts)[0];

  console.log(`bounds: since=${since ?? '-'} until=${until ?? '-'}  decisions=${decisions.length}  routing lines=${lines.length}`);
  console.log(`design floor=${designFloor}, ranking column=${planningScoreBy} (scan-cache profiles as of today, not as of the decision)`);

  // design: planning pool (1700) vs the design pool (floor 1600 over the shown universe)
  const design = decisions.filter((d) => d.category === 'design');
  const dRows = design.map((d) => {
    const cur = poolAt('planning', d.proc, d.ts);
    if (!cur) return null;
    const target = rankBy(admit(universeAsOf(lines, d.proc, d.ts), designFloor), score).map((c) => c.ref);
    return diffPools(cur.candidates.map((c) => c.ref), target);
  });
  const dOk = dRows.filter((r): r is NonNullable<typeof r> => r !== null);
  console.log(`\n== design: ${design.length} decisions, ${dOk.length} with a planning pool line`);
  console.log(`   head changed: ${dOk.filter((r) => r.headChanged).length}/${dOk.length}`);
  console.log(`   added to the pool: ${JSON.stringify(tally(dOk.flatMap((r) => r.added)))}`);
  console.log(`   removed from the pool: ${JSON.stringify(tally(dOk.flatMap((r) => r.removed)))}`);
  console.log(`   current heads: ${JSON.stringify(tally(dOk.map((r) => String(r.currentHead))))}`);
  console.log(`   target heads : ${JSON.stringify(tally(dOk.map((r) => String(r.targetHead))))}`);

  // continue: tactical (today) vs standard (operational pool) — D6 applies without a predecessor
  const cont = decisions.filter((d) => d.category === 'continue');
  const noPrev = cont.filter((d) => d.prevCategory === null);
  const cRows = noPrev.map((d) => {
    const cur = poolAt(d.group ?? 'tactical', d.proc, d.ts);
    const tgt = poolAt('operational', d.proc, d.ts);
    if (!cur || !tgt) return null;
    return { d: diffPools(cur.candidates.map((c) => c.ref), tgt.candidates.map((c) => c.ref)), curHead: cur.candidates[0], tgtHead: tgt.candidates[0] };
  });
  const cOk = cRows.filter((r): r is NonNullable<typeof r> => r !== null);
  const afterContinue = cont.filter((d) => d.prevCategory === 'continue').length;
  console.log(`\n== continue: ${cont.length} decisions, ${noPrev.length} without a predecessor (D6 applies), ${afterContinue} after another continue (undecided), ${cOk.length} with both pool lines`);
  console.log(`   head changed: ${cOk.filter((r) => r.d.headChanged).length}/${cOk.length}`);
  console.log(`   current heads (tactical): ${JSON.stringify(tally(cOk.map((r) => String(r.curHead?.ref))))}`);
  console.log(`   target heads (standard) : ${JSON.stringify(tally(cOk.map((r) => String(r.tgtHead?.ref))))}`);
  // Billing as the router classifies it (metrics.billingTier), not the list price.
  const TIER = ['free', 'subscription', 'local', 'payg'];
  const billing = (c?: { ref: string }) => (c ? (TIER[metrics.billingTier(c.ref)] ?? 'unknown') : 'none');
  console.log(`   head billing today : ${JSON.stringify(tally(cOk.map((r) => billing(r.curHead))))}`);
  console.log(`   head billing target: ${JSON.stringify(tally(cOk.map((r) => billing(r.tgtHead))))}`);
}


if (process.argv[1] && process.argv[1].endsWith('pool-replay.ts')) {
  if (process.argv.includes('--calibrate')) calibrationMain();
  if (process.argv.includes('--replay')) replayMain();
}
