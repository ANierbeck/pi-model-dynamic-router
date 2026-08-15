// src/model-health.ts
// Per-model reliability tracking.
//
// WHY: ranking is purely quality-based (GDPval). A free model that returns an
// empty stream on every single request still outranks a slower-but-working
// paid model, because its GDPval score never changes. Once its short soft
// backoff expires it goes straight back to position 1 and the whole turn fails
// again. Users see "All N candidates failed" over and over.
//
// This module records consecutive failures per model ref and lets the router
// demote persistently broken models *within* a group — they are never removed,
// so a model always gets another chance once its failures decay.
//
// STATE LIVES IN THE CACHE OBJECT, NOT IN MODULE VARIABLES. esbuild bundles
// some modules twice (index.ts and routing.ts resolve them via different
// paths), so module-level state would silently diverge between the two
// instances. The cache is a single shared object reference, so keying off it
// is safe from that whole class of bug.

import type { Cache } from './types.ts';

export interface HealthRecord {
  /** Consecutive failures since the last success. */
  fails: number;
  /** Timestamp (ms) of the most recent failure. */
  last_fail: number;
}

/** Failures older than this stop counting — every model gets a fresh chance. */
export const HEALTH_DECAY_MS = 15 * 60_000; // 15 minutes

/** At or above this many consecutive failures a model is considered unhealthy. */
export const UNHEALTHY_AT = 2;

function store(cache: Cache): Record<string, HealthRecord> {
  const c = cache as Cache & { model_health?: Record<string, HealthRecord> };
  if (!c.model_health) c.model_health = {};
  return c.model_health;
}

/**
 * Records a failed request (empty response, timeout, rate limit) for a ref.
 */
export function recordModelFailure(cache: Cache, ref: string): void {
  const h = store(cache);
  const prev = h[ref];
  const fails = isStale(prev) ? 1 : (prev?.fails ?? 0) + 1;
  h[ref] = { fails, last_fail: Date.now() };
}

/**
 * Records a successful request — clears the failure streak entirely.
 */
export function recordModelSuccess(cache: Cache, ref: string): void {
  const h = store(cache);
  delete h[ref];
}

function isStale(rec: HealthRecord | undefined): boolean {
  if (!rec) return true;
  return Date.now() - rec.last_fail > HEALTH_DECAY_MS;
}

/**
 * Current consecutive-failure count for a ref, 0 if healthy or decayed.
 */
export function failureStreak(cache: Cache, ref: string): number {
  const rec = store(cache)[ref];
  return isStale(rec) ? 0 : rec!.fails;
}

/**
 * True if the model has failed often enough recently that it should not be
 * tried before healthier alternatives.
 */
export function isUnhealthy(cache: Cache, ref: string): boolean {
  return failureStreak(cache, ref) >= UNHEALTHY_AT;
}

/**
 * Stable-sorts a ranked candidate list so healthy models come first, then
 * unhealthy ones ordered by fewest recent failures.
 *
 * The existing quality ordering is preserved inside each bucket — this only
 * moves persistently broken models out of the way, it never reorders working
 * ones and never drops a candidate.
 */
export function demoteUnhealthy(cache: Cache, refs: string[]): string[] {
  const healthy: string[] = [];
  const unhealthy: string[] = [];
  for (const ref of refs) {
    if (isUnhealthy(cache, ref)) unhealthy.push(ref);
    else healthy.push(ref);
  }
  if (!unhealthy.length) return refs;
  // Fewest failures first among the demoted ones; ties keep quality order.
  unhealthy.sort((a, b) => failureStreak(cache, a) - failureStreak(cache, b));
  return [...healthy, ...unhealthy];
}
