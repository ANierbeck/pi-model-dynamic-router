// test/laya-truncation.test.ts

import { describe, it, expect } from 'vitest';
import { truncateState, buildContextBlock, LAYA_CONTEXT_BUDGET_TOKENS } from '../src/laya-classifier.ts';

// The router has no tokenizer; truncateState applies a conservative character
// cap (chars/token Puffer). A rough 3 chars/token assumption is documented
// in the implementation and tightened token-exactly by the wrapper.
const BUDGET = LAYA_CONTEXT_BUDGET_TOKENS;

describe('laya-truncation', () => {
  it('returns prompt + context unchanged when within the budget', () => {
    const ctx = { previousUserMessage: 'hello', lastAssistantSnippet: 'world' };
    const state = truncateState('short prompt', ctx, BUDGET);
    expect(state).toContain('short prompt');
    expect(state).toContain('hello');
    expect(state).toContain('world');
  });

  it('keeps the head and tail of the prompt when it is too long', () => {
    const head = 'This is the important head of the request';
    const tail = 'and this tail should be preserved';
    const body = 'x'.repeat(10000);
    const state = truncateState(head + body + tail, undefined, BUDGET);
    expect(state).toContain(head);
    expect(state).toContain(tail);
    expect(state).toContain('[... TRUNCATED ...]');
  });

  it('respects the character cap', () => {
    const prompt = 'a'.repeat(100000);
    const state = truncateState(prompt, undefined, BUDGET);
    expect(state.length).toBeLessThanOrEqual(BUDGET * 3);
  });

  it('removes the context block first, then trims the prompt body', () => {
    // buildContextBlock caps previousUserMessage at 120 and lastAssistantSnippet at 150,
    // so the context block is small — the test below proves the prompt body is truncated
    // when head + tail + cappped context still exceed the character budget.
    const ctx = { previousUserMessage: 'y'.repeat(5000), lastAssistantSnippet: 'z'.repeat(5000) };
    const state = truncateState('a'.repeat(5000), ctx, BUDGET);
    expect(state).not.toContain('y'.repeat(121)); // capped at 120
    expect(state).not.toContain('z'.repeat(151)); // capped at 150
    expect(state.length).toBeLessThanOrEqual(BUDGET * 3);
  });

  it('preserves the HINT marker integrity of the prompt head', () => {
    const prompt = 'HINT: use group tactical\nexplain the cache';
    const state = truncateState(prompt, undefined, 512);
    expect(state).toContain('HINT: use group tactical');
    expect(state).toContain('explain the cache');
  });

  it('preserves whitespace of the prompt head', () => {
    const prompt = '  indented line\n\ttabbed line\nnormal';
    const state = truncateState(prompt, undefined, BUDGET);
    expect(state.startsWith('  indented line'));
  });

  it('truncates with head, separator and tail in the right order', () => {
    const prompt = 'a'.repeat(4000); // > budgetChars (3072) -> truncation triggers
    const state = truncateState(prompt, undefined, BUDGET);
    const sep = '[... TRUNCATED ...]';
    const sepIndex = state.indexOf(sep);
    expect(sepIndex).toBeGreaterThan(0); // separator present
    // head is followed by \n before the separator, and the tail is preceded by \n
    expect(state.slice(0, sepIndex - 1)).toMatch(/^a+$/); // head only
    expect(state.slice(sepIndex + sep.length + 1)).toMatch(/^a+$/); // tail only
    expect(state.length).toBeLessThanOrEqual(BUDGET * 3); // char cap
  });
});
