// Task-type balancing step 5c (docs/plans/2026-11-19-fresh-session-suggestion.md):
// the pure trigger heuristic for suggesting (never forcing) a fresh session.
// Red-first per AGENTS.md §4: written against the unfixed implementation.

import { describe, expect, it } from 'vitest';
import { FRESH_DEFAULTS, decideFreshStart } from '../src/fresh-session.ts';
import type { ContextBudgetConfig } from '../src/types.ts';

const budget = (over: Partial<ContextBudgetConfig> = {}): ContextBudgetConfig | undefined =>
  ({
    enabled: true,
    soft_tokens: 100_000,
    hard_tokens: 200_000,
    cache_ttl_s: 300,
    ...over,
  }) as ContextBudgetConfig;

const input = (over: Record<string, unknown> = {}) => ({
  budget: budget(),
  freshEnabled: true,
  cold: true,
  contextTokens: 150_000,
  contextWindow: 200_000,
  idleSeconds: 4 * 60,
  stepsSinceSessionStart: 40,
  compactionsThisSession: 2, // 5b already compacted twice this session
  ...over,
});

describe('fresh-session suggestion', () => {
  it('suggests when compaction is not sticking (cold, large, compacted twice)', () => {
    const d = decideFreshStart(input());
    expect(d).toMatchObject({ suggest: true, reason: expect.stringMatching(/compaction is not sticking/) });
  });

  it('suggests when the cache went cold from idling and the context share is high', () => {
    const d = decideFreshStart(input({ cold: false, idleSeconds: 20 * 60 }));
    expect(d.suggest).toBe(true);
    expect(d.suggest && d.reason).toMatch(/cache went cold from idling/);
  });

  it('suggests on a plain cold cache with a large context even without compactions', () => {
    const d = decideFreshStart(input({ compactionsThisSession: 0, idleSeconds: 10 }));
    expect(d).toMatchObject({ suggest: true, reason: expect.stringMatching(/cache cold and context large/) });
  });

  it('never suggests while the cache serves hits on a small context', () => {
    const d = decideFreshStart(
      input({ cold: false, idleSeconds: 10, contextTokens: 20_000, compactionsThisSession: 0 })
    );
    expect(d).toEqual({ suggest: false });
  });

  it('respects the context share gate before suggesting', () => {
    const d = decideFreshStart(input({ contextWindow: 1_000_000 })); // 15 % share
    expect(d.suggest).toBe(false);
  });

  it('respects after_turns (default) before suggesting', () => {
    expect(decideFreshStart(input({ stepsSinceSessionStart: 3 })).suggest).toBe(false);
  });

  it('is off when the feature is disabled — the shipped default', () => {
    expect(decideFreshStart(input({ freshEnabled: false })).suggest).toBe(false);
    expect(decideFreshStart(input({ budget: undefined })).suggest).toBe(false);
  });

  it('exposes the shipped defaults', () => {
    expect(FRESH_DEFAULTS.min_ctx_share).toBe(0.6);
    expect(FRESH_DEFAULTS.after_turns).toBe(10);
    expect(FRESH_DEFAULTS.cold_idle_s).toBe(15 * 60);
  });
});

// ── Task 2: the suggestion surfaces through the 5b hint channel ──────────
import {
  noteSessionCompaction,
  runContextCompaction,
  type CompactionRunState,
} from '../src/context-compaction.ts';
import { freshStatusLine } from '../src/fresh-session.ts';
import type { Config } from '../src/types.ts';

const now = 1_800_000_000_000;

const freshHarness = (over: {
  cfg?: Partial<Config['context_budget']>;
  tokens?: number | null;
  compactionsRun?: number;
  lastHintAt?: number;
  usage?: { cacheRead: number; ts: number };
} = {}) => {
  const notify = vi.fn();
  const compact = vi.fn();
  const usageLog = [
    { ref: 'x/y', tokens: 100, ts: over.usage?.ts ?? now - 1_000, cacheRead: over.usage?.cacheRead ?? 90 },
  ];
  const state = { lastHintAt: over.lastHintAt ?? 0, compactionsRun: over.compactionsRun ?? 0 };
  const ctx = {
    getContextUsage: () => ({ tokens: over.tokens ?? 150_000, contextWindow: 200_000 }),
    compact,
    ui: { notify },
  };
  const cfg = {
    context_budget: {
      enabled: false,
      soft_tokens: 100_000,
      hard_tokens: 200_000,
      cache_ttl_s: 300,
      fresh_session: { enabled: true },
      ...over.cfg,
    },
  } as unknown as Config;
  runContextCompaction({ ctx, cfg, activeGroup: null, usageLog, state, stepsThisSession: 40, now });
  return { notify, compact, state };
};

describe('fresh-session wiring (5b hint channel)', () => {
  it('compaction is not sticking: the suggestion notifies with the invocation', () => {
    const { notify, state } = freshHarness({ compactionsRun: 2 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/fresh session suggested.*\/router fresh/s);
    expect(state.lastHintAt).toBe(now);
  });

  it('shares the hint cooldown with the 5b compaction hint', () => {
    const { notify } = freshHarness({ compactionsRun: 2, lastHintAt: now - 5 * 60_000 });
    expect(notify).not.toHaveBeenCalled();
  });

  it('the 5b compaction decision does NOT itself increment the tally (no double count)', () => {
    // Red first: the increment used to sit here AND in the session_compact
    // handler, counting one compaction twice.
    const { compact, state, notify } = freshHarness({
      cfg: { enabled: true, hard_tokens: 100_000, fresh_session: { enabled: false } },
    });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(state.compactionsRun).toBe(0);
    expect(notify).not.toHaveBeenCalled(); // fresh off: tally only
  });

  it('noteSessionCompaction is the single tally increment (the session_compact wiring calls it)', () => {
    // Red first: the helper did not exist.
    const state: CompactionRunState = { lastHintAt: 0, compactionsRun: 0 };
    noteSessionCompaction(state);
    noteSessionCompaction(state);
    expect(state.compactionsRun).toBe(2);
  });

  it('the shipped default (no fresh_session key) never notifies', () => {
    const { notify } = freshHarness({
      cfg: { fresh_session: undefined },
      compactionsRun: 2,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('the status line names the trigger and the command', () => {
    expect(
      freshStatusLine({
        suggest: true,
        reason: 'compaction is not sticking: context grew back; a fresh session wins',
      })
    ).toMatch(/^fresh session suggested — compaction is not sticking.*\/router fresh$/s);
    expect(freshStatusLine({ suggest: false })).toBe('');
  });
});
