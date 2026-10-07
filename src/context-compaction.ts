// src/context-compaction.ts
// Task-type-balancing Phase 5b (docs/plans/2026-10-05-task-type-balancing.md):
// cache-aware compaction.
//
// Measurement context (Phase 5, zai-glm-5-3, 2026-10-02..05): cacheRead was
// 72% of $92 over 4 days — the burner is context VOLUME, not the hit rate.
// A COLD cache is the CHEAPEST moment to compact: after a miss the next step
// pays full input price anyway, so compacting then discards nothing already
// paid for; compacting a WARM cache throws a paid cache away. Break-even for
// a typical turn (20-25 steps) is reached within the turn.
//
// Owner decisions (2026-10-05, binding):
//   - Auto-compaction is OPT-IN, default off. Measurement is always on
//     (shipped in Phase 5a: usage_log cacheRead/cacheWrite).
//   - Compaction runs ONLY between turns (the turn_start hook in
//     event-handlers.ts), never between tool steps of a running turn.
//   - When disabled, the same conditions only produce a HINT ("compacting
//     now would pay off: /compact") via ctx.ui.notify.
//
// Config: `context_budget: { enabled, soft_tokens, hard_tokens, cache_ttl_s }`
// globally and per group (per-group fields win over the global ones). Absent
// everywhere = feature off — measurement only, no hints. Setting thresholds
// opts into the hints; `enabled: true` additionally automates them.
//
// 5c (fresh-session suggestion) is deferred to 2.0 by owner decision; 5d
// (summarize via a cheaper model through the session_before_compact hook)
// is later. SEAM: a custom summarizer model would hook in right where this
// module calls ctx.compact() — pass its group/instructions instead of the
// plain compact() call below.

import type { Config, ContextBudgetConfig, UsageLogEntry } from './types.ts';
import { fmt } from './utils.ts';
import { routerLog, warnLog } from './logger.ts';

/**
 * Below this share of cached context the last step counts as a MISS (cold):
 * most of the context was reprocessed fresh. A warm provider cache serves
 * ~97% (Phase 5 measurement), a full miss ~0%, a broken prefix somewhere in
 * between — 0.5 separates "mostly served from cache" from "mostly reprocessed".
 */
export const CACHE_MISS_SHARE_THRESHOLD = 0.5;

/** Hints are nags if repeated every turn boundary — cool down to one per 30 min. */
export const HINT_COOLDOWN_MS = 30 * 60 * 1000;

/** Cache state of the last recorded step, derived from usage_log (Phase 5a). */
export interface LastStepCacheState {
  /** cacheRead share of the step's tokens; null when no step was recorded. */
  cacheShare: number | null;
  /** Timestamp of the last step; null when no step was recorded yet. */
  ts: number | null;
}

/**
 * The last step's cache state from the persistent usage_log. An entry without
 * `cacheRead` is a full miss (share 0): the provider reported no cached
 * context — either it caches nothing or the cache missed entirely.
 */
export function lastStepCacheState(usageLog: UsageLogEntry[] | undefined): LastStepCacheState {
  const last = usageLog?.[usageLog.length - 1];
  if (!last) return { cacheShare: null, ts: null };
  return {
    cacheShare: last.tokens > 0 ? (last.cacheRead ?? 0) / last.tokens : null,
    ts: last.ts,
  };
}

/**
 * Whether the provider cache is COLD at `now`:
 *   - no step recorded yet (fresh/resumed session) — nothing was paid into a
 *     cache this session knows of;
 *   - the last step was a miss (cache share below CACHE_MISS_SHARE_THRESHOLD);
 *   - the idle gap since the last step exceeds cache_ttl_s (TTL expiry).
 * Conservative when nothing can be judged: a RECENT step with unknown cache
 * share is not cold (no evidence of a miss, no idle gap).
 */
export function isCacheCold(budget: ContextBudgetConfig, last: LastStepCacheState, now: number): boolean {
  if (last.ts === null) return true;
  if (last.cacheShare !== null && last.cacheShare < CACHE_MISS_SHARE_THRESHOLD) return true;
  const ttlMs = typeof budget.cache_ttl_s === 'number' && budget.cache_ttl_s > 0 ? budget.cache_ttl_s * 1000 : undefined;
  if (ttlMs !== undefined && now - last.ts > ttlMs) return true;
  return false;
}

/** Which condition asked for the compaction. */
export type CompactionReason = 'over-hard' | 'cold-over-soft';

export type CompactionDecision =
  | { action: 'compact'; reason: CompactionReason }
  | { action: 'hint'; reason: CompactionReason }
  | { action: 'none' };

/**
 * The pure trigger evaluation (unit-tested on its own):
 *   - context > hard_tokens regardless of cache state → compact/hint;
 *   - cold cache AND context > soft_tokens → compact/hint;
 *   - otherwise leave the (warm) cache alone.
 * `compact` only when `enabled`; the same conditions produce a `hint` when
 * disabled. No thresholds configured → `none` (default off: measurement
 * only — hints would nag users who never opted into the feature).
 */
