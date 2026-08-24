// src/stream-driver.ts
// Shared error-message plumbing for driveStream()/groupStream() (index.ts).
//
// C1: extracted the zero-cost AssistantMessage error-envelope boilerplate
// that was duplicated 6x verbatim across driveStream/groupStream (context
// overflow x3, all-candidates-failed, dynamic-routing-failed, catch-all
// stream error) — same `usage`/`stopReason`/`timestamp` shape every time,
// only `content[0].text` and the optional `errorMessage` differ. Pure
// code motion, no semantic changes.

import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from '@earendil-works/pi-ai';

/**
 * Builds a synthetic assistant error message with zero usage/cost. `errorMessage`
 * (when provided) is what Pi's isContextOverflow() inspects to trigger compaction —
 * omit it entirely (not just leave undefined) unless the caller has one, since some
 * downstream consumers distinguish "field present" from "field undefined".
 */
export function buildErrorAssistantMessage(text: string, errorMessage?: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    timestamp: Date.now(),
  } as AssistantMessage;
}

/** Pushes a synthetic error event built via buildErrorAssistantMessage() onto the proxy stream. */
export function pushStreamError(
  proxy: AssistantMessageEventStream,
  text: string,
  errorMessage?: string
): void {
  proxy.push({
    type: 'error',
    reason: 'error',
    error: buildErrorAssistantMessage(text, errorMessage),
  } as AssistantMessageEvent);
}

/**
 * Whether a tryStream() rejection is a known/expected transient condition
 * (missing provider registration, rate limit, credits/spend exhaustion) —
 * used to suppress noisy logging for errors the router already handles via
 * its normal fallback path, while still recording the real reason.
 */
export function isExpectedTransientError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return (
    lower.includes('no api provider registered') ||
    lower.includes('rate limit') ||
    lower.includes('usage credits') ||
    lower.includes('spend limit') ||
    lower.includes('out of') ||
    lower.includes('limit hit')
  );
}
