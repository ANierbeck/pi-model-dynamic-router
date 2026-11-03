// scripts/lib/cli.ts — the shared script helpers
// (hygiene Phase 5 Step 3, docs/plans/2026-10-29-repo-hygiene.md).
//
// `arg` existed in two incompatible shapes across the scripts: three files
// only understood `--name=value`, one only `--name value`. A flag that worked
// in one script was silently ignored in the next. The shared version accepts
// both, which is what this test pins.

import { describe, it, expect } from 'vitest';
import { arg, invokedDirectly, isJsonRecord, offsetOf, pct } from '../scripts/lib/cli.ts';

describe('arg', () => {
  it('reads the --name=value shape', () => {
    expect(arg('log', ['--log=/tmp/x.jsonl'])).toBe('/tmp/x.jsonl');
  });

  it('reads the --name value shape', () => {
    expect(arg('log', ['--log', '/tmp/x.jsonl'])).toBe('/tmp/x.jsonl');
  });

  it('returns undefined when the flag is absent or has no value', () => {
    expect(arg('log', [])).toBeUndefined();
    expect(arg('log', ['--log'])).toBeUndefined();
    expect(arg('log', ['--log', '--other=1'])).toBeUndefined();
  });

  it('does not match a flag that only starts with the name', () => {
    expect(arg('log', ['--logger=/tmp/x'])).toBeUndefined();
  });
});

describe('invokedDirectly', () => {
  it('compares the CALLER url with argv[1], not the library url', () => {
    // The guard moved from four scripts into this module; reading
    // import.meta.url here would make it false for every script and silently
    // disable the pre-push hook's entry point.
    expect(invokedDirectly(import.meta.url)).toBe(false); // vitest is argv[1]
    expect(invokedDirectly('file:///definitely/not/argv1.ts')).toBe(false);
  });
});

describe('isJsonRecord', () => {
  it('accepts a plain object and rejects null, arrays and primitives', () => {
    expect(isJsonRecord({})).toBe(true);
    expect(isJsonRecord(null)).toBe(false);
    expect(isJsonRecord([])).toBe(false);
    expect(isJsonRecord('x')).toBe(false);
    expect(isJsonRecord(0)).toBe(false);
  });
});

describe('offsetOf', () => {
  it('maps a 1-based line/column to a source offset', () => {
    const src = 'abc\ndef\nghi';
    expect(offsetOf(src, 1, 1)).toBe(0);
    expect(offsetOf(src, 2, 1)).toBe(4);
    expect(offsetOf(src, 3, 2)).toBe(9);
  });
});

describe('pct', () => {
  it('formats a share with one decimal and an en dash for an empty denominator', () => {
    expect(pct(1, 4)).toBe('25.0 %');
    expect(pct(0, 0)).toBe('–');
  });
});
