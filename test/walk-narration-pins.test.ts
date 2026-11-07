// Mutation slice 2 batch 4 (docs/mutation-data/slice2-triage/pre.md cluster D
// and core.md cluster D): the repetition_loop / truncated_length narrations of
// the MAIN candidate loop. The collapse-block twins are pinned in
// cooldown-collapse-retried-narration.test.ts; the lookahead guards of the
// "trying X …" suffix live in ollama-fallback-skip-when-down.test.ts (they
// need the ollama mock, and the ollamaMockFiles ratchet forbids a new file
// for them).
//
// Walk-level harness (test/helpers/walk-stub-ctx.ts): the real driveStream
// walk with explicit candidates, so the candidate order is part of the
// fixture.

import { describe, it, expect, vi } from 'vitest';

import { walkStubWorld } from './helpers/walk-stub-ctx.ts';

vi.mock('../src/logger.ts', async (orig) => {
  const actual = await orig<typeof import('../src/logger.ts')>();
  return {
    ...actual,
    appendRawLog: vi.fn(),
    routerLog: vi.fn(),
    warnLog: vi.fn(),
    errorLog: vi.fn(),
  };
});

describe('main-loop narrations: repetition and truncation name their failure', () => {
  it('a repetition_loop candidate is narrated as stuck, then the next candidate serves', async () => {
    const w = walkStubWorld({
      results: {
        '*': { ok: false, reason: 'repetition_loop', detail: 'echoed 12 lines' },
        'c/two': { ok: true },
      },
    });
    const { text } = await w.run(['a/one', 'c/two']);

    expect(text).toContain('a/one — stuck in a repetition loop (echoed 12 lines)');
    expect(text).not.toContain('output truncated at max tokens');
    expect(w.attempts.map((a) => a.ref)).toEqual(['a/one', 'c/two']);
  });

  it('a truncated_length candidate is narrated as incomplete, then the next candidate serves', async () => {
    const w = walkStubWorld({
      results: {
        '*': { ok: false, reason: 'truncated_length' },
        'c/two': { ok: true },
      },
    });
    const { text } = await w.run(['a/one', 'c/two']);

    expect(text).toContain('a/one — output truncated at max tokens (task incomplete)');
    expect(text).not.toContain('stuck in a repetition loop');
    expect(w.attempts.map((a) => a.ref)).toEqual(['a/one', 'c/two']);
  });
});
