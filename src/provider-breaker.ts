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
import type { BreakerConfig, Cache } from './types.ts';

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

/** Fully resolved breaker tuning (plan D8): code defaults with user overrides applied. */
export interface BreakerTuning {
  /** Kill switch for CLOUD providers (plan D8). Local (ADR-0016) always stays active. */
  cloudEnabled: boolean;
  minModelsCloud: number;
  minModelsLocal: number;
  windowMs: number;
  cooldownMs: readonly number[];
}

/** Code defaults (plan D8): the shipped config carries no provider_breaker entry. */
export const DEFAULT_BREAKER_TUNING: BreakerTuning = {
  cloudEnabled: true,
  minModelsCloud: MIN_MODELS_CLOUD,
  minModelsLocal: MIN_MODELS_LOCAL,
  windowMs: WEDGE_WINDOW_MS,
  cooldownMs: BREAKER_COOLDOWN_LADDER_MS,
};

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Resolves the optional `provider_breaker` config fragment over the code defaults. */
export function resolveBreakerTuning(o?: BreakerConfig): BreakerTuning {
  if (!o) return DEFAULT_BREAKER_TUNING;
  const cooldown = Array.isArray(o.cooldown_s) && o.cooldown_s.length > 0
    ? o.cooldown_s.filter((s) => Number.isFinite(s) && s > 0).map((s) => s * 1000)
    : undefined;
  return {
    cloudEnabled: o.enabled !== false,
    minModelsCloud: positiveInt(o.min_models?.cloud, MIN_MODELS_CLOUD),
    minModelsLocal: positiveInt(o.min_models?.local, MIN_MODELS_LOCAL),
    windowMs: positiveInt(o.window_s, WEDGE_WINDOW_MS / 1000) * 1000,
    cooldownMs: cooldown && cooldown.length > 0 ? cooldown : BREAKER_COOLDOWN_LADDER_MS,
  };
}

/** A ref's provider is local (no key, daemon on the machine) — ADR-0016 territory. */
export function isLocalProviderName(provider: string): boolean {
  return PROVIDER_MAP[provider]?.local === true;
}

type ProviderBreaker = NonNullable<Cache['provider_breaker']>[string];
type ProviderBreakerStats = NonNullable<Cache['provider_breaker_stats']>[string];

function providerOf(ref: string): string {
  return ref.split('/')[0];
}

function minModels(provider: string, tuning: BreakerTuning): number {
  return isLocalProviderName(provider) ? tuning.minModelsLocal : tuning.minModelsCloud;
}

function liveEvidence(s: ProviderBreaker, now: number): { ref: string; at: number; kind: ProviderEvidenceKind }[] {
  return Object.entries(s.evidence)
    .filter(([, e]) => now - e.at < WEDGE_WINDOW_MS)
    .map(([ref, e]) => ({ ref, at: e.at, kind: e.kind as ProviderEvidenceKind }));
}

/**
 * Human-readable summary of a provider's live evidence for the narration
 * (plan D6: provider, evidence — e.g. "4 models returned empty responses
 * within 40 s" — cooldown, fix hint). Kinds collapse to one phrase when the
 * evidence is uniform, otherwise the generic "failed".
 */
export function breakerEvidenceSummary(
  cache: Cache | undefined,
  provider: string,
  now: number = Date.now()
): { count: number; spanMs: number; kinds: ProviderEvidenceKind[] } | undefined {
  const s = cache?.provider_breaker?.[provider];
  if (!s) return undefined;
  const live = liveEvidence(s, now);
  if (live.length === 0) return undefined;
  const kinds = [...new Set(live.map((e) => e.kind))];
  const spanMs = now - Math.min(...live.map((e) => e.at));
  return { count: live.length, spanMs, kinds };
}

/**
 * Persists a skipped candidate of an open breaker as an avoided hop (plan
 * D6/D7): the hop the breaker saved the user — the tuning evidence that
 * outlives the volatile open state.
 */
export function recordBreakerSkip(cache: Cache, provider: string): void {
  const stats = (cache.provider_breaker_stats ??= {});
  const s = (stats[provider] ??= { trips: 0, avoided_hops: 0 });
  s.avoided_hops++;
}

function recordTripStats(cache: Cache, provider: string, now: number): void {
  const stats = (cache.provider_breaker_stats ??= {});
  const s = (stats[provider] ??= { trips: 0, avoided_hops: 0 });
  s.trips++;
  s.last_trip_at = now;
}

/** Closes every open breaker (the `/router cooldowns clear` relief path, plan D6). Kept stats survive. */
export function clearBreakers(cache: Cache): number {
  const open = openBreakers(cache).length;
  if (cache.provider_breaker) delete cache.provider_breaker;
  return open;
}

/**
 * Records a failure of `ref`. Returns true only when this failure newly OPENS
 * the breaker (so the caller narrates once). Failures that are not provider
 * evidence are ignored. A failure while the breaker has tripped before and no
 * success has cleared it (the half-open re-probe failed) re-opens at the next
 * ladder step, provided it comes within WEDGE_WINDOW_MS of the last expiry;
 * otherwise the breaker opens once `minModels` distinct models
 * have evidence inside the window.
 */
export function recordProviderFailure(
  cache: Cache,
  ref: string,
  kind: ProviderEvidenceKind,
  detail?: string,
  now: number = Date.now(),
  tuning: BreakerTuning = DEFAULT_BREAKER_TUNING
): boolean {
  if (!countsAsProviderEvidence(kind, detail)) return false;
  const provider = providerOf(ref);
  if (!cache.provider_breaker) cache.provider_breaker = {};
  const s = (cache.provider_breaker[provider] ??= { evidence: {}, trip_count: 0 });
  for (const [model, e] of Object.entries(s.evidence)) {
    if (now - e.at >= tuning.windowMs) delete s.evidence[model];
  }
  s.evidence[ref] = { at: now, kind };
  if (isProviderOpen(cache, provider, now)) return false;
  // The half-open re-probe only counts shortly after the cooldown ended: once
  // a whole window has passed, the old trip no longer vouches for a single
  // failure ("one slow model alone never triggers it", ADR-0016).
  if (now - (s.open_until ?? 0) >= tuning.windowMs) s.trip_count = 0;
  if (s.trip_count === 0 && Object.keys(s.evidence).length < minModels(provider, tuning)) return false;
  s.trip_count++;
  const step = Math.min(s.trip_count, tuning.cooldownMs.length) - 1;
  s.open_until = now + tuning.cooldownMs[step];
  recordTripStats(cache, provider, now);
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
    evidence: liveEvidence(s, now).map((e) => e.ref),
  };
}

/** Providers whose breaker is open right now, with the expiry, for status displays. */
export function openBreakers(cache: Cache | undefined, now: number = Date.now()): { provider: string; until: number }[] {
  return Object.entries(cache?.provider_breaker ?? {})
    .filter(([provider]) => isProviderOpen(cache, provider, now))
    .map(([provider, s]) => ({ provider, until: s.open_until! }));
}
