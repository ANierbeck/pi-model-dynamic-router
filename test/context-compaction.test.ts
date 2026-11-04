// test/context-compaction.test.ts
// Task-type-balancing Phase 5b (docs/plans/2026-10-05-task-type-balancing.md):
// cache-aware compaction. OPT-IN (default off — absent `context_budget` =
// measurement only, which 5a already ships). Compaction runs ONLY between
// turns (turn_start), never between tool steps. A COLD cache is the cheapest
// moment to compact: after a miss the next step pays full input price anyway,
// so compacting then discards nothing already paid for; compacting a WARM
// cache throws a paid cache away (cacheRead was 72% of $92 over 4 days).
//
//   cold (miss on the last step, or idle gap > cache_ttl_s) AND context >
//   soft_tokens → compact at the next turn boundary; context > hard_tokens
//   regardless of cache state → compact; otherwise leave a warm cache alone.
//
// When auto-compaction is disabled (enabled false, but thresholds
// configured), the same conditions only produce a HINT ("compacting now would
// pay off: /compact") instead.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CACHE_MISS_SHARE_THRESHOLD,
  decideCompaction,
  isCacheCold,
  lastStepCacheState,
  resolveContextBudget,
  runContextCompaction,
  type CompactionRunState,
} from '../src/context-compaction.ts';
import { createEventHandlers } from '../src/event-handlers.ts';
import { SessionEscalation } from '../src/escalation.ts';
import type { Config, UsageLogEntry } from '../src/types.ts';

// The runner logs through the shared file logger; mock it so no test touches
// real log files and log lines stay assertable.
vi.mock('../src/logger.ts', async (orig) => {
  const actual = await orig<typeof import('../src/logger.ts')>();
  return { ...actual, routerLog: vi.fn(), debugLog: vi.fn() };
});

const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();
const SOFT = 300_000;
const HARD = 800_000;

function ctxFixture(overrides: Partial<Record<'tokens' | 'contextWindow' | 'percent', number | null>> = {}) {
  return {
    tokens: 500_000,
    contextWindow: 1_000_000,
    percent: 50,
    ...overrides,
  };
}

function fakeCtx(usage = ctxFixture()) {
  const compact = vi.fn();
  const notify = vi.fn();
  return {
    compact,
    notify,
    ctx: {
      getContextUsage: () => usage,
      compact,
      ui: { notify },
    } as any,
  };
}

// ── decideCompaction (pure) ─────────────────────────────────────────────────

