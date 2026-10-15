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

/** Rough message-text size: chars / 4 (text blocks of arrays are summed). */
export function estimateMessageTokens(messages: readonly { content?: unknown }[]): number {
  let total = 0;
  for (const msg of messages) {
    // Content may be a string OR an array of content blocks (text, tool_use,
    // tool_result, image, etc.). For arrays, sum the text representation of
    // every block — a tool_result block can easily carry tens of thousands of
    // tokens. Treating arrays as '' silently produced a 0-token estimate.
    const c = msg.content;
    let text: string;
    if (typeof c === 'string') {
      text = c;
    } else if (Array.isArray(c)) {
      text = c
        .map((b: any) =>
          typeof b === 'string' ? b : b?.text ?? b?.content ?? (b != null ? JSON.stringify(b) : '')
        )
        .join('');
    } else {
      text = c != null ? String(c) : '';
    }
    total += Math.ceil(text.length / 4); // Rough estimate: 4 chars ≈ 1 token
  }
  return total;
}

/** Rough tool-schema size: serialized JSON characters / 4 (same rule as messages). */
export function estimateToolTokens(tools: unknown): number {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return Math.ceil(JSON.stringify(tools).length / 4);
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
