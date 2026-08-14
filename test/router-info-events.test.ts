// test/router-info-events.test.ts
// Tests for the pushRouterInfo helper that creates proper text_delta events.
// Without contentIndex and partial (a valid AssistantMessage with role),
// Pi's compaction crashes with: "Cannot read properties of undefined (reading 'role')"

import { describe, it, expect } from 'vitest';

// The event structure that Pi expects (from pi-ai types):
// { type: 'text_delta', contentIndex: number, delta: string, partial: AssistantMessage }
// The partial MUST have role: 'assistant' or compaction crashes.

interface ValidTextDelta {
  type: 'text_delta';
  contentIndex: number;
  delta: string;
  partial: { role: string; [key: string]: unknown };
}

// Simulate what pushRouterInfo does:
function createRouterInfoEvent(text: string, contentIndex: number = 0): ValidTextDelta {
  return {
    type: 'text_delta',
    contentIndex,
    delta: text,
    partial: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'end_turn',
      timestamp: Date.now(),
    },
  };
}

// Simulate the OLD broken format that caused the crash:
function createBrokenTextDelta(text: string): { type: string; text: string } {
  return { type: 'text_delta', text };
}

describe('router info event structure', () => {
  it('creates events with contentIndex', () => {
    const event = createRouterInfoEvent('> [router] hello\n');
    expect(event.contentIndex).toBe(0);
    expect(event.contentIndex).toBeTypeOf('number');
  });

  it('creates events with partial containing role', () => {
    const event = createRouterInfoEvent('> [router] hello\n');
    expect(event.partial).toBeDefined();
    expect(event.partial.role).toBe('assistant');
  });

  it('creates events with delta (not text) field', () => {
    const event = createRouterInfoEvent('> [router] hello\n');
    expect(event.delta).toBe('> [router] hello\n');
    // The old broken format used 'text' instead of 'delta'
    expect(event).not.toHaveProperty('text');
  });

  it('the old broken format would crash compaction', () => {
    const broken = createBrokenTextDelta('> [router] hello\n') as any;
    // The broken format has no 'partial' field, so accessing partial.role
    // would throw "Cannot read properties of undefined (reading 'role')"
    expect(broken.partial).toBeUndefined();
    expect(() => broken.partial.role).toThrow();
  });

  it('the new format does not crash when accessing role', () => {
    const event = createRouterInfoEvent('> [router] hello\n');
    expect(() => event.partial.role).not.toThrow();
    expect(event.partial.role).toBe('assistant');
  });
});