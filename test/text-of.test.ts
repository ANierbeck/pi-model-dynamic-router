// textOf (src/utils.ts) — the diagnostic text for an arbitrary value.
//
// Burn-down S2 replaced `String(value)` at the two call sites that can receive
// objects (token estimate of unknown message content, the logger's extra
// argument). `String()` prints "[object Object]" for every object, so the
// estimate counted 15 characters for any content shape and the log lost the
// payload. These tests pin the replacement's behaviour, including the cases
// where JSON is not available.
import { describe, it, expect } from 'vitest';
import { textOf } from '../src/utils.ts';
import { estimateMessageTokens } from '../src/context-budget.ts';

describe('textOf', () => {
  it('passes strings through unchanged', () => {
    expect(textOf('plain')).toBe('plain');
  });

  it('keeps String() for primitives', () => {
    expect(textOf(42)).toBe('42');
    expect(textOf(true)).toBe('true');
    expect(textOf(null)).toBe('null');
    expect(textOf(undefined)).toBe('undefined');
  });

  it('prints a symbol by its description, which String() would refuse at runtime', () => {
    expect(textOf(Symbol('x'))).toBe('Symbol(x)');
  });

  it('prints an object as its JSON, not "[object Object]"', () => {
    expect(textOf({ type: 'image', data: 'abc' })).toBe('{"type":"image","data":"abc"}');
    expect(textOf([1, 'two'])).toBe('[1,"two"]');
  });

  it('falls back to the object tag for a circular value', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(textOf(cyclic)).toBe('[object Object]');
  });

  it('falls back to the object tag when toJSON throws', () => {
    const hostile = { toJSON() { throw new Error('nope'); } };
    expect(textOf(hostile)).toBe('[object Object]');
  });

  it('falls back to the object tag when JSON.stringify yields undefined', () => {
    // toJSON returning undefined makes JSON.stringify return undefined.
    const undef = { toJSON: () => undefined };
    expect(textOf(undef)).toBe('[object Object]');
  });

  it('keeps the tag for a Date-like value that JSON cannot express fully', () => {
    // A Date serializes through its toJSON to an ISO string (quoted), so the
    // shape is still visible; it must not collapse to "[object Date]" or
    // "[object Object]".
    const d = new Date('2026-11-05T00:00:00.000Z');
    expect(textOf(d)).toBe('"2026-11-05T00:00:00.000Z"');
  });
});

describe('estimateMessageTokens — unknown content shapes are counted by their JSON', () => {
  it('counts an object content by its JSON, not by a fixed 15-character tag', () => {
    const payload = { type: 'x', data: 'y'.repeat(400) };
    const counted = estimateMessageTokens([{ content: payload }]);
    // "[object Object]" would be ~15 chars (≈4 tokens). The JSON is ~420 chars.
    expect(counted).toBeGreaterThan(100);
  });
});
