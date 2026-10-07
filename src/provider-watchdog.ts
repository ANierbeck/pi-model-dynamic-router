// src/provider-watchdog.ts
// Local-provider watchdog (ADR-0016) — compatibility shim.
//
// The mechanism now lives in provider-breaker.ts (one provider circuit
// breaker for local AND cloud providers, docs/plans/2026-10-06-provider-circuit-breaker.md).
// This file keeps the names the orchestrator, classifier, index.ts and
// /router already import, with the local-only semantics they rely on: a local
// generation timeout is `empty_timeout` evidence, and "wedged" means an open
// breaker on a LOCAL provider (cloud refs are ignored here, exactly as before).

import type { Cache } from './types.ts';
import { PROVIDER_MAP } from './providers.ts';
import {
  BREAKER_COOLDOWN_LADDER_MS,
  WEDGE_WINDOW_MS,
  breakerState,
  recordProviderFailure,
  recordProviderSuccess,
  isProviderOpen,
  type BreakerTuning,
} from './provider-breaker.ts';

export { WEDGE_WINDOW_MS };

/**
 * First ladder step of the breaker. Replaces ADR-0016's flat 5 min: the
 * owner decided (2026-10-06, plan Q2) that local providers use the same
 * [2, 5, 15] min ladder as cloud ones — a daemon restart takes seconds, so
 * a short first skip costs little and a persistent wedge escalates anyway.
 * Later trips are longer than this value; it is the cooldown of the first one.
 */
export const WEDGE_COOLDOWN_MS = BREAKER_COOLDOWN_LADDER_MS[0];

/**
 * The cooldown the provider's current open runs for, for log lines and
 * narration ("2 min", "5 min", "15 min"): the ladder step of its latest trip.
 * Call it right after a failure was reported as newly opening the breaker,
 * which is true for every re-open too, not just the first.
 */
export function wedgeCooldownText(cache: Cache | undefined, provider: string, tuning?: BreakerTuning): string {
  const ladder = tuning?.cooldownMs ?? BREAKER_COOLDOWN_LADDER_MS;
  const step = Math.min(Math.max(breakerState(cache, provider).tripCount, 1), ladder.length) - 1;
  return `${Math.round(ladder[step] / 60_000)} min`;
}

/** How the user un-wedges a local provider; the router never restarts it itself. */
export function wedgeFixHint(provider: string): string {
  return provider === 'ollama'
    ? 'restart the daemon (e.g. `pkill ollama`; a launch agent or service restarts it)'
    : `restart ${provider}`;
}

function isLocal(provider: string): boolean {
  return PROVIDER_MAP[provider]?.local === true;
}

/**
 * Records a generation timeout for a local model. Returns true only when this
 * timeout newly opens the breaker, the first time or as a re-open after a
 * failed re-probe (so the caller narrates once per open).
 */
export function recordLocalTimeout(cache: Cache, ref: string, now: number = Date.now()): boolean {
  if (!isLocal(ref.split('/')[0])) return false;
  return recordProviderFailure(cache, ref, 'empty_timeout', undefined, now);
}

/** Any local success proves the daemon generates: clears evidence and wedge. */
export function recordLocalSuccess(cache: Cache, ref: string): void {
  if (!isLocal(ref.split('/')[0])) return;
  recordProviderSuccess(cache, ref);
}

export function isProviderWedged(cache: Cache | undefined, provider: string, now: number = Date.now()): boolean {
  return isLocal(provider) && isProviderOpen(cache, provider, now);
}
