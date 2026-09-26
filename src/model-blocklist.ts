// src/model-blocklist.ts
// Learned model blocklist, Tier 1 (ADR-0008).
//
// A model whose failure matches a known-permanent signature (error-signatures.ts)
// is blocked on first sight and dropped from candidate lists at runtime. The
// block expires after BLOCKLIST_TTL_MS so the model is re-probed; a repeated
// permanent failure re-blocks it, a success clears it.
//
// State lives in the cache object, not in module variables: esbuild bundles
// some modules twice, and module-level state would diverge (same rationale as
// model-health.ts).

import type { Cache } from './types.ts';
import { classifyFailure } from './error-signatures.ts';

export const BLOCKLIST_TTL_MS = 7 * 24 * 60 * 60_000;

export interface BlocklistEntry {
  reason: string;
  code: number;
  signature: string;
  first_seen: number;
  last_seen: number;
  occurrences: number;
}

/**
 * Records a failure for `ref`. Returns the (new or refreshed) entry when the
 * failure is a known-permanent signature, otherwise null and nothing changes.
 */
export function recordBlocklistFailure(
  cache: Cache,
  ref: string,
  failureText: string,
  now: number = Date.now()
): BlocklistEntry | null {
  const c = classifyFailure(ref, failureText);
  if (c.verdict !== 'permanent' || !c.reason || c.code === undefined) return null;
  if (!cache.model_blocklist) cache.model_blocklist = {};
  const prev = cache.model_blocklist[ref];
  const entry: BlocklistEntry = {
    reason: c.reason,
    code: c.code,
    signature: c.signature,
    first_seen: prev?.first_seen ?? now,
    last_seen: now,
    occurrences: (prev?.occurrences ?? 0) + 1,
  };
  cache.model_blocklist[ref] = entry;
  return entry;
}

export function isBlocked(cache: Cache | undefined, ref: string, now: number = Date.now()): boolean {
  const entry = cache?.model_blocklist?.[ref];
  return entry !== undefined && now - entry.last_seen < BLOCKLIST_TTL_MS;
}

/** Clears a block after a successful response. Returns true if one existed. */
export function clearBlock(cache: Cache, ref: string): boolean {
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
