// src/context-budget.ts
//
// Output-aware context planning. A provider checks the whole request against
// the model window — input text, tool schemas AND the requested output budget
// (`max_completion_tokens`). The router's older pre-flight compared only the
// message text against the window, so a long conversation with a large
// requested output (e.g. 165 880 tokens) was sent to a 262 144-token model with
// 177 678 tokens of input and was rejected: "343 558 tokens (164 591 of text
// input, 13 087 of tool input, 165 880 in the output)".
//
// The planner decides, per candidate:
//   - fits:    input + tools + requested output leave the safety margin intact;
//   - capped:  the requested output is lowered to what the window leaves, so the
//              model stays usable for long contexts (instead of being skipped);
//   - skip:    even the minimum useful output does not fit;
//   - unknown: the window is unknown — no decision (previous behaviour).

/** Smallest output budget worth sending; below this the candidate is skipped. */
export const MIN_OUTPUT_TOKENS = 4096;

/** Safety margin: absolute floor, or 5 % of the window (token estimates are rough). */
export function safetyTokens(windowTokens: number): number {
  return Math.max(2048, Math.ceil(windowTokens * 0.05));
}

/**
 * Fixed per-image window cost. Providers account for images by resolution,
 * not encoded bytes (a 400k-char base64 payload is ~1-2k window tokens, not
 * 100k). 1600 is a conservative approximation of a typical screenshot at
 * high detail across current vision APIs.
 */
export const IMAGE_BLOCK_TOKENS = 1600;

// Hiragana, Katakana, CJK unified + compatibility ideographs, Hangul.
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7a3]/g;

/** Rough text size: ~4 chars per token, except CJK (~1 token per character —
 * chars/4 underestimates CJK roughly 4x). Conservative on purpose: a slight
 * overestimate only shrinks the output budget; an underestimate rejects. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(CJK_RE) ?? []).length;
  return Math.ceil((text.length - cjk) / 4) + cjk;
}

/** Recursively extract the text of one content block (tool_result content
 * can be an array of text-block objects; joining without recursion produced
 * "[object Object]" and a near-zero estimate — Sourcery HIGH finding). */
function blockText(b: unknown): string {
  if (typeof b === 'string') return b;
  if (b == null || typeof b !== 'object') return '';
  const block = b as Record<string, unknown>;
  if (typeof block.text === 'string') return block.text;
  if (Array.isArray(block.content)) return (block.content as unknown[]).map(blockText).join('');
  if (typeof block.content === 'string') return block.content;
  return '';
}

function isImageBlock(b: unknown): boolean {
  return (
    typeof b === 'object' &&
    b != null &&
    ((b as Record<string, unknown>).type === 'image' || 'source' in (b as Record<string, unknown>))
  );
}

/** Rough message size. Image blocks count as IMAGE_BLOCK_TOKENS, never as
 * their base64 payload (Sourcery finding: base64-as-text wasted the budget). */
export function estimateMessageTokens(messages: readonly { content?: unknown }[]): number {
  let total = 0;
  for (const msg of messages) {
    const c = msg.content;
    if (typeof c === 'string') {
      total += estimateTextTokens(c);
    } else if (Array.isArray(c)) {
      for (const b of c as unknown[]) {
        if (isImageBlock(b)) {
          total += IMAGE_BLOCK_TOKENS;
        } else {
          total += estimateTextTokens(blockText(b));
        }
      }
    } else if (c != null) {
      total += estimateTextTokens(String(c));
    }
  }
  return total;
}

/** Rough tool-schema size: serialized JSON characters / 4 (same rule as messages). */
export function estimateToolTokens(tools: unknown): number {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return estimateTextTokens(JSON.stringify(tools));
}

/**
 * The full planning input: messages + system prompt + tool schemas. The
 * provider counts all three against the window (Context.systemPrompt was
 * previously missing — Sourcery finding).
 */
export function estimateInputTokens(
  context: { systemPrompt?: string; messages: readonly { content?: unknown }[] },
  tools: unknown
): number {
  return (
    estimateMessageTokens(context.messages) +
    (context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0) +
    estimateToolTokens(tools)
  );
}

export type OutputBudget =
  | { kind: 'unknown' }
  | { kind: 'fits' }
  | { kind: 'capped'; maxTokens: number }
  | { kind: 'skip'; neededTokens: number };

export interface OutputBudgetInput {
  /** Model context window in tokens; null/0 = unknown. */
  readonly windowTokens: number | null | undefined;
  /** Message-text estimate plus tool-schema estimate. */
  readonly inputTokens: number;
  /** Explicitly requested output budget (`options.maxTokens`); undefined = none set. */
  readonly requestedOutput: number | undefined;
}

export function planOutputBudget(input: OutputBudgetInput): OutputBudget {
  const window = input.windowTokens;
  if (!window || window <= 0) return { kind: 'unknown' };
  const safety = safetyTokens(window);
  const available = window - input.inputTokens - safety;
  const minimumNeeded = input.inputTokens + safety + MIN_OUTPUT_TOKENS;

  if (input.requestedOutput === undefined) {
    // No explicit output budget: the provider applies its own default, which
    // we cannot see. Only the minimum has to fit.
    return available >= MIN_OUTPUT_TOKENS ? { kind: 'fits' } : { kind: 'skip', neededTokens: minimumNeeded };
  }
  if (input.requestedOutput <= available) return { kind: 'fits' };
  if (available >= MIN_OUTPUT_TOKENS) return { kind: 'capped', maxTokens: available };
  return { kind: 'skip', neededTokens: minimumNeeded };
}
