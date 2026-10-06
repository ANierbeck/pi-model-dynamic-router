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
