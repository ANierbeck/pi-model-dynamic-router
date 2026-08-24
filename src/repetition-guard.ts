// src/repetition-guard.ts
// Detects degenerate token-repetition loops in streamed model output.
//
// WHY: some models (observed with devstral variants) occasionally get stuck
// repeating the same sentence or phrase verbatim, over and over, until they
// either exhaust max_tokens or fill the context window and the provider
// rejects further generation. consumeWithDetection() in index.ts already
// catches rate-limit and context-overflow text, but a self-inflicted
// repetition loop is neither — the provider is happy to keep streaming, the
// model is just stuck. Left unchecked, this burns the full context window
// and surfaces as a hard context-overflow error, then the router retries the
// SAME unhealthy model on the next turn and the cycle repeats.
//
// This module only classifies accumulated text; it has no knowledge of
// streams, retries, or model health — that plumbing lives in index.ts, which
// calls detectDegenerateRepetition() periodically while consuming a stream
// and treats a detected loop as a soft failure (same escalation path as an
// empty response), so the group falls over to the next candidate and the
// looping model gets demoted via model-health.ts.

/** Don't bother checking until this much text has accumulated — short replies can't loop yet. */
export const REPETITION_MIN_TOTAL_LEN = 400;
/** Only inspect the tail of the accumulated text — loops are a live, ongoing pattern, not history. */
export const REPETITION_WINDOW = 3000;
/** Repeating units shorter than this are usually formatting (bullets, table rules), not a real loop. */
export const REPETITION_MIN_UNIT_LEN = 20;
export const REPETITION_MAX_UNIT_LEN = 400;
/** Consecutive identical repeats required before it counts as a loop, not coincidental phrasing. */
export const REPETITION_MIN_REPEATS = 6;
/** A repeating unit must contain at least this many letters — filters out dashes/pipes/whitespace runs. */
export const REPETITION_MIN_UNIT_LETTERS = 8;

export interface RepetitionResult {
  detected: boolean;
  unit?: string;
  repeats?: number;
}

function letterCount(s: string): number {
  return (s.match(/\p{L}/gu) ?? []).length;
}

/**
 * Checks whether the tail of `fullText` consists of a short unit repeated
 * consecutively many times — the signature of a degenerate generation loop.
 * Only looks backward from the very end, so a loop that occurred earlier in
 * the stream but was followed by distinct content is correctly ignored: the
 * model recovered, there's nothing to interrupt.
 */
export function detectDegenerateRepetition(fullText: string): RepetitionResult {
  if (fullText.length < REPETITION_MIN_TOTAL_LEN) return { detected: false };

  const tail = fullText.length > REPETITION_WINDOW ? fullText.slice(-REPETITION_WINDOW) : fullText;
  const maxUnit = Math.min(REPETITION_MAX_UNIT_LEN, Math.floor(tail.length / REPETITION_MIN_REPEATS));

  for (let unitLen = REPETITION_MIN_UNIT_LEN; unitLen <= maxUnit; unitLen++) {
    const unit = tail.slice(tail.length - unitLen);
    if (letterCount(unit) < REPETITION_MIN_UNIT_LETTERS) continue;

    let repeats = 1;
    let pos = tail.length - unitLen * 2;
    while (pos >= 0 && tail.slice(pos, pos + unitLen) === unit) {
      repeats++;
      pos -= unitLen;
    }
    if (repeats >= REPETITION_MIN_REPEATS) {
      return { detected: true, unit, repeats };
    }
  }

  return { detected: false };
}