describe('decideCompaction', () => {
  it('cold cache + over soft (enabled) → compact at the turn boundary', () => {
    const d = decideCompaction(
      { enabled: true, soft_tokens: SOFT },
      500_000,
      { cacheShare: 0.1, ts: NOW - 60_000 },
      NOW
    );
    expect(d).toEqual({ action: 'compact', reason: 'cold-over-soft' });
  });

  it('warm cache (97% served from cache) + over soft → NO compaction (leave the paid cache alone)', () => {
    const d = decideCompaction(
      { enabled: true, soft_tokens: SOFT },
      500_000,
      { cacheShare: 0.97, ts: NOW - 60_000 },
      NOW
    );
    expect(d).toEqual({ action: 'none' });
  });

  it('over hard compacts REGARDLESS of cache state (even a warm cache)', () => {
    const d = decideCompaction(
      { enabled: true, soft_tokens: SOFT, hard_tokens: HARD },
      900_000,
      { cacheShare: 0.97, ts: NOW - 60_000 },
      NOW
    );
    expect(d).toEqual({ action: 'compact', reason: 'over-hard' });
  });

  it('disabled config produces the HINT instead of compacting (both trigger kinds)', () => {
    const coldSoft = decideCompaction(
      { enabled: false, soft_tokens: SOFT },
      500_000,
      { cacheShare: 0.1, ts: NOW - 60_000 },
      NOW
    );
    expect(coldSoft).toEqual({ action: 'hint', reason: 'cold-over-soft' });
    const overHard = decideCompaction(
      { enabled: false, soft_tokens: SOFT, hard_tokens: HARD },
      900_000,
      { cacheShare: 0.97, ts: NOW - 60_000 },
      NOW
    );
    expect(overHard).toEqual({ action: 'hint', reason: 'over-hard' });
  });

  it('absent context_budget / no thresholds → none (default off: measurement only, no hints)', () => {
    expect(decideCompaction(undefined, 900_000, { cacheShare: 0.1, ts: NOW - 60_000 }, NOW)).toEqual({ action: 'none' });
    expect(decideCompaction({ enabled: true }, 900_000, { cacheShare: 0.1, ts: NOW - 60_000 }, NOW)).toEqual({ action: 'none' });
    expect(decideCompaction({ enabled: false, soft_tokens: SOFT }, 200_000, { cacheShare: 0.1, ts: NOW - 60_000 }, NOW)).toEqual({ action: 'none' });
  });

  it('unknown context tokens (right after compaction) → none', () => {
    const d = decideCompaction({ enabled: true, soft_tokens: SOFT }, null, { cacheShare: 0.1, ts: NOW - 60_000 }, NOW);
    expect(d).toEqual({ action: 'none' });
  });

  it('idle gap > cache_ttl_s makes the cache cold; a fresh step does not', () => {
    const budget = { enabled: true, soft_tokens: SOFT, cache_ttl_s: 300 };
    const idle = decideCompaction(budget, 500_000, { cacheShare: 0.97, ts: NOW - 400_000 }, NOW);
    expect(idle).toEqual({ action: 'compact', reason: 'cold-over-soft' });
    const fresh = decideCompaction(budget, 500_000, { cacheShare: 0.97, ts: NOW - 60_000 }, NOW);
    expect(fresh).toEqual({ action: 'none' });
  });

  it('no recorded step yet (fresh/resumed session) counts as cold — nothing was paid into a cache', () => {
    const d = decideCompaction({ enabled: true, soft_tokens: SOFT }, 500_000, { cacheShare: null, ts: null }, NOW);
    expect(d).toEqual({ action: 'compact', reason: 'cold-over-soft' });
  });

  it('a recent step with unknown cache share is NOT cold (conservative: no cache info, no idle gap)', () => {
    const d = decideCompaction({ enabled: true, soft_tokens: SOFT }, 500_000, { cacheShare: null, ts: NOW - 60_000 }, NOW);
    expect(d).toEqual({ action: 'none' });
  });

  it('isCacheCold: a cache share below the miss threshold is a miss', () => {
    expect(CACHE_MISS_SHARE_THRESHOLD).toBeGreaterThan(0);
    expect(CACHE_MISS_SHARE_THRESHOLD).toBeLessThan(1);
    expect(isCacheCold({}, { cacheShare: CACHE_MISS_SHARE_THRESHOLD - 0.01, ts: NOW }, NOW)).toBe(true);
    expect(isCacheCold({}, { cacheShare: CACHE_MISS_SHARE_THRESHOLD, ts: NOW }, NOW)).toBe(false);
  });
});

// ── lastStepCacheState (usage_log adapter) ──────────────────────────────────

describe('lastStepCacheState', () => {
  it('derives the cache share and ts from the LAST usage_log entry', () => {
    const log: UsageLogEntry[] = [
      { ref: 'a/x', tokens: 100, cacheRead: 90, ts: NOW - 10_000 },
      { ref: 'a/x', tokens: 1000, cacheRead: 970, ts: NOW - 1000 },
    ];
    expect(lastStepCacheState(log)).toEqual({ cacheShare: 0.97, ts: NOW - 1000 });
  });

  it('an entry without cacheRead counts as a full miss (share 0)', () => {
    expect(lastStepCacheState([{ ref: 'a/x', tokens: 100, ts: NOW }])).toEqual({ cacheShare: 0, ts: NOW });
  });

  it('an empty log is the "no step yet" state', () => {
    expect(lastStepCacheState(undefined)).toEqual({ cacheShare: null, ts: null });
    expect(lastStepCacheState([])).toEqual({ cacheShare: null, ts: null });
  });
});

// ── resolveContextBudget (per-group wins over global) ───────────────────────