export function decideCompaction(
  budget: ContextBudgetConfig | undefined,
  contextTokens: number | null,
  last: LastStepCacheState,
  now: number
): CompactionDecision {
  if (!budget) return { action: 'none' };
  const soft = budget.soft_tokens ?? 0;
  const hard = budget.hard_tokens ?? 0;
  if (!(soft > 0) && !(hard > 0)) return { action: 'none' };
  if (contextTokens === null || !(contextTokens > 0)) return { action: 'none' };

  if (hard > 0 && contextTokens > hard) {
    return budget.enabled
      ? { action: 'compact', reason: 'over-hard' }
      : { action: 'hint', reason: 'over-hard' };
  }
  if (soft > 0 && contextTokens > soft && isCacheCold(budget, last, now)) {
    return budget.enabled
      ? { action: 'compact', reason: 'cold-over-soft' }
      : { action: 'hint', reason: 'cold-over-soft' };
  }
  return { action: 'none' };
}

/**
 * The effective `context_budget` for a turn: the per-group fields win over
 * the global ones (absent group fields fall back to the global values —
 * deepMergeConfig layers whole objects the same way). `group` is the
 * session's ACTIVE group at the turn boundary; the upcoming turn's group is
 * classified only later, at prompt time.
 */
export function resolveContextBudget(cfg: Config, group: string | null): ContextBudgetConfig | undefined {
  const globalBudget = cfg.context_budget;
  const groupBudget = group ? cfg.model_groups?.[group]?.context_budget : undefined;
  if (!globalBudget && !groupBudget) return undefined;
  return { ...globalBudget, ...groupBudget };
}

/** Mutable state the hint cooldown lives in (owned by the event-handler closure). */
export interface CompactionRunState {
  lastHintAt: number;
}

/** The Pi-side surface runContextCompaction needs (duck-typed for tests). */
export interface CompactionCtx {
  getContextUsage(): { tokens: number | null } | undefined;
  compact(options?: { customInstructions?: string }): void;
  ui: { notify(message: string, type?: 'info' | 'warning' | 'error'): void };
}

/**
 * Evaluate the context budget at a TURN BOUNDARY and act on it. Called ONLY
 * from the turn_start hook (owner decision 2026-10-05): never between tool
 * steps of a running turn. Fire-and-forget: Pi's compact() runs without
 * awaiting completion. Fail-open: an evaluation error is logged and the
 * turn proceeds untouched — a compaction hint must never break a turn.
 */
export function runContextCompaction(opts: {
  ctx: CompactionCtx;
  cfg: Config;
  activeGroup: string | null;
  usageLog: UsageLogEntry[] | undefined;
  state: CompactionRunState;
  now?: number;
}): void {
  try {
    runContextCompactionInner(opts);
  } catch (err) {
    warnLog(`[compaction] evaluation failed (fail-open, no compaction): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function runContextCompactionInner(opts: Parameters<typeof runContextCompaction>[0]): void {
  const budget = resolveContextBudget(opts.cfg, opts.activeGroup);
  if (!budget) return;
  // Nothing configured → measurement only (5a already records), no hints.
  if (!((budget.soft_tokens ?? 0) > 0 || (budget.hard_tokens ?? 0) > 0)) return;

  const now = opts.now ?? Date.now();
  const usage = opts.ctx.getContextUsage?.();
  const tokens = usage?.tokens ?? null;
  if (tokens === null || !(tokens > 0)) return; // unknown right after a compaction

  const decision = decideCompaction(budget, tokens, lastStepCacheState(opts.usageLog), now);
  if (decision.action === 'compact') {
    routerLog(
      `[compaction] context ${fmt(tokens)} tokens (${decision.reason === 'over-hard' ? 'over hard limit' : 'cold cache, over soft limit'}) — compacting at the turn boundary`
    );
    // 5d seam: a cheaper-model custom summarizer would hook in here
    // (session_before_compact), instead of Pi's plain compact().
    opts.ctx.compact();
  } else if (decision.action === 'hint') {
    if (now - opts.state.lastHintAt < HINT_COOLDOWN_MS) return;
    opts.state.lastHintAt = now;
    const limit = decision.reason === 'over-hard' ? budget.hard_tokens : budget.soft_tokens;
    const why =
      decision.reason === 'over-hard'
        ? `above the hard limit (${fmt(limit!)})`
        : `over the soft limit (${fmt(limit!)}) with a cold cache`;
    const msg = `[router] context is ${fmt(tokens)} tokens — ${why}. Compacting now would pay off: /compact`;
    routerLog(`[compaction] hint: ${msg}`);
    opts.ctx.ui.notify(msg, 'info');
  }
}
