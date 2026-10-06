// src/provider-breaker.ts
// Provider circuit breaker (docs/plans/2026-10-06-provider-circuit-breaker.md),
// generalizing the local watchdog of ADR-0016 to local AND cloud providers.
//
// Every other failure mechanism in the router is per model. When a provider
// wedges as a whole, several DIFFERENT models of it fail the same way in a
// short window with no success in between; a per-model structural error
// (400/404/422) never looks like that. This module decides what counts as
// provider-level evidence (D1), when the breaker opens (D2/D5) and for how
// long. Provider-agnostic (ADR-0025 class A): locality comes from
// PROVIDER_MAP, no provider or model names appear in the logic.

import { isRateLimitText, isOverflowErrorText, isAbortLikeText } from './detection.ts';
import { classifyFailure } from './error-signatures.ts';
import { PROVIDER_MAP } from './providers.ts';
import type { Cache } from './types.ts';

/** Failure shapes the orchestrator can report to the breaker. */
export type ProviderEvidenceKind = 'empty_response' | 'empty_timeout' | 'stall_timeout' | 'provider_error';

// Connection/5xx-shaped wording of a provider_error detail (D1). Deliberately
// positive lists: an unrecognised provider error never counts. Transport
// errors carry no HTTP status; gateway wording is the text form of a 5xx.
const TRANSPORT_ERROR = /econnrefused|econnreset|epipe|etimedout|fetch failed|connection error/i;
const GATEWAY_ERROR = /bad gateway|service unavailable|gateway timeout|upstream[^.]*unavailable/i;

/**
 * True when a failure of `kind` is evidence that the PROVIDER (not one model)
 * is wedged. Empty responses and both timeout kinds always count;
 * provider_error counts only for connection/5xx-shaped text. Rate limits,
 * aborts, overflows and per-model request/shape or auth errors never count —
 * the verdict logic is the ADR-0008 one in error-signatures.ts.
 */
export function countsAsProviderEvidence(kind: ProviderEvidenceKind, detail?: string): boolean {
  if (kind !== 'provider_error') return true;
  if (!detail?.trim()) return false;
  if (isRateLimitText(detail) || isAbortLikeText(detail) || isOverflowErrorText(detail)) return false;
  // No ref: provider-scoped signatures do not apply, only the generic verdicts.
  const { verdict, code } = classifyFailure('', detail);
  if (verdict === 'request' || verdict === 'permanent') return false;
  // A transport error carries no status (and a port like :443 must not read
  // as a 4xx); everything else needs a 5xx. A parsed 4xx wins over incidental
  // 5xx-shaped wording; 401/402 are out of scope (per-model backoff only).
  if (TRANSPORT_ERROR.test(detail)) return true;
  if (code !== undefined && code < 500) return false;
  return (code !== undefined && code >= 500) || GATEWAY_ERROR.test(detail);
}

/** Evidence older than this no longer counts toward a trip (D2). */
export const WEDGE_WINDOW_MS = 10 * 60_000;

/**
 * Open time per trip without an intervening close (D5), capped at the last
 * step; a success resets the ladder. Local providers use it too — this
 * replaces ADR-0016's flat 5 min (owner decision 2026-10-06, plan Q2).
 */
export const BREAKER_COOLDOWN_LADDER_MS: readonly number[] = [2 * 60_000, 5 * 60_000, 15 * 60_000];

// Distinct models with evidence needed to trip: local keeps ADR-0016's 2, the
// cloud evidence shows cascades of 4-6 models, so 3 is safe against one flaky one.
const MIN_MODELS_LOCAL = 2;
const MIN_MODELS_CLOUD = 3;

type ProviderBreaker = NonNullable<Cache['provider_breaker']>[string];

function providerOf(ref: string): string {
  return ref.split('/')[0];
}

function minModels(provider: string): number {
  return PROVIDER_MAP[provider]?.local === true ? MIN_MODELS_LOCAL : MIN_MODELS_CLOUD;
}

function liveEvidence(s: ProviderBreaker, now: number): string[] {
  return Object.entries(s.evidence)
    .filter(([, at]) => now - at < WEDGE_WINDOW_MS)
    .map(([ref]) => ref);
}

/**
 * Records a failure of `ref`. Returns true only when this failure newly OPENS
 * the breaker (so the caller narrates once). Failures that are not provider
 * evidence are ignored. A failure while the breaker has tripped before and no
 * success has cleared it (the half-open re-probe failed) re-opens at the next
 * ladder step; otherwise the breaker opens once `minModels` distinct models
 * have evidence inside the window.
 */
export function recordProviderFailure(
  cache: Cache,
  ref: string,
  kind: ProviderEvidenceKind,
  detail?: string,
  now: number = Date.now()
): boolean {
  if (!countsAsProviderEvidence(kind, detail)) return false;
  const provider = providerOf(ref);
  if (!cache.provider_breaker) cache.provider_breaker = {};
  const s = (cache.provider_breaker[provider] ??= { evidence: {}, trip_count: 0 });
  for (const [model, at] of Object.entries(s.evidence)) {
    if (now - at >= WEDGE_WINDOW_MS) delete s.evidence[model];
  }
  s.evidence[ref] = now;
  if (isProviderOpen(cache, provider, now)) return false;
  if (s.trip_count === 0 && Object.keys(s.evidence).length < minModels(provider)) return false;
  s.trip_count++;
  const step = Math.min(s.trip_count, BREAKER_COOLDOWN_LADDER_MS.length) - 1;
  s.open_until = now + BREAKER_COOLDOWN_LADDER_MS[step];
  return true;
}

/** Any success of the provider proves it answers: closes, clears evidence, resets the ladder (D5). */
export function recordProviderSuccess(cache: Cache, ref: string): void {
  delete cache.provider_breaker?.[providerOf(ref)];
}

export function isProviderOpen(cache: Cache | undefined, provider: string, now: number = Date.now()): boolean {
  const until = cache?.provider_breaker?.[provider]?.open_until;
  return until !== undefined && now < until;
}

/** Read-only view for status displays: open flag, expiry while open, ladder position, live evidence refs. */
export function breakerState(
  cache: Cache | undefined,
  provider: string,
  now: number = Date.now()
): { open: boolean; until?: number; tripCount: number; evidence: string[] } {
  const s = cache?.provider_breaker?.[provider];
  if (!s) return { open: false, tripCount: 0, evidence: [] };
  const open = isProviderOpen(cache, provider, now);
  return {
    open,
    ...(open ? { until: s.open_until } : {}),
    tripCount: s.trip_count,
    evidence: liveEvidence(s, now),
  };
}

/** Providers whose breaker is open right now, with the expiry, for status displays. */
export function openBreakers(cache: Cache | undefined, now: number = Date.now()): { provider: string; until: number }[] {
  return Object.entries(cache?.provider_breaker ?? {})
    .filter(([provider]) => isProviderOpen(cache, provider, now))
    .map(([provider, s]) => ({ provider, until: s.open_until! }));
}