describe('resolveContextBudget', () => {
  const cfg: Config = {
    model_groups: {
      tactical: { method: 'best', context_budget: { soft_tokens: 200_000 } },
      strategic: { method: 'best' },
    },
    model_metrics: {},
    context_budget: { enabled: true, soft_tokens: SOFT, hard_tokens: HARD, cache_ttl_s: 300 },
  } as any as Config;

  it('no group → the global budget', () => {
    expect(resolveContextBudget(cfg, null)).toEqual(cfg.context_budget);
  });

  it('a group without its own context_budget inherits the global one', () => {
    expect(resolveContextBudget(cfg, 'strategic')).toEqual(cfg.context_budget);
  });

  it('per-group fields WIN over the global ones; absent group fields fall back', () => {
    expect(resolveContextBudget(cfg, 'tactical')).toEqual({
      enabled: true,
      soft_tokens: 200_000,
      hard_tokens: HARD,
      cache_ttl_s: 300,
    });
  });

  it('no context_budget anywhere → undefined (feature off)', () => {
    const bare = { model_groups: { tactical: { method: 'best' } }, model_metrics: {} } as any as Config;
    expect(resolveContextBudget(bare, 'tactical')).toBeUndefined();
  });
});

// ── runContextCompaction (acting on the decision) ───────────────────────────

