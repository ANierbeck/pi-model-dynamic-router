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
// Blocked models are dropped from candidate lists at runtime. A block expires
// BLOCKLIST_TTL_MS after its last observation so the model is re-probed; a
// repeated failure with the same signature re-blocks it, a success clears it.
//
// State lives in the cache object, not in module variables: esbuild bundles
// some modules twice, and module-level state would diverge (same rationale as
// model-health.ts).

import type { Cache } from './types.ts';
import { classifyFailure } from './error-signatures.ts';
import { PROVIDER_MAP } from './providers.ts';

export const BLOCKLIST_TTL_MS = 7 * 24 * 60 * 60_000;
export const TIER2_MIN_FAILURES = 5;
export const TIER2_MIN_SPAN_MS = 60 * 60_000;

export interface BlocklistEntry {
  reason: string;
  code: number;
  signature: string;
  first_seen: number;
  last_seen: number;
  occurrences: number;
}

function block(cache: Cache, ref: string, reason: string, code: number, signature: string, now: number): BlocklistEntry {
  if (!cache.model_blocklist) cache.model_blocklist = {};
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
  if (prev && prev.signature === c.signature) {
    return block(cache, ref, prev.reason, prev.code, c.signature, now);
  }

  if (!cache.model_failure_streaks) cache.model_failure_streaks = {};
  let streak = cache.model_failure_streaks[ref];
  if (!streak || streak.signature !== c.signature || now - streak.last_seen >= BLOCKLIST_TTL_MS) {
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

export function isBlocked(cache: Cache | undefined, ref: string, now: number = Date.now()): boolean {
  const entry = cache?.model_blocklist?.[ref];
  return entry !== undefined && now - entry.last_seen < BLOCKLIST_TTL_MS;
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

export function activeBlocks(
  cache: Cache,
  now: number = Date.now()
): Array<{ ref: string; entry: BlocklistEntry; reprobeInMs: number }> {
  return Object.entries(cache.model_blocklist ?? {})
    .filter(([, e]) => now - e.last_seen < BLOCKLIST_TTL_MS)
    .map(([ref, entry]) => ({ ref, entry, reprobeInMs: BLOCKLIST_TTL_MS - (now - entry.last_seen) }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}
