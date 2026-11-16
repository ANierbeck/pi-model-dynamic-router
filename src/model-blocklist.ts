// src/model-blocklist.ts
// Learned model blocklist (ADR-0008).
//
// Tier 1: a failure matching a known-permanent signature (error-signatures.ts)
// blocks the model on first sight.
// Tier 2: an unknown signature is counted per model; TIER2_MIN_FAILURES
// consecutive failures with the same signature, spanning at least
// TIER2_MIN_SPAN_MS, with no success in between, block the model. Known-
// transient failures neither count nor reset the streak. Local providers are
// never promoted: their failures are daemon trouble, not model properties.
//
// Blocked models are dropped from candidate lists at runtime. A Tier-2 block
// expires BLOCKLIST_TTL_MS after its last observation so the model is
// re-probed; a repeated failure with the same signature re-blocks it, a
// success clears it. A Tier-1 (permanent) block never expires: those
// signatures state a property of the MODEL (retired, guardrailed, gated), not
// of the moment, and re-admitting the model every 7 days only produced a
// block/re-block churn (plan 2026-11-16-permanent-blocklist-no-ttl).
//
// State lives in the cache object, not in module variables: esbuild bundles
// some modules twice, and module-level state would diverge (same rationale as
// model-health.ts).

import type { Cache } from './types.ts';
import { classifyFailure, RETIREMENT_REASONS } from './error-signatures.ts';
import { PROVIDER_MAP } from './providers.ts';

export const BLOCKLIST_TTL_MS = 7 * 24 * 60 * 60_000;
const TIER2_MIN_FAILURES = 5;
const TIER2_MIN_SPAN_MS = 60 * 60_000;

interface BlocklistEntry {
  reason: string;
  code: number;
  signature: string;
  first_seen: number;
  last_seen: number;
  occurrences: number;
}

function block(
  cache: Cache,
  ref: string,
  reason: string,
  code: number,
  signature: string,
  now: number
): BlocklistEntry {
  cache.model_blocklist ??= {};
  const prev = cache.model_blocklist[ref];
  const entry: BlocklistEntry = {
    reason,
    code,
    signature,
    first_seen: prev?.first_seen ?? now,
    last_seen: now,
    occurrences: (prev?.occurrences ?? 0) + 1,
  };
  cache.model_blocklist[ref] = entry;
  if (cache.model_failure_streaks) delete cache.model_failure_streaks[ref];
  return entry;
}

/**
 * Records a failure for `ref`. Returns the (new or refreshed) block entry when
 * the failure blocks the model (Tier 1, Tier-2 promotion, or an expired block
 * re-confirmed with the same signature), otherwise null.
 */
export function recordBlocklistFailure(
  cache: Cache,
  ref: string,
  failureText: string,
  now: number = Date.now()
): BlocklistEntry | null {
  const c = classifyFailure(ref, failureText);
  if (c.verdict === 'permanent' && c.reason && c.code !== undefined) {
    return block(cache, ref, c.reason, c.code, c.signature, now);
  }
  if (c.verdict !== 'unknown' || PROVIDER_MAP[ref.split('/')[0]]?.local) return null;

  const prev = cache.model_blocklist?.[ref];
  if (prev?.signature === c.signature) {
    return block(cache, ref, prev.reason, prev.code, c.signature, now);
  }

  cache.model_failure_streaks ??= {};
  let streak = cache.model_failure_streaks[ref];
  if (streak?.signature !== c.signature || now - streak.last_seen >= BLOCKLIST_TTL_MS) {
    streak = { signature: c.signature, count: 0, first_seen: now, last_seen: now };
  }
  streak.count++;
  streak.last_seen = now;
  cache.model_failure_streaks[ref] = streak;

  if (streak.count >= TIER2_MIN_FAILURES && now - streak.first_seen >= TIER2_MIN_SPAN_MS) {
    return block(cache, ref, 'unknown-signature', c.code ?? 0, c.signature, now);
  }
  return null;
}

