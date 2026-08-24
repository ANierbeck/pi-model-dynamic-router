// src/detection.ts
// Single source of truth for provider-error text detection.
//
// PREVIOUSLY there were TWO rate-limit scanners with DIVERGENT pattern sets:
//   - isRateLimitText  (index.ts consumeWithDetection, 15 patterns)
//   - isRateLimitError (index.ts driveStream cascade, 7 patterns)
// They disagreed: isRateLimitError missed 'five_hour'/'claude code returned
// an error'; isRateLimitText missed 'rate_limit_exceeded'. A rate-limit could
// trigger a fallback in one code path but not the other. Both now go through
// the unified RATE_LIMIT_PATTERNS table here.
//
// Overflow detection (error-event vs text_delta) also lived inline in
// index.ts; moved here so the pattern tables are co-located and testable.

/**
 * Patterns that indicate a rate-limit / spend-limit / subscription error.
 * These can arrive as error events OR as text_delta content (claude-bridge
 * pushes rate-limit warnings as text via piUI.notify, and some error results
 * with non-success subtype fall through without an error event).
 *
 * Union of the two previous pattern sets — no divergence between code paths.
 */
export const RATE_LIMIT_PATTERNS: readonly string[] = [
  'rate limit',
  'spend limit',
  'usage credits',
  'out of',
  'limit hit',
  'claude code returned an error',
  'monthly spend',
  'five_hour',
  'five hour',
  'quota',
  'credits',
  'exceeded',
  'overloaded',
  'rate_limit',
  'rate_limit_exceeded',
];

/**
 * Patterns that indicate the prompt exceeded the model's context window.
 * Mirrors @earendil-works/pi-ai/utils/overflow OVERFLOW_PATTERNS.
 *
 * Safe for `error` EVENTS ONLY: an error event comes from provider/transport
 * infrastructure, never from the model's own generated prose, so a generic
 * phrase like "context window" can't false-positive there.
 */
export const ERROR_OVERFLOW_PATTERNS: readonly string[] = [
  'prompt is too long',
  'maximum context length',
  'context length is',
  'too large for model with',
  'maximum context',
  'context window',
  'token count exceeds',
  'exceeds the context',
];

/**
 * Narrower patterns for TEXT_DELTA content. This router's own domain is
 * context windows/compaction, so a legitimate assistant response can
 * plausibly contain broad phrases like "context window" while discussing
 * the router itself (roborev job 203 High finding). Only match phrasings a
 * provider actually uses to reject an oversized prompt, which ordinary
 * assistant prose won't reproduce.
 */
export const TEXT_DELTA_OVERFLOW_PATTERNS: readonly string[] = [
  'too large for model with',
  'prompt is too long',
  'exceeds the maximum context length',
  'exceeds the context window',
];

/** True if text matches any rate-limit / spend-limit pattern. */
export function isRateLimitText(text: string): boolean {
  const lower = text.toLowerCase();
  return RATE_LIMIT_PATTERNS.some((p) => lower.includes(p));
}

/** True if text matches an overflow pattern suitable for error EVENTS (broad). */
export function isOverflowErrorText(text: string): boolean {
  const lower = text.toLowerCase();
  return ERROR_OVERFLOW_PATTERNS.some((p) => lower.includes(p));
}

/** True if text matches an overflow pattern suitable for text_delta (narrow). */
export function isOverflowDeltaText(text: string): boolean {
  const lower = text.toLowerCase();
  return TEXT_DELTA_OVERFLOW_PATTERNS.some((p) => lower.includes(p));
}
