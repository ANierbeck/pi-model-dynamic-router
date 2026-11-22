// Task-type balancing step 5c (docs/plans/2026-11-19-fresh-session-suggestion.md):
// the pure trigger heuristic for suggesting (never forcing) a fresh session.
// Red-first per AGENTS.md §4: written against the unfixed implementation.

import { describe, expect, it, vi } from 'vitest';

// Spy-Wrapper: capture what the event-handlers' turn_start wiring PASSES to
// runContextCompaction (the reset/rebase contract pins its arguments).
vi.mock('../src/context-compaction.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/context-compaction.ts')>();
  const calls: Array<Parameters<typeof actual.runContextCompaction>[0]> = [];
  return {
    ...actual,
    __compactionCalls: calls,
    runContextCompaction: (opts: Parameters<typeof actual.runContextCompaction>[0]) => {
      calls.push(opts);
      return actual.runContextCompaction(opts);
    },
  };
});
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
    expect(d).toMatchObject({
      suggest: true,
      reason: expect.stringMatching(/compaction is not sticking/),
    });
  });

  it('suggests when the cache went cold from idling and the context share is high', () => {
    const d = decideFreshStart(input({ cold: false, idleSeconds: 20 * 60 }));
    expect(d.suggest).toBe(true);
    expect(d.suggest && d.reason).toMatch(/cache went cold from idling/);
  });

  it('suggests on a plain cold cache with a large context even without compactions', () => {
    const d = decideFreshStart(input({ compactionsThisSession: 0, idleSeconds: 10 }));
    expect(d).toMatchObject({
      suggest: true,
      reason: expect.stringMatching(/cache cold and context large/),
    });
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
  HINT_COOLDOWN_MS,
  noteSessionCompaction,
  runContextCompaction,
  type CompactionRunState,
} from '../src/context-compaction.ts';
import { freshStatusLine } from '../src/fresh-session.ts';
import type { Config } from '../src/types.ts';

const now = 1_800_000_000_000;

const freshHarness = (
  over: {
    cfg?: Partial<Config['context_budget']>;
    tokens?: number | null;
    compactionsRun?: number;
    lastHintAt?: number;
    usage?: { cacheRead: number; ts: number };
  } = {}
) => {
  const notify = vi.fn();
  const compact = vi.fn();
  const usageLog = [
    {
      ref: 'x/y',
      tokens: 100,
      ts: over.usage?.ts ?? now - 1_000,
      cacheRead: over.usage?.cacheRead ?? 90,
    },
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
  it('fires WITHOUT soft/hard thresholds configured — independent of the 5b gates', () => {
    // Review P1 (PR #193 round): the 5b early return ("nothing configured →
    // measurement only") used to swallow the 5c block, so the suggestion was
    // silently dead while /router status reported the switch as on.
    const h = freshHarness({
      cfg: {
        soft_tokens: undefined as unknown as number,
        hard_tokens: undefined as unknown as number,
      },
      usage: { cacheRead: 5, ts: now - 20 * 60 * 1_000 }, // cold from idling
    });
    expect(h.notify).toHaveBeenCalled();
    expect(h.notify.mock.calls.join(' ')).toMatch(/fresh session/i);
  });

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
    const state: CompactionRunState = {
      lastHintAt: 0,
      compactionsRun: 0,
      turnSeqAtStart: 0,
    };
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

  it('resetSessionTally zeroes the compaction count and rebases the step count', async () => {
    const { resetSessionTally } = await import('../src/context-compaction.ts');
    const state = { lastHintAt: 7, compactionsRun: 3, turnSeqAtStart: 2 } as Parameters<
      typeof resetSessionTally
    >[0];
    resetSessionTally(state, 55);
    // lastHintAt survives: the cooldown is a process property, not a session one.
    expect(state).toEqual({ lastHintAt: 7, compactionsRun: 0, turnSeqAtStart: 55 });
  });

  it('session switches (new/resume/fork) reset tally+steps; subagent startup does not', async () => {
    // PR #193 review P2: the per-session tally and the step baseline must
    // follow the session. The handover compaction of `/router fresh` fires in
    // the OLD session (session_compact precedes session_start) and must not
    // count into the new one. Pinned through what the turn_start wiring
    // actually PASSES to runContextCompaction (stepsThisSession and the
    // state's tally) — a broken wiring fails both assertions.
    const cc = await import('../src/context-compaction.ts');
    const calls: Array<Parameters<typeof cc.runContextCompaction>[0]> = (
      cc as unknown as { __compactionCalls: typeof calls }
    ).__compactionCalls;
    calls.length = 0;

    const { createEventHandlers } = await import('../src/event-handlers.ts');
    const handlers: Record<string, Array<(ev: unknown, ctx: unknown) => void>> = {};
    const rt = {
      pi: { on: (ev: string, h: unknown) => void (handlers[ev] ??= []).push(h) },
      turnSeq: 41,
      cfg: { model_groups: {}, model_metrics: {} } as never,
      activeGroup: null,
      cache: { usage_log: [] },
      sessionCtx: undefined,
      router: { setSessionCtx: () => {}, noteTurnStart: () => {} },
      load: () => {},
      loadCache: () => {},
      loadModelMap: () => {},
      extDir: '',
      updateErrorStatusLine: () => {},
      registerGroupModels: () => {},
      escalation: { reset: () => {} },
      scan: () => Promise.resolve(),
      statusUpdater: undefined,
    };
    createEventHandlers(rt as never);
    const tuiCtx = {
      ui: { setStatus: () => {}, notify: () => {}, setFooter: () => {} },
      cwd: '/tmp',
      // The handler publishes the registry FIRST — the stub keeps the rest of
      // the handler (including the reset) alive.
      modelRegistry: { getRegisteredProviderIds: () => [] },
    } as never;

    // Boot ('startup' as the FIRST start of the process resets+rebases),
    // 2 compactions, then a real switch ('new'), 2 further compactions,
    // 1 turn — the passed state must show the RESET tally (2) and the REBASED
    // steps (1), not the process-lifetime values (4 / 42).
    handlers['session_compact']?.[0]?.(undefined, tuiCtx);
    handlers['session_start'][0]({ reason: 'startup' }, tuiCtx);
    handlers['session_compact']?.[0]?.(undefined, tuiCtx);
    handlers['session_compact']?.[0]?.(undefined, tuiCtx);
    handlers['session_start'][0]({ reason: 'new' }, tuiCtx);
    handlers['session_compact']?.[0]?.(undefined, tuiCtx);
    handlers['session_compact']?.[0]?.(undefined, tuiCtx);
    handlers['turn_start'][0]({ reason: 'startup' }, tuiCtx);

    const last = calls[calls.length - 1];
    expect(last, 'runContextCompaction was called at the turn boundary').toBeTruthy();
    expect(last!.stepsThisSession).toBe(1); // rebased: turnSeq 42 - base 41
    expect(last!.state.compactionsRun).toBe(2); // reset at the switch, not 4

    // A subagent's re-fired 'startup' (sessionAnchorInit already true) must
    // NOT clobber the running session's state.
    handlers['session_compact']?.[0]?.(undefined, tuiCtx);
    handlers['session_start'][0]({ reason: 'startup' }, tuiCtx);
    handlers['turn_start'][0]({}, tuiCtx);
    const after = calls[calls.length - 1];
    expect(after!.state.compactionsRun).toBe(3); // tally survived the startup
    expect(after!.stepsThisSession).toBe(2);
  });

  it('the status line names the trigger, the command, and that the command waits for the turn', () => {
    expect(
      freshStatusLine({
        suggest: true,
        reason: 'compaction is not sticking: context grew back; a fresh session wins',
      })
    ).toMatch(
      /^fresh session suggested — compaction is not sticking.*\/router fresh \(runs after the current turn\)$/s
    );
    expect(freshStatusLine({ suggest: false })).toBe('');
  });
});

describe('fresh hint: once per reason per session (busy-session plan)', () => {
  const call = (
    state: any,
    now: number,
    compactionsRun: number,
    usage?: { cacheRead: number; ts: number }
  ) => {
    const notify = vi.fn();
    const usageLog = [
      { ref: 'x/y', tokens: 100, ts: usage?.ts ?? now - 1_000, cacheRead: usage?.cacheRead ?? 90 },
    ];
    const ctx = {
      getContextUsage: () => ({ tokens: 150_000, contextWindow: 200_000 }),
      compact: vi.fn(),
      ui: { notify },
    };
    const cfg = {
      context_budget: {
        enabled: false,
        soft_tokens: 100_000,
        hard_tokens: 200_000,
        cache_ttl_s: 300,
        fresh_session: { enabled: true },
      },
    } as unknown as Config;
    runContextCompaction({
      ctx,
      cfg,
      activeGroup: null,
      usageLog,
      state,
      stepsThisSession: 40,
      now,
    });
    return notify;
  };

  it('the same reason does not re-fire after the cooldown; a new reason does', () => {
    const state: any = {
      lastHintAt: 0,
      compactionsRun: 2,
      turnSeqAtStart: 0,
      lastFreshReason: null,
    };
    const n1 = call(state, now, 2);
    expect(n1).toHaveBeenCalledTimes(1);
    const n2 = call(state, now + HINT_COOLDOWN_MS, 2); // same reason: stuck
    expect(n2).not.toHaveBeenCalled(); // RED: current code re-fires on the cooldown alone
    const n3 = call(state, now + 2 * HINT_COOLDOWN_MS, 0, { cacheRead: 5, ts: now - 20 * 60_000 }); // idle reason
    expect(n3).toHaveBeenCalledTimes(1); // RED: different reason must fire
  });
});
