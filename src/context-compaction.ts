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
// 5c (the fresh-session suggestion, src/fresh-session.ts) runs from the same
// turn-boundary evaluation below. Pi's own cache warms (pi 1.6+, recorded as
// `cache_warm` session usage entries) count as steps for the cold signal
// (docs/plans/2026-11-20-honor-pi-cache-warming.md). 5d (summarize via a
// cheaper model through the session_before_compact hook) is later. SEAM: a custom summarizer model would hook in right where this
// module calls ctx.compact() — pass its group/instructions instead of the
// plain compact() call below.

import type { Config, ContextBudgetConfig, UsageLogEntry } from './types.ts';
import { fmt, textOf } from './utils.ts';
import { routerLog, warnLog } from './logger.ts';
import { decideFreshStart, freshStatusLine } from './fresh-session.ts';
import { latestCacheWarm } from './cache-warming.ts';

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
 *
 * Heuristic caveat (review M4): the log is shared across sessions — with
 * concurrent sessions, or right after resuming one, the "last step" can be
 * another session's. A misfire then is bounded to one wasteful-direction
 * full-price step (the cost the feature already accepts on a genuine cold
 * start) or a conservative miss; never a wrong exclusion. Opt-in only.
 */
export function lastStepCacheState(
  usageLog: UsageLogEntry[] | undefined,
  sessionEntries?: readonly unknown[]
): LastStepCacheState {
  const last = usageLog?.[usageLog.length - 1];
  const step: LastStepCacheState = last
    ? { cacheShare: last.tokens > 0 ? (last.cacheRead ?? 0) / last.tokens : null, ts: last.ts }
    : { cacheShare: null, ts: null };
  // Pi's cache warms (honor-pi-cache-warming, step 3) live in the SESSION,
  // not in usage_log: a warm newer than the last step is the cache's latest
  // state — it resets the idle clock and carries its own cache share.
  const warm = latestCacheWarm(sessionEntries);
  return warm && (step.ts === null || warm.ts > step.ts) ? warm : step;
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
export function isCacheCold(
  budget: ContextBudgetConfig,
  last: LastStepCacheState,
  now: number
): boolean {
  if (last.ts === null) return true;
  if (last.cacheShare !== null && last.cacheShare < CACHE_MISS_SHARE_THRESHOLD) return true;
  const ttlMs =
    typeof budget.cache_ttl_s === 'number' && budget.cache_ttl_s > 0
      ? budget.cache_ttl_s * 1000
      : undefined;
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
export function resolveContextBudget(
  cfg: Config,
  group: string | null
): ContextBudgetConfig | undefined {
  const globalBudget = cfg.context_budget;
  const groupBudget = group ? cfg.model_groups?.[group]?.context_budget : undefined;
  if (!globalBudget && !groupBudget) return undefined;
  return { ...globalBudget, ...groupBudget };
}

/** Mutable state the hint cooldown and the per-session compaction tally live in
 * (owned by the event-handler closure; process-lifetime — a Pi restart resets
 * the tally, documented in the fresh-session plan). */
export interface CompactionRunState {
  lastHintAt: number;
  /** Completed compactions in the CURRENT session. Drives the fresh-session
   * "compaction is not sticking" trigger (step 5c). Counts ONLY through
   * noteSessionCompaction() (the session_compact event handler): 5b's own
   * compactions, manual /compact, and /router fresh alike — never the 5b
   * decision itself (a compaction counts once, when it COMPLETES). Reset by
   * resetSessionTally() on real session switches (PR #193 review P2). */
  compactionsRun: number;
  /** turnSeq value when the current session started; stepsThisSession is the
   * difference (the raw turnSeq is a process-lifetime log id — never reset). */
  turnSeqAtStart: number;
}

/**
 * The single tally increment for completed compactions: the session_compact
 * event handler calls this. Kept exported (not inline) so the tally contract
 * is unit-testable and cannot silently double-count from the 5b decision path.
 */
/**
 * Reset the PER-SESSION trigger inputs on a real session switch
 * (`new`/`resume`/`fork` — the same reasons as the session-anchor reset, not
 * subagent `startup`, which must not clobber the main session's state).
 * Without this, `/new` and `/router fresh` would inherit the old session's
 * compaction tally (the handover compaction would count into the new
 * session) and "steps in the session" would keep the old count. lastHintAt
 * survives: the notify cooldown is a process courtesy, not a session property.
 */
export function resetSessionTally(state: CompactionRunState, turnSeq: number): void {
  state.compactionsRun = 0;
  state.turnSeqAtStart = turnSeq;
}

export function noteSessionCompaction(state: CompactionRunState): void {
  state.compactionsRun += 1;
}

/** The Pi-side surface runContextCompaction needs (duck-typed for tests).
 * Pi's real ContextUsage carries `contextWindow` too — the fresh-session
 * share gate reads it when present (src/fresh-session.ts). */
export interface CompactionCtx {
  getContextUsage(): { tokens: number | null; contextWindow?: number } | undefined;
  /** Pi's session — its current branch carries the `cache_warm` usage records. */
  sessionManager?: { getBranch(): readonly unknown[] };
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
  /** Turns this session has seen (rt.turnSeq; process-lifetime approximation). */
  stepsThisSession?: number;
  now?: number;
}): void {
  try {
    runContextCompactionInner(opts);
  } catch (err) {
    warnLog(
      `[compaction] evaluation failed (fail-open, no compaction): ${err instanceof Error ? err.message : textOf(err)}`
    );
  }
}

function runContextCompactionInner(opts: Parameters<typeof runContextCompaction>[0]): void {
  const budget = resolveContextBudget(opts.cfg, opts.activeGroup);
  if (!budget) return;

  const now = opts.now ?? Date.now();
  const usage = opts.ctx.getContextUsage?.();
  const tokens = usage?.tokens ?? null;
  if (tokens === null || !(tokens > 0)) return; // unknown right after a compaction
  // One cache state for both 5b and 5c: the last usage_log step or Pi's
  // latest cache warm, whichever is newer. Only the CURRENT branch's warms:
  // Pi appends a warm under the leaf, so after /tree navigation the session
  // also holds warms of abandoned branches (Pi's warmer judges on the branch too).
  const last = lastStepCacheState(opts.usageLog, opts.ctx.sessionManager?.getBranch());

  // Nothing configured → measurement only (5a already records), no 5b hints.
  // The 5c fresh-session suggestion below does NOT need the thresholds — its
  // gates are the context share and the cold/idle/stuck conditions, so a user
  // who switches it on without soft/hard tokens still gets it (PR #193
  // review P1: it used to sit behind this early return, dead, while the
  // status line reported the switch as on).
  if ((budget.soft_tokens ?? 0) > 0 || (budget.hard_tokens ?? 0) > 0) {
    const decision = decideCompaction(budget, tokens, last, now);
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

  // Task-type balancing step 5c: a fresh session may beat continuing. Shares
  // the hint cooldown with the 5b hint (at most one nag per HINT_COOLDOWN_MS).
  if (budget.fresh_session?.enabled === true) {
    const fresh = decideFreshStart({
      budget,
      freshEnabled: true,
      cold: isCacheCold(budget, last, now),
      contextTokens: tokens,
      contextWindow: usage?.contextWindow ?? null,
      idleSeconds: last.ts !== null ? Math.round((now - last.ts) / 1000) : null,
      stepsSinceSessionStart: opts.stepsThisSession ?? 0,
      compactionsThisSession: opts.state.compactionsRun,
    });
    if (fresh.suggest && now - opts.state.lastHintAt >= HINT_COOLDOWN_MS) {
      opts.state.lastHintAt = now;
      const line = `[router] ${freshStatusLine(fresh)}`;
      routerLog(`[compaction] ${line}`);
      opts.ctx.ui.notify(line, 'info');
    }
  }
}
