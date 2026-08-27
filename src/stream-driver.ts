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
import { isRateLimitText } from './detection.ts';

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
 * Pushes a router-status line ("> [router] Trying next model...") as a
 * complete text_start/text_delta/text_end triplet, each carrying a `partial`
 * AssistantMessage with `role: 'assistant'`. Pi's compaction path reads
 * `partial.role` off in-flight events; a text_delta without a `partial`
 * (or with a shape that omits `role`) crashes compaction with "Cannot read
 * properties of undefined (reading 'role')". Emitting all three event types
 * (not just text_delta) matches what a real streamed text block looks like.
 */
export function pushRouterInfo(proxy: AssistantMessageEventStream, text: string, contentIndex: number = 0): void {
  const partial: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'end_turn',
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
  proxy.push({ type: 'text_start', contentIndex, partial } as any);
  proxy.push({ type: 'text_delta', contentIndex, delta: text, partial } as any);
  proxy.push({ type: 'text_end', contentIndex, content: text, partial } as any);
}

/**
 * Whether a tryStream() rejection is a known/expected transient condition
 * (missing provider registration, rate limit, credits/spend exhaustion) —
 * used to suppress noisy logging for errors the router already handles via
 * its normal fallback path, while still recording the real reason.
 */
export function isExpectedTransientError(errorMsg: string): boolean {
  return errorMsg.toLowerCase().includes('no api provider registered') || isRateLimitText(errorMsg);
}
