// src/budget-pacing.ts
// Task-type-balancing Phase 4 (docs/plans/2026-10-05-task-type-balancing.md):
// generic budget pacing.
//
// `providers.<p>.budget` ({ amount, unit, period, reset_day }) declares a
// spend allowance for a provider — a capped subscription's monthly token
// tank as well as a pay-per-token spend limit. The router compares its OWN
// counter (usage_log; `tokens` includes cacheRead per Phase 5a) to the
// LINEAR target for the current period window and DEMOTES a provider that
// runs ahead of pace. Demotion is a rank penalty, never an exclusion
// (Router.resolveGroup's rank pass): a paced provider stays a candidate,
// it just ranks behind every on-pace candidate. Absent budget = feature off
// (default; nothing ships in router-config.json — user-layer key).
//
// The counter is deliberately approximate but honest: for unit 'tokens' it
// is the raw usage_log token sum (cached context counts — burning a
// subscription tank with resent context is exactly the workload this
// spreads); for unit 'usd' it is tokens × the router's blended $/1M effCost
// (the same figure the ranking's cost comparisons use; usage_log does not
// keep the in/out split, and unpriceable refs contribute $0 rather than
// blocking the whole provider).

import type { Config, UsageLogEntry } from './types.ts';
import { effCost } from './metrics.ts';

/** Declared spend allowance for one provider (user-layer config key). */
export interface ProviderBudget {
  /** Allowance per period window. Must be > 0. */
  amount: number;
  /** 'tokens' counts usage_log tokens (incl. cacheRead); 'usd' estimates spend via effCost. */
  unit: 'usd' | 'tokens';
  /** Only 'month' is supported today. */
  period: 'month';
  /** Day of month (1-31) the window starts; clamped to shorter months. */
  reset_day: number;
}

/** Memo bucket (single slot): pacedProviders() runs on every routed prompt. */
const MEMO_TTL_MS = 30_000;
let memo: {
  cfg: Config;
  log: UsageLogEntry[] | undefined;
  at: number;
  now: number;
  set: Set<string>;
} | null = null;

/** Test seam: drop the memo so a new fixture is evaluated immediately. */
export function resetBudgetPacingMemo(): void {
  memo = null;
}

function isFinitePositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** A budget is only honored when every field is present and valid (fail-open otherwise). */
function validBudget(b: unknown): b is ProviderBudget {
  if (!b || typeof b !== 'object') return false;
  const v = b as Partial<ProviderBudget>;
  const resetDay = v.reset_day;
  return (
    isFinitePositive(v.amount) &&
    (v.unit === 'usd' || v.unit === 'tokens') &&
    v.period === 'month' &&
    typeof resetDay === 'number' &&
    Number.isInteger(resetDay) &&
    resetDay >= 1 &&
    resetDay <= 31
  );
}

/**
 * Start of the current budget window: the most recent occurrence of
 * `resetDay` at 00:00 local time. A reset_day beyond a month's length is
 * clamped to that month's last day (reset_day 31 → Feb 28/29, Apr 30).
 */
export function budgetWindowStart(now: number, resetDay: number): number {
  const today = new Date(now);
  // Try this month first: start = <this month> <clamped resetDay> 00:00.
  const clamp = (y: number, m: number) => {
    const last = new Date(y, m + 1, 0).getDate(); // last day of month m
    return new Date(y, m, Math.min(resetDay, last), 0, 0, 0, 0).getTime();
  };
  const thisMonth = clamp(today.getFullYear(), today.getMonth());
  if (thisMonth <= now) return thisMonth;
  // The clamped day already passed (e.g. today is the 7th, reset_day 15) →
  // the window started in the previous month.
  const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return clamp(prev.getFullYear(), prev.getMonth());
}

/**
 * End of the current budget window: the clamped reset_day of the month
 * FOLLOWING the window start's month (Date rollover handles December).
 * Derived from the window start, not from `now`, so the clamping of short
 * months cannot skip a reset day (reset_day 31 with a Jan 30 now: window Dec
 * 31 → end Jan 31, not the clamped Feb 28).
 */
function budgetWindowEnd(now: number, resetDay: number): number {
  const start = new Date(budgetWindowStart(now, resetDay));
  const lastDayOfNextMonth = new Date(start.getFullYear(), start.getMonth() + 2, 0).getDate();
  return new Date(
    start.getFullYear(),
    start.getMonth() + 1,
    Math.min(resetDay, lastDayOfNextMonth),
    0, 0, 0, 0
  ).getTime();
}

/**
 * The LINEAR target for the point in time `now`: `amount` scaled by the
 * elapsed fraction of the current window. 0 at the window start, `amount`
 * at its end. Anything spent beyond it is "ahead of pace".
 */
export function linearPaceTarget(budget: ProviderBudget, now: number): number {
  const start = budgetWindowStart(now, budget.reset_day);
  const end = budgetWindowEnd(now, budget.reset_day);
  const span = end - start;
  if (span <= 0) return budget.amount; // unreachable with a valid month window; fail-safe
  const fraction = (now - start) / span;
  return budget.amount * Math.min(1, Math.max(0, fraction));
}

/** Whether `used` (tokens or USD, matching the budget's unit) is ahead of the linear pace. */
export function isAheadOfPace(budget: ProviderBudget, used: number, now: number): boolean {
  return used > linearPaceTarget(budget, now);
}

/**
 * The provider's own counter for the current window (Phase 5a accounting:
 * usage_log `tokens` already include cacheRead/cacheWrite).
 */
export function providerSpend(
  budget: ProviderBudget,
  provider: string,
  usageLog: UsageLogEntry[] | undefined,
  now: number
): number {
  const windowStart = budgetWindowStart(now, budget.reset_day);
  let sum = 0;
  for (const e of usageLog ?? []) {
    if (e.ts < windowStart) continue;
    if (e.ref.split('/')[0] !== provider) continue;
    if (budget.unit === 'tokens') {
      sum += e.tokens;
    } else {
      const cost = effCost(e.ref);
      if (cost !== 'unknown') sum += (e.tokens * cost) / 1_000_000;
    }
  }
  return sum;
}

/**
 * Providers currently ahead of their declared budget pace (empty set when
 * no provider declares a budget — the default). Memoized for MEMO_TTL_MS:
 * resolveGroup runs on every routed prompt and the scan over usage_log is
 * only worth doing once in a while; a 30s staleness is irrelevant to a
 * monthly pace.
 */
export function pacedProviders(
  cfg: Config,
  usageLog: UsageLogEntry[] | undefined,
  now: number = Date.now()
): Set<string> {
  if (memo && memo.cfg === cfg && memo.log === usageLog && now - memo.at < MEMO_TTL_MS && now >= memo.now) {
    return memo.set;
  }
  const set = new Set<string>();
  for (const [prov, provCfg] of Object.entries(cfg.providers ?? {})) {
    const budget = (provCfg as { budget?: unknown }).budget;
    if (!validBudget(budget)) continue;
    const spend = providerSpend(budget, prov, usageLog, now);
    if (spend > 0 && isAheadOfPace(budget, spend, now)) set.add(prov);
  }
  memo = { cfg, log: usageLog, at: now, now, set };
  return set;
}
