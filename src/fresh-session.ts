/**
 * Task-type balancing step 5c (docs/plans/2026-11-19-fresh-session-suggestion.md):
 * when the context cache stops paying off — cold cache, large context,
 * compaction not sticking — a FRESH session with a handoff summary beats
 * continuing. Advisory only: the suggestion is narration; the switch is the
 * user's `/router fresh` command (Pi allows newSession() only from
 * user-invoked commands). Signal inputs come from the Phase-5a measurement
 * (usage_log cacheRead share) and Phase-5b state (per-session compaction
 * count); nothing is hardcoded per user — every threshold is a code default
 * recorded here and in src/config-keys.ts.
 */
import type { ContextBudgetConfig } from './types.ts';

export const FRESH_DEFAULTS = {
  /** Only suggest at or above this context share of the model's window. */
  min_ctx_share: 0.6,
  /** Only suggest after at least this many steps in the session. */
  after_turns: 10,
  /** An idle gap longer than this (seconds) counts as "cache went cold from idling". */
  cold_idle_s: 15 * 60,
} as const;

export interface FreshSessionInputs {
  budget: ContextBudgetConfig | undefined;
  /** `context_budget.fresh_session.enabled` — the opt-in switch (default off). */
  freshEnabled: boolean;
  /** Cache cold in the 5b sense (miss share, TTL expiry, or no data). */
  cold: boolean;
  contextTokens: number | null;
  contextWindow: number | null;
  /** Idle gap since the last recorded step, in seconds; null when unknown. */
  idleSeconds: number | null;
  stepsSinceSessionStart: number;
  /** How often 5b compaction already ran in THIS session (0 after a restart). */
  compactionsThisSession: number;
}

export type FreshSessionDecision = { suggest: true; reason: string } | { suggest: false };

/**
 * Pure trigger evaluation (unit-tested on its own). Ordering is load-bearing:
 * the cheap gates (feature on, tokens known, step count, context share) fire
 * before the expensive condition; the share gate caps the suggestion to
 * contexts that are actually large for the model's window.
 */
export function decideFreshStart(i: FreshSessionInputs): FreshSessionDecision {
  if (!i.freshEnabled || !i.budget) return { suggest: false };
  if (i.contextTokens === null || !(i.contextTokens > 0)) return { suggest: false };
  if (i.stepsSinceSessionStart < FRESH_DEFAULTS.after_turns) return { suggest: false };
  if (i.contextWindow === null || !(i.contextWindow > 0)) return { suggest: false };
  if (i.contextTokens / i.contextWindow < FRESH_DEFAULTS.min_ctx_share) return { suggest: false };
  const idledOut = i.idleSeconds !== null && i.idleSeconds > FRESH_DEFAULTS.cold_idle_s;
  const stuck = i.compactionsThisSession >= 2 && i.contextTokens >= (i.budget.soft_tokens ?? 0);
  if (!(i.cold || idledOut || stuck)) return { suggest: false };
  const reason = idledOut
    ? 'cache went cold from idling; a fresh session restarts cheap'
    : stuck
      ? 'compaction is not sticking: context grew back; a fresh session wins'
      : 'cache cold and context large: continuing pays full price either way';
  return { suggest: true, reason };
}

/** One narration line; used by the 5b hint channel and `/router` status. */
export function freshStatusLine(d: FreshSessionDecision): string {
  return d.suggest ? `fresh session suggested — ${d.reason} — /router fresh` : '';
}

/** Ask-for-summary instructions handed to Pi's compaction for the handoff doc. */
export const FRESH_SUMMARY_PROMPT =
  'Summarise this session for a handover: the task, decisions made, files ' +
  'touched, and the exact next step. Be terse.';

/**
 * How long `/router fresh` waits for the compaction summary before shipping a
 * skeleton handoff (fail-open: a slow summary never blocks the handover).
 */
export const FRESH_WAIT_MS = 30_000;

/** The first prompt the new session receives: the summary plus the carry-over. */
export function freshHandoffMessage(summary: string | null, nextStep: string | null): string {
  const head = summary
    ? `Handover from the previous session (start fresh from here):\n\n${summary}`
    : 'Handover from the previous session; the summary was unavailable — read ' +
      'the last milestone in the session history and continue from there.';
  return nextStep ? `${head}\n\nNext step (user): ${nextStep}` : head;
}