describe('runContextCompaction', () => {
  const cfg = (budget: Config['context_budget']) =>
    ({ model_groups: {}, model_metrics: {}, context_budget: budget } as any as Config);

  it('compact decision calls ctx.compact() (fire and forget)', () => {
    const { ctx, compact } = fakeCtx(ctxFixture({ tokens: 500_000 }));
    runContextCompaction({
      ctx, cfg: cfg({ enabled: true, soft_tokens: SOFT }),
      activeGroup: null,
      usageLog: [{ ref: 'a/x', tokens: 1000, cacheRead: 10, ts: Date.now() - 60_000 }],
      state: { lastHintAt: 0 },
    });
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('warm-cache-over-soft leaves the session alone', () => {
    const { ctx, compact, notify } = fakeCtx(ctxFixture({ tokens: 500_000 }));
    runContextCompaction({
      ctx, cfg: cfg({ enabled: true, soft_tokens: SOFT }),
      activeGroup: null,
      usageLog: [{ ref: 'a/x', tokens: 1000, cacheRead: 990, ts: Date.now() - 60_000 }],
      state: { lastHintAt: 0 },
    });
    expect(compact).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('hint decision notifies the user instead of compacting, with a cooldown', () => {
    const { ctx, compact, notify } = fakeCtx(ctxFixture({ tokens: 500_000 }));
    const state: CompactionRunState = { lastHintAt: 0 };
    const call = () =>
      runContextCompaction({
        ctx, cfg: cfg({ enabled: false, soft_tokens: SOFT }),
        activeGroup: null,
        usageLog: [{ ref: 'a/x', tokens: 1000, cacheRead: 10, ts: Date.now() - 60_000 }],
        state,
      });
    call();
    expect(compact).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][0])).toContain('/compact');
    // The next turn boundary within the cooldown does not nag again.
    call();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('no configured thresholds → no compact, no hint (default off)', () => {
    const { ctx, compact, notify } = fakeCtx(ctxFixture({ tokens: 500_000 }));
    runContextCompaction({
      ctx, cfg: cfg(undefined),
      activeGroup: null,
      usageLog: [{ ref: 'a/x', tokens: 1000, cacheRead: 10, ts: Date.now() - 60_000 }],
      state: { lastHintAt: 0 },
    });
    expect(compact).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('getContextUsage returning nothing (right after a compaction) is a no-op', () => {
    const { ctx, compact } = fakeCtx(ctxFixture({ tokens: null }));
    runContextCompaction({
      ctx, cfg: cfg({ enabled: true, soft_tokens: SOFT }),
      activeGroup: null,
      usageLog: [{ ref: 'a/x', tokens: 1000, cacheRead: 10, ts: Date.now() - 60_000 }],
      state: { lastHintAt: 0 },
    });
    expect(compact).not.toHaveBeenCalled();
  });
});

// ── Wiring: the real turn_start handler drives the compaction ────────────────

describe('turn_start wiring (Phase 5b)', () => {
  function harness(cfg: Config, usageLog: UsageLogEntry[]) {
    const handlers: Record<string, ((...a: any[]) => any)[]> = {};
    const compact = vi.fn();
    const notify = vi.fn();
    const rt: any = {
      pi: { on: (name: string, fn: any) => ((handlers[name] ??= []).push(fn)) },
      cache: { usage_log: usageLog },
      cfg,
      activeGroup: null,
      curModel: 'standard/standard',
      turnStart: 0,
      escalation: new SessionEscalation(),
      router: { noteTurnStart: vi.fn(), getCurModel: () => 'a/x', getTurnDriverRef: () => '' },
      updateMetrics: vi.fn(),
      recordOk: vi.fn(),
      saveCache: vi.fn(),
    };
    createEventHandlers(rt);
    const sessionCtx = {
      getContextUsage: () => ({ tokens: 500_000, contextWindow: 1_000_000, percent: 50 }),
      compact,
      ui: { notify },
      model: undefined,
    };
    return { rt, handlers, compact, notify, sessionCtx };
  }

  const enabledCfg = {
    model_groups: {},
    model_metrics: {},
    context_budget: { enabled: true, soft_tokens: SOFT },
  } as any as Config;
  const coldLog: UsageLogEntry[] = [{ ref: 'a/x', tokens: 1000, cacheRead: 10, ts: Date.now() - 60_000 }];
  const warmLog: UsageLogEntry[] = [{ ref: 'a/x', tokens: 1000, cacheRead: 990, ts: Date.now() - 60_000 }];

  it('cold + over-soft: turn_start triggers ctx.compact() at the turn boundary', async () => {
    const h = harness(enabledCfg, coldLog);
    await h.handlers['turn_start'][0]({}, h.sessionCtx);
    expect(h.compact).toHaveBeenCalledTimes(1);
  });

  it('warm cache + over-soft: turn_start does NOT compact', async () => {
    const h = harness(enabledCfg, warmLog);
    await h.handlers['turn_start'][0]({}, h.sessionCtx);
    expect(h.compact).not.toHaveBeenCalled();
  });

  it('disabled config: turn_start notifies the hint instead', async () => {
    const disabledCfg = {
      model_groups: {},
      model_metrics: {},
      context_budget: { enabled: false, soft_tokens: SOFT },
    } as any as Config;
    const h = harness(disabledCfg, coldLog);
    await h.handlers['turn_start'][0]({}, h.sessionCtx);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(String(h.notify.mock.calls[0][0])).toContain('/compact');
  });

  it('compaction NEVER fires mid-turn: tool_call, tool_result and turn_end leave it alone', async () => {
    const h = harness(enabledCfg, coldLog);
    h.rt.turnStart = Date.now() - 1000;
    h.rt.curModel = 'a/x';
    // tool_call: the read block may answer, but never compacts.
    await h.handlers['tool_call'][0]({ name: 'read', input: { path: 'x' } }, h.sessionCtx);
    // tool_result: delegation may replace results, but never compacts.
    await h.handlers['tool_result'][0]({ tool: 'read', content: [] }, h.sessionCtx);
    // turn_end: metrics/logging, but never compacts.
    await h.handlers['turn_end'][0](
      { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 1, cost: { total: 0 } } } },
      h.sessionCtx
    );
    expect(h.compact).not.toHaveBeenCalled();
    // Sanity: the boundary itself still compacts under the same conditions.
    await h.handlers['turn_start'][0]({}, h.sessionCtx);
    expect(h.compact).toHaveBeenCalledTimes(1);
  });

  it('per-group override wins at the wiring level: group off disables a globally-on budget', async () => {
    const cfg = {
      model_groups: { tactical: { method: 'best', context_budget: { enabled: false } } },
      model_metrics: {},
      context_budget: { enabled: true, soft_tokens: SOFT },
    } as any as Config;
    const h = harness(cfg, coldLog);
    h.rt.activeGroup = 'tactical';
    await h.handlers['turn_start'][0]({}, h.sessionCtx);
    expect(h.compact).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledTimes(1); // hint, not compact
    // And a globally-off budget with a group override ON compacts.
    const cfg2 = {
      model_groups: { tactical: { method: 'best', context_budget: { enabled: true, soft_tokens: SOFT } } },
      model_metrics: {},
      context_budget: { enabled: false },
    } as any as Config;
    const h2 = harness(cfg2, coldLog);
    h2.rt.activeGroup = 'tactical';
    await h2.handlers['turn_start'][0]({}, h2.sessionCtx);
    expect(h2.compact).toHaveBeenCalledTimes(1);
  });
});