/**
 * Uniform log line for a block event. Every feed path (stream failures via
 * observeFailure, classifier-probe failures) logs through this helper so
 * log forensics can grep "blocked for" uniformly, regardless of which
 * path observed the failure.
 */
/**
 * True when a block must never expire: the model ref is gone upstream
 * (`decommissioned`, `free-variant-retired`).
 *
 * Derived from the stored `reason`, so entries written before this rule
 * existed (upgrade 2026-11-16) are covered without a cache migration, and no
 * model is named (ADR-0025). Every other reason — `workspace-guardrail`,
 * `agentic-harness-gate`, `unknown-signature` — describes a condition that
 * can change, so it keeps the 7-day TTL and the model can heal.
 */
export function isPermanentEntry(entry: { reason: string }): boolean {
  return RETIREMENT_REASONS.has(entry.reason);
}

export function formatBlockLogLine(ref: string, entry: BlocklistEntry): string {
  const duration = isPermanentEntry(entry)
    ? 'permanently'
    : `for ${Math.round(BLOCKLIST_TTL_MS / 86_400_000)} days`;
  return `[router] ${ref} blocked ${duration}: ${entry.reason} (${entry.code ? `HTTP ${entry.code}` : 'no HTTP code'}, signature ${entry.signature}, seen ${entry.occurrences}×)`;
}

export function isBlocked(
  cache: Cache | undefined,
  ref: string,
  now: number = Date.now()
): boolean {
  const entry = cache?.model_blocklist?.[ref];
  if (entry === undefined) return false;
  return isPermanentEntry(entry) || now - entry.last_seen < BLOCKLIST_TTL_MS;
}

/**
 * True when `ref` carries a Tier-1 (permanent) block. Callers that persist a
 * candidate list use this instead of isBlocked(): a temporary block must not
 * be frozen into a snapshot that outlives it, a permanent one must.
 */
export function isPermanentlyBlocked(cache: Cache | undefined, ref: string): boolean {
  const entry = cache?.model_blocklist?.[ref];
  return entry !== undefined && isPermanentEntry(entry);
}

/**
 * Records a successful response: clears the model's block (if any) and its
 * Tier-2 failure streak. Returns true if a block existed.
 */
export function recordBlocklistSuccess(cache: Cache, ref: string): boolean {
  if (cache.model_failure_streaks?.[ref]) delete cache.model_failure_streaks[ref];
  if (!cache.model_blocklist?.[ref]) return false;
  delete cache.model_blocklist[ref];
  return true;
}

/**
 * Manual unblock (`/router blocklist clear [ref]`): removes the block and
 * Tier-2 streak for `ref`, or for every model when `ref` is omitted.
 * Returns the number of blocks removed.
 */
export function clearBlocklist(cache: Cache, ref?: string): number {
  if (ref) {
    const had = cache.model_blocklist?.[ref] ? 1 : 0;
    if (cache.model_blocklist) delete cache.model_blocklist[ref];
    if (cache.model_failure_streaks) delete cache.model_failure_streaks[ref];
    return had;
  }
  const count = Object.keys(cache.model_blocklist ?? {}).length;
  cache.model_blocklist = {};
  cache.model_failure_streaks = {};
  return count;
}

export function activeBlocks(
  cache: Cache,
  now: number = Date.now()
): Array<{ ref: string; entry: BlocklistEntry; reprobeInMs: number | null }> {
  return Object.entries(cache.model_blocklist ?? {})
    .filter(([, e]) => isPermanentEntry(e) || now - e.last_seen < BLOCKLIST_TTL_MS)
    .map(([ref, entry]) => ({
      ref,
      entry,
      // null = permanent, there is no re-probe to count down to.
      reprobeInMs: isPermanentEntry(entry) ? null : BLOCKLIST_TTL_MS - (now - entry.last_seen),
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}
