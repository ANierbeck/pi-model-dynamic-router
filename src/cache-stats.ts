// src/cache-stats.ts
// Phase 5a of docs/plans/2026-10-05-task-type-balancing.md — measurement of
// provider prompt-cache behaviour (always on, no behaviour change). Pure
// helpers shared by the usage_log writer, the /router cost report and the
// footer so all three agree on what "context" and "cache share" mean.

import type { UsageLogEntry } from './types.ts';
import { fmt } from './utils.ts';

/** The provider-reported usage block of an assistant message (all optional). */
export interface StepUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Tokens the model READ this step: fresh input + cache reads + cache writes. */
export function stepContextTokens(u: StepUsage): number {
  return num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
}

/** Share of the step's context served from the provider cache; null when empty. */
export function stepCacheShare(u: StepUsage): number | null {
  const ctx = stepContextTokens(u);
  return ctx > 0 ? num(u.cacheRead) / ctx : null;
}

/**
 * The usage_log entry for one completed step, or null when the provider
 * reported no usage (the caller then falls back to its own estimate).
 * `tokens` counts everything processed; cache fields appear only when
 * non-zero so entries of cache-less providers keep their old shape.
 */
export function buildUsageLogEntry(
  ref: string,
  u: StepUsage | undefined,
  ts: number
): UsageLogEntry | null {
  if (!u) return null;
  const cacheRead = num(u.cacheRead);
  const cacheWrite = num(u.cacheWrite);
  const tokens = num(u.input) + num(u.output) + cacheRead + cacheWrite;
  if (tokens <= 0) return null;
  const entry: UsageLogEntry = { ref, tokens, ts };
  if (cacheRead > 0) entry.cacheRead = cacheRead;
  if (cacheWrite > 0) entry.cacheWrite = cacheWrite;
  return entry;
}

/**
 * Footer segment, e.g. "ctx 182.0k · cache 97% · ~$0.03/step". `last` is the
 * most recent assistant step's usage; the cost part is the SESSION average
 * per step and is dropped when nothing was billed (subscription / free).
 */
export function formatCacheStatus(last: StepUsage | undefined, steps: number, totalCost: number): string {
  if (!last || steps <= 0) return '';
  const ctx = stepContextTokens(last);
  if (ctx <= 0) return '';
  const share = stepCacheShare(last) ?? 0;
  const parts = [`ctx ${fmt(ctx)}`, `cache ${Math.round(share * 100)}%`];
  if (totalCost > 0) parts.push(`~$${(totalCost / steps).toFixed(2)}/step`);
  return parts.join(' · ');
}
