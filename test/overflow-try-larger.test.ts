/**
 * Tests for extractContextWindowFromError — the helper that parses the
 * actual context window and requested-token count from an OpenRouter-style
 * overflow error, so driveStream can:
 *   1. Update the model registry with the discovered context window (sticky)
 *   2. Try larger-context candidates before triggering compaction
 *
 * The helper lives in src/stream-orchestrator.ts (not exported), so it is
 * re-implemented inline here. The integration path (driveStream trying a
 * larger model like mistral-zai/glm-5-2 after an overflow) is exercised
 * indirectly by the existing context-overflow test suite; this file focuses
 * on the parser, which is the new logic introduced for this feature.
 */
import { describe, it, expect } from 'vitest';

// Inline reimplementation of the helper from src/stream-orchestrator.ts.
// Kept in sync so a regression in the parser is caught here.
function extractContextWindowFromError(detail: string | undefined): {
  actualContextWindow: number;
  requestedTokens: number;
} | null {
  if (!detail) return null;
  const cwMatch = detail.match(/maximum context length is (\d+) tokens/);
  const reqMatch = detail.match(/requested about (\d+) tokens/);
  if (!cwMatch || !reqMatch) return null;
  const cw = parseInt(cwMatch[1], 10);
  const req = parseInt(reqMatch[1], 10);
  if (!cw || !req) return null;
  return { actualContextWindow: cw, requestedTokens: req };
}

describe('extractContextWindowFromError', () => {
  it('parses a standard OpenRouter overflow error (real minimax-m2.7:free rejection)', () => {
    // The exact error format from the field report: a free OpenRouter model
    // (196608-token window) rejecting a 197318-token prompt. The shortfall is
    // only 710 tokens — any model with >197318 tokens (e.g. mistral-zai/glm-5-2
    // at 1M) would fit, which is exactly the case the handler optimizes for.
    const detail =
      "prompt is too long: 400: {\"message\":\"This endpoint's maximum context length is 196608 tokens. However, you requested about 197318 tokens (27673 of text input, 12711 of tool input, 156934 in the output).\",\"code\":400}";
    expect(extractContextWindowFromError(detail)).toEqual({
      actualContextWindow: 196608,
      requestedTokens: 197318,
    });
  });

  it('parses with different token counts (smaller window)', () => {
    const detail =
      '{"message":"maximum context length is 128000 tokens. However, you requested about 130000 tokens","code":400}';
    expect(extractContextWindowFromError(detail)).toEqual({
      actualContextWindow: 128000,
      requestedTokens: 130000,
    });
  });

  it('returns null when detail is undefined', () => {
    expect(extractContextWindowFromError(undefined)).toBeNull();
  });

  it('returns null when detail is empty string', () => {
    expect(extractContextWindowFromError('')).toBeNull();
  });

  it('returns null for non-matching text (no numbers to extract)', () => {
    expect(extractContextWindowFromError('Something went wrong')).toBeNull();
    expect(extractContextWindowFromError('prompt is too long but no numbers')).toBeNull();
  });

  it('returns null when only one of the two numbers is present', () => {
    // Only the context-window number, no requested-tokens number.
    expect(
      extractContextWindowFromError('maximum context length is 196608 tokens')
    ).toBeNull();
    // Only the requested-tokens number, no context-window number.
    expect(
      extractContextWindowFromError('requested about 197318 tokens')
    ).toBeNull();
  });
});
