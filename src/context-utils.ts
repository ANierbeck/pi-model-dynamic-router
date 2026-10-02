/**
 * Context/prompt inspection helpers and per-model timeout lookups, extracted
 * from index.ts (refactor plan 2026-10-02, task 1). Pure code motion: the
 * function bodies are unchanged; closure state is reached through `d`.
 */

import { stripRouterNarration, splitRef } from './utils.ts';
import type { Context } from '@earendil-works/pi-ai';
import type { Config } from './types.ts';

/**
 * Dependencies createContextUtils reads from index.ts's extension closure. Exposed as
 * live accessors (getters, plus setters for state the moved code writes), so
 * every read sees the CURRENT closure value — index.ts reassigns cfg/router/
 * managers on reload, and a captured copy would go stale.
 */
interface ContextUtilsDeps {
  readonly cfg: Config;
  readonly EMPTY_RESPONSE_TIMEOUT_MS: number;
  previousMessageCount: number;
  previousTokenCount: number;
  readonly RATE_LIMIT_WAIT_MAX_MS: number;
  readonly REASONING_EMPTY_RESPONSE_TIMEOUT_MS: number;
  readonly sessionCtx: any;
  readonly STALL_TIMEOUT_MS: number;
}

export function createContextUtils(d: ContextUtilsDeps) {
  function extractLastUserPrompt(context: Context): string {
    // Stripped of router narration (see stripRouterNarration in src/utils.ts):
    // this text becomes the classifier's "current request", and a subagent
    // task that replays prior turns verbatim can carry an old
    // "> [router] HINT: ..." line anywhere in its body, not just at the
    // start — the classifier's "contains a HINT instruction" rule would
    // otherwise misread it as a fresh instruction (2026-09-18 lock-in loop,
    // reproduced live even after the narration-leak fix in 26e99f0 because
    // that fix only covered extractLastAssistantSnippet(), not this path).
    try {
      const userMsgs = context.messages.filter((m) => m.role === 'user');
      const last = userMsgs[userMsgs.length - 1];
      if (!last) return '';
      const c = last.content;
      if (typeof c === 'string') return stripRouterNarration(c);
      if (Array.isArray(c))
        return stripRouterNarration(
          c
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('')
        );
    } catch {
      /* context shape unknown */
    }
    return '';
  }

  function estimateContextTokens(context: Context): number {
    let total = 0;
    for (const msg of context.messages) {
      // Content may be a string OR an array of content blocks (text, tool_use,
      // tool_result, image, etc.). For arrays, sum the text representation of
      // every block — a tool_result block can easily carry tens of thousands of
      // tokens (a full file read, a command's stdout). Treating arrays as ''
      // silently produced a 0-token estimate for every tool message, which made
      // the context-window guard in driveStream think a 300K-token conversation
      // (after a 1M-context model) was small enough for a 256K model. The
      // provider then hung for minutes trying to ingest an oversized prompt.
      const c = msg.content;
      let text: string;
      if (typeof c === 'string') {
        text = c;
      } else if (Array.isArray(c)) {
        text = c.map((b: any) =>
          typeof b === 'string'
            ? b
            : b?.text ?? b?.content ?? (b != null ? JSON.stringify(b) : '')
        ).join('');
      } else {
        text = c != null ? String(c) : '';
      }
      total += Math.ceil(text.length / 4); // Rough estimate: 4 chars ≈ 1 token
    }
    return total;
  }

  /**
   * Returns the context window (in tokens) for a model ref, or null if unknown.
   * Uses the model registry's contextWindow property (default 128K in Pi).
   * Small local models (e.g. gemma4:12b @ 8K) will return their actual limit.
   */
  function getModelContextWindow(ref: string): number | null {
    if (!d.sessionCtx) return null;
    const { provider, modelId } = splitRef(ref);
    try {
      const model = d.sessionCtx.modelRegistry.find(provider, modelId);
      if (!model) return null;
      const cw = (model as any).contextWindow;
      return typeof cw === 'number' && cw > 0 ? cw : null;
    } catch {
      return null;
    }
  }

  /**
   * Updates the model registry with a discovered context window (e.g. learned
   * at runtime from an overflow error). This makes the value sticky for the
   * current session so the pre-flight guard in driveStream skips this model
   * for the current (or similar) context size without needing another error.
   * Mutates the registry entry in-place; no-op if the model is not found.
   */
  function updateModelContextWindow(ref: string, cw: number): void {
    if (!d.sessionCtx || !cw) return;
    const { provider, modelId } = splitRef(ref);
    try {
      const model = d.sessionCtx.modelRegistry.find(provider, modelId) as any;
      if (model) model.contextWindow = cw;
    } catch {
      /* registry error — no-op */
    }
  }

  /**
   * Whether the model at `ref` advertises a reasoning/thinking capability.
   * Reasoning models think internally before emitting the first output token,
   * so they need a longer first-token timeout than instant chat models —
   * otherwise an overloaded provider (e.g. Mistral serving glm-5-2) gets
   * aborted mid-thought, producing a false "empty response" and a soft-failure
   * cooldown. The router then re-picks the same model on the next turn (it's
   * still the best-ranked) and the timeout fires again — a silent infinite
   * loop that looks like "model never succeeds" even though the model was
   * just slow.
   */
  function isReasoningModel(ref: string): boolean {
    if (!d.sessionCtx) return false;
    const { provider, modelId } = splitRef(ref);
    try {
      const model = d.sessionCtx.modelRegistry.find(provider, modelId) as any;
      if (!model) return false;
      // pi-ai's Model type carries `reasoning?: boolean` when the model
      // supports thinking (not to be confused with SimpleStreamOptions.reasoning,
      // which is a `ThinkingLevel` string on the request side, not the model
      // capability flag read here). Some custom providers may expose it as a
      // `thinking` flag instead, so accept either.
      return Boolean(model.reasoning) || Boolean(model.thinking);
    } catch {
      return false;
    }
  }

  /** First-token timeout to use for a given model ref. */
  function getEmptyResponseTimeout(ref: string): number {
    const base = d.cfg.empty_response_timeout_ms ?? d.EMPTY_RESPONSE_TIMEOUT_MS;
    const reasoning = d.cfg.reasoning_empty_response_timeout_ms ?? d.REASONING_EMPTY_RESPONSE_TIMEOUT_MS;
    return isReasoningModel(ref) ? reasoning : base;
  }

  /**
   * Mid-stream inactivity timeout (after the first content token) for a given
   * model ref. Separate from the first-token timeout: a legitimately
   * slow-but-working provider under load can have silent gaps far longer than
   * the first-token wait, so reusing the first-token value would misclassify
   * healthy-but-slow streams as stalls. Reasoning models get the same value as
   * non-reasoning here — the gap is already generous (default 180s) and the
   * reasoning distinction only matters for the first token (which they spend
   * thinking before emitting).
   */
  function getStallTimeout(ref: string): number {
    return d.cfg.stall_timeout_ms ?? d.STALL_TIMEOUT_MS;
  }

  /** Max ms to wait for a rate-limited model with a known, near reset time
   * (see router-defaults.yaml). 0 disables the wait-and-retry path. */
  function getRateLimitWaitMaxMs(): number {
    return d.cfg.rate_limit_wait_max_ms ?? d.RATE_LIMIT_WAIT_MAX_MS;
  }

  function isCompactionTurn(context: Context): boolean {
    const currentMessageCount = context.messages.length;
    const currentTokenCount = estimateContextTokens(context);

    // Reset if no previous state (first turn)
    if (d.previousMessageCount === 0) {
      d.previousMessageCount = currentMessageCount;
      d.previousTokenCount = currentTokenCount;
      return false;
    }

    // Check for significant drop in either messages or tokens (>30% reduction)
    const messageDrop = currentMessageCount < d.previousMessageCount * 0.7;
    const tokenDrop = currentTokenCount < d.previousTokenCount * 0.7;

    // Also check absolute thresholds for small contexts
    const absoluteMessageDrop = d.previousMessageCount - currentMessageCount > 5;
    const absoluteTokenDrop = d.previousTokenCount - currentTokenCount > 500;

    // Update state
    d.previousMessageCount = currentMessageCount;
    d.previousTokenCount = currentTokenCount;

    return messageDrop || tokenDrop || absoluteMessageDrop || absoluteTokenDrop;
  }

  // pushRouterInfo/pushRouterInfoLogged (src/stream-driver.ts) prepend lines
  // like "> [router] HINT: mistral/foo · mistral/foo\n\n" to the assistant's
  // VISIBLE response before the model's real text. Those lines end up stored
  // in context.messages as part of the assistant turn, so on the next turn
  // extractLastAssistantSnippet() would otherwise hand the classifier its own
  // prior routing narration instead of the model's actual answer — and
  // because that narration can itself contain the literal substring
  // "HINT: <model>", the classifier's own HINT-detection instructions then
  // misread the router's diagnostic output as a fresh user-issued HINT,
  // routing back to whatever model was last narrated and creating a
  // self-reinforcing lock-in loop (observed 2026-09-18: session stuck on
  // openrouter/cohere/north-mini-code:free / ling-3.0-flash-vl:free).
  function extractLastAssistantSnippet(context: Context): string | undefined {
    // Extract the last assistant response (compact for fast classification)
    // Max 150 chars (matches the limit in classifyPrompt)
    try {
      const assistantMsgs = context.messages.filter((m) => m.role === 'assistant');
      const last = assistantMsgs[assistantMsgs.length - 1];
      if (!last) return undefined;
      const c = last.content as string | Array<{ type: string; text: string }> | unknown;
      if (typeof c === 'string') return stripRouterNarration(c).slice(0, 150);
      if (Array.isArray(c)) {
        const textContent = c
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text as string)
          .join('');
        return stripRouterNarration(textContent).slice(0, 150);
      }
    } catch {
      /* context shape unknown */
    }
    return undefined;
  }

  return { estimateContextTokens, getModelContextWindow, updateModelContextWindow, getEmptyResponseTimeout, getStallTimeout, getRateLimitWaitMaxMs, extractLastUserPrompt, extractLastAssistantSnippet, isCompactionTurn };
}
