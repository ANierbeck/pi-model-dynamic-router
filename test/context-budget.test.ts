// test/context-budget.test.ts
//
// Output-aware window planning (src/context-budget.ts). The request that
// failed live on 2026-10-13 (ling-3.1-flash, 262 144-token window):
// 164 591 text input + 13 087 tool input + 165 880 requested output.

import { describe, it, expect } from 'vitest';
import {
  estimateInputTokens,
  estimateMessageTokens,
  estimateToolTokens,
  IMAGE_BLOCK_TOKENS,
  MIN_OUTPUT_TOKENS,
  planOutputBudget,
  safetyTokens,
} from '../src/context-budget.ts';

const WINDOW = 262_144;

describe('safetyTokens', () => {
  it('is 5 % of the window for large windows', () => {
    expect(safetyTokens(WINDOW)).toBe(Math.ceil(WINDOW * 0.05));
  });

  it('has an absolute floor of 2048 for small windows', () => {
    expect(safetyTokens(8_192)).toBe(2048);
  });
});

describe('estimateToolTokens', () => {
  it('is zero without tools', () => {
    expect(estimateToolTokens(undefined)).toBe(0);
    expect(estimateToolTokens([])).toBe(0);
  });

  it('is the serialized JSON length / 4 (same rule as message text)', () => {
    const tools = [{ name: 'read', parameters: { type: 'object' } }];
    expect(estimateToolTokens(tools)).toBe(Math.ceil(JSON.stringify(tools).length / 4));
  });
});

describe('planOutputBudget', () => {
  it('leaves a request that fits untouched', () => {
    expect(
      planOutputBudget({ windowTokens: WINDOW, inputTokens: 50_000, requestedOutput: 40_000 })
    ).toEqual({ kind: 'fits' });
  });

  it('caps the output to what the window leaves (2026-10-13 reconstruction)', () => {
    const inputTokens = 164_591 + 13_087; // text + tool input from the provider error
    const plan = planOutputBudget({ windowTokens: WINDOW, inputTokens, requestedOutput: 165_880 });
    expect(plan).toEqual({
      kind: 'capped',
      maxTokens: WINDOW - inputTokens - safetyTokens(WINDOW),
    });
    // The capped request would have been accepted: input + output + margin fit.
    const capped = (plan as { maxTokens: number }).maxTokens;
    expect(inputTokens + capped + safetyTokens(WINDOW)).toBeLessThanOrEqual(WINDOW);
    expect(capped).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
  });

  it('counts nested tool-result content blocks (not "[object Object]")', () => {
    // Sourcery HIGH: a tool_result block whose content is an array of
    // text-block objects must contribute its real text size.
    const messages = [
      {
        role: 'tool_result',
        content: [{ type: 'tool_result', content: [{ type: 'text', text: 'x'.repeat(4000) }] }],
      },
    ];
    expect(estimateMessageTokens(messages as any)).toBeGreaterThanOrEqual(1000);
  });

  it('counts CJK text at ~1 token per character, not chars/4', () => {
    const messages = [{ role: 'user', content: '中'.repeat(10_000) }];
    expect(estimateMessageTokens(messages as any)).toBeGreaterThanOrEqual(10_000);
  });

  it('counts image blocks as a fixed image-token cost, not their base64 payload', () => {
    const messages = [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'a'.repeat(400_000) } }] },
    ];
    expect(estimateMessageTokens(messages as any)).toBe(IMAGE_BLOCK_TOKENS);
  });

  it('estimateInputTokens includes the system prompt and tool schemas', () => {
    const context = { systemPrompt: 's'.repeat(20_000), messages: [{ role: 'user', content: 'hello' }] };
    const tools = [{ name: 'read', parameters: { type: 'object' } }];
    const got = estimateInputTokens(context as any, tools);
    expect(got).toBeGreaterThanOrEqual(5_000); // 20k/4 system prompt alone
    expect(got).toBe(
      estimateMessageTokens(context.messages) + 20_000 / 4 + estimateToolTokens(tools)
    );
  });

  it('skips when even the minimum output does not fit', () => {
    const plan = planOutputBudget({ windowTokens: WINDOW, inputTokens: 260_000, requestedOutput: 165_880 });
    expect(plan.kind).toBe('skip');
  });

  it('unknown window means no decision', () => {
    expect(
      planOutputBudget({ windowTokens: null, inputTokens: 900_000, requestedOutput: 165_880 })
    ).toEqual({ kind: 'unknown' });
    expect(
      planOutputBudget({ windowTokens: 0, inputTokens: 900_000, requestedOutput: 165_880 })
    ).toEqual({ kind: 'unknown' });
  });

  it('without an explicit output budget only the minimum has to fit', () => {
    expect(
      planOutputBudget({ windowTokens: WINDOW, inputTokens: 100_000, requestedOutput: undefined })
    ).toEqual({ kind: 'fits' });
    expect(
      planOutputBudget({ windowTokens: WINDOW, inputTokens: 260_000, requestedOutput: undefined })
    ).toEqual({ kind: 'skip', neededTokens: 260_000 + safetyTokens(WINDOW) + MIN_OUTPUT_TOKENS });
  });
});
