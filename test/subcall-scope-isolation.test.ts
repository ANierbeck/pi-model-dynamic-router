// A nested sub-call must not become the turn's model — and ONLY the sub-call
// is affected.
//
// PR #86 fixed the live incident of 2026-11-03 (a bulk_reader delegation
// overwrote lastDynamicModel, the next tool follow-up step then started on the
// free summarizer) with a depth counter on the Router instance. Two defects of
// that design, found in the review after the merge:
//
//  1. load() replaces the Router instance (every session_start, including
//     subagent sessions that share the module while a parent turn runs; and the
//     dynamic-config swap after a scan). Only the pinned driver ref is carried
//     over, so the in-flight scope was lost and the sub-call's stream recorded
//     the summarizer as the turn's model again.
//  2. The counter is process-global: a legitimate MAIN stream that overlaps a
//     sub-call (a subagent session in the same process) was suppressed, leaving
//     lastDynamicModel/curModel stale.
//
// The scope is now tied to the sub-call's own async call chain
// (AsyncLocalStorage), so neither defect can occur. These tests drive the REAL
// StreamOrchestrator.driveStream and the REAL handlers — nothing here
// re-implements the guard.

import { describe, it, expect, vi } from 'vitest';
import { Router } from '../src/routing.ts';
import { runAsSubCall } from '../src/subcall-scope.ts';
import { StreamOrchestrator } from '../src/stream-orchestrator.ts';
import { createEventHandlers } from '../src/event-handlers.ts';
import { createTools } from '../src/tools.ts';
import { SessionEscalation } from '../src/escalation.ts';
import type { Config } from '../src/types.ts';

const TURN_MODEL = 'mistral/zai-glm-5-3';
const BULK_MODEL = 'openrouter/google/gemma-4-31b-it:free';
const MAIN_MODEL = 'claude-bridge/claude-sonnet-5-5';

const makeRouter = (): Router =>
  new Router({ model_groups: {}, model_metrics: {} } as unknown as Config, {} as any, new Map());

/** One process: a live (swappable) router, one orchestrator, the turn's model. */
function world(overrides: Record<string, unknown> = {}) {
  const holder = { router: makeRouter() };
  const ctx: any = {
    cfg: { model_groups: {}, model_metrics: {}, delegation: { enabled: true } },
    cache: { usage_log: [] },
    activeGroup: 'simple',
    lastDynamicModel: TURN_MODEL,
    estimateContextTokens: () => 100,
    isLimited: () => false,
    isBreakerOpen: () => false,
    getModelContextWindow: () => 200_000,
    tryStream: async () => ({ stream: {} }),
    consumeWithDetection: async () => ({ ok: true }),
    recordOk: () => {},
    releaseLocalSlot: () => {},
    recordStreamFailure: () => {},
    observeFailure: () => {},
    getEmptyResponseTimeout: () => 1_000,
    getStallTimeout: () => 1_000,
    getRateLimitWaitMaxMs: () => 0,
    formatResetMsg: () => '',
    noteBreakerSkip: () => {},
    observeProviderFailure: () => false,
    skipReasons: new Map(),
    ...overrides,
  };
  Object.defineProperty(ctx, 'router', { get: () => holder.router });
  const orch = new StreamOrchestrator(ctx);
  const proxy: any = { push: vi.fn() };
  const drive = (ref: string) =>
    orch.driveStream(proxy, [ref], { messages: [] } as any, undefined, undefined, 'simple');
  return { holder, ctx, drive };
}

/** The sub-call's stream: opens a REAL router stream, then yields a summary. */
function subCallStream(w: ReturnType<typeof world>, before?: () => Promise<void> | void) {
  return vi.fn(async function* () {
    await before?.();
    await w.drive(BULK_MODEL);
    yield { type: 'text_delta', delta: 'a summary of the result, long enough to be used as a replacement' };
    yield { type: 'message_end', usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } } };
  });
}

const bigBash = () => ({
  toolName: 'bash',
  input: { command: 'python3 analyze.py' },
  content: [{ type: 'text', text: 'x'.repeat(4137) }],
  isError: false,
});

function delegation(w: ReturnType<typeof world>, streamSimple: ReturnType<typeof subCallStream>) {
  const handlers: Record<string, ((...a: any[]) => any)[]> = {};
  const rt: any = {
    pi: { on: (name: string, fn: any) => ((handlers[name] ??= []).push(fn)) },
    cache: w.ctx.cache,
    cfg: w.ctx.cfg as Config,
    activeGroup: null,
    curModel: 'dynamic/dynamic',
    turnStart: 0,
    escalation: new SessionEscalation(),
    updateMetrics: vi.fn(),
    recordOk: vi.fn(),
    saveCache: vi.fn(),
  };
  Object.defineProperty(rt, 'router', { get: () => w.holder.router });
  Object.defineProperty(rt, 'lastDynamicModel', { get: () => w.ctx.lastDynamicModel });
  createEventHandlers(rt);
  const ctx = {
    modelRegistry: { find: vi.fn(() => ({ provider: 'bulk_reader', id: 'bulk_reader' })), runtime: { streamSimple } },
    signal: undefined,
  };
  const run = async () => {
    let out: any;
    for (const h of handlers['tool_result'] ?? []) out = (await h(bigBash(), ctx)) ?? out;
    return out;
  };
  return { run };
}

describe('baseline', () => {
  it('a normal stream records the served ref (the sub-call guard must not disable this)', async () => {
    const w = world();
    await w.drive(MAIN_MODEL);
    expect(w.ctx.lastDynamicModel).toBe(MAIN_MODEL);
    expect(w.holder.router.getCurModel()).toBe(MAIN_MODEL);
  });
});

describe('tool_result delegation', () => {
  it('the sub-call stream does not become the turn model, and curModel stays untouched', async () => {
    const w = world();
    const out = await delegation(w, subCallStream(w)).run();

    expect(out?.content?.[0]?.text).toContain('[delegated summary');
    expect(w.ctx.lastDynamicModel).toBe(TURN_MODEL);
    expect(w.holder.router.getCurModel()).toBe('');
  });

  it('survives a Router replacement while the sub-call is in flight (load() on session_start)', async () => {
    const w = world();
    const stream = subCallStream(w, () => {
      w.holder.router = makeRouter(); // what load() does; only the driver ref is carried over
    });
    await delegation(w, stream).run();

    expect(w.ctx.lastDynamicModel).toBe(TURN_MODEL);
    expect(w.holder.router.getCurModel()).toBe('');
  });

  it('does not suppress a MAIN stream that overlaps the sub-call (subagent session in the same process)', async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pending = delegation(w, subCallStream(w, () => gate)).run();

    await w.drive(MAIN_MODEL); // a different session's stream, started OUTSIDE the sub-call
    expect(w.ctx.lastDynamicModel).toBe(MAIN_MODEL);
    expect(w.holder.router.getCurModel()).toBe(MAIN_MODEL);

    release();
    await pending;
    expect(w.ctx.lastDynamicModel).toBe(MAIN_MODEL); // the sub-call did not clobber it either
  });

  it('the scope does not leak: after a failing sub-call the next stream records again', async () => {
    const w = world();
    const failing = vi.fn(async function* () {
      throw new Error('429 rate-limited upstream');
    } as any) as any;
    await delegation(w, failing).run();

    await w.drive(MAIN_MODEL);
    expect(w.ctx.lastDynamicModel).toBe(MAIN_MODEL);
  });
});

describe('bulk_read tool', () => {
  it('its reader stream does not become the turn model', async () => {
    const w = world();
    const registered: Record<string, any> = {};
    const rt: any = {
      pi: { registerTool: (def: any) => (registered[def.name] = def), setModel: vi.fn() },
      cfg: w.ctx.cfg as Config,
      cfgPath: '/tmp/router-config.json',
      activeGroup: null,
      getM: () => ({}) as any,
      resolve: () => null,
      fmtModel: () => '',
      load: () => {},
    };
    Object.defineProperty(rt, 'router', { get: () => w.holder.router });
    createTools(rt);

    const ctx: any = {
      modelRegistry: {
        find: vi.fn(() => ({ provider: 'bulk_reader', id: 'bulk_reader' })),
        runtime: { streamSimple: subCallStream(w) },
      },
      cwd: process.cwd(),
      signal: undefined,
    };
    await registered['bulk_read'].execute('id', { question: 'what?', paths: ['package.json'] }, undefined, undefined, ctx);

    expect(w.ctx.lastDynamicModel).toBe(TURN_MODEL);
    expect(w.holder.router.getCurModel()).toBe('');
  });
});

// The cascade has two more places that open a stream and used to write the
// turn state unguarded (found in the post-merge review): the total-cooldown
// collapse and the breaker dead-end probe. A free reader model hits both after
// one daily-cap 429 (limitFreeDayCap cools down every :free ref).
describe('degraded cascade paths inside a sub-call', () => {
  it('total cooldown collapse: the force-retried reader ref does not become the turn model', async () => {
    const w = world({ isLimited: () => true });
    await runAsSubCall(() => w.drive(BULK_MODEL));

    expect(w.ctx.lastDynamicModel).toBe(TURN_MODEL);
    expect(w.holder.router.getCurModel()).toBe('');
    expect(w.holder.router.getTurnDriverRef()).toBe('');
  });

  it('breaker dead-end: the half-open probe ref does not become the turn model', async () => {
    const w = world({
      isBreakerOpen: () => true,
      cache: { usage_log: [], provider_breaker: { openrouter: { open_until: Date.now() + 60_000, trip_count: 1, evidence: [] } } },
    });
    await runAsSubCall(() => w.drive(BULK_MODEL));

    expect(w.ctx.lastDynamicModel).toBe(TURN_MODEL);
    expect(w.holder.router.getCurModel()).toBe('');
    expect(w.holder.router.getTurnDriverRef()).toBe('');
  });

  it('the same degraded paths DO record for a normal (non-sub-call) stream', async () => {
    const w = world({ isLimited: () => true });
    await w.drive(BULK_MODEL);
    expect(w.ctx.lastDynamicModel).toBe(BULK_MODEL);
  });
});

// A user can point delegation.group at a dynamic group. The classifier then
// runs on the summarizer prompt and used to write lastClassifiedCategory and
// lastDynamicModel (the model that "continue" and the tool follow-up inherit)
// from inside the sub-call.
describe('dynamic group used as a delegation group', () => {
  function dynamicWorld() {
    const ctx: any = {
      cfg: { model_groups: { dynamic: { method: 'dynamic' }, standard: { method: 'best' } }, model_metrics: {} },
      cache: {},
      router: {},
      lastDynamicModel: TURN_MODEL,
      lastClassifiedCategory: 'planning',
      escalation: { level: 'standard' },
      sessionCtx: undefined,
      resolve: (name: string) => (name === 'standard' ? { candidates: [BULK_MODEL], selected: BULK_MODEL } : null),
      extractLastUserPrompt: () => 'summarize this',
      extractLastAssistantSnippet: () => undefined,
      detectHintDirectly: () => null,
      isCompactionTurn: () => false,
      isLimited: () => false,
      getGroupForCategory: () => 'standard',
      classifyPrompt: async () => ({ category: 'standard' }),
    };
    const orch = new StreamOrchestrator(ctx);
    const drive = vi.spyOn(orch, 'driveStream').mockResolvedValue(undefined as never);
    const open = () =>
      orch.groupStream(
        { provider: 'router', id: 'dynamic', api: 'openai-completions' } as any,
        { messages: [{ role: 'user', content: 'summarize this', timestamp: 1 }] } as any,
        undefined,
      );
    return { ctx, drive, open };
  }

  it('inside a sub-call: neither the category nor the turn model is overwritten', async () => {
    const d = dynamicWorld();
    await runAsSubCall(async () => {
      d.open();
      await vi.waitFor(() => expect(d.drive).toHaveBeenCalledTimes(1));
    });
    expect(d.ctx.lastDynamicModel).toBe(TURN_MODEL);
    expect(d.ctx.lastClassifiedCategory).toBe('planning');
  });

  it('outside a sub-call the same group records both (baseline)', async () => {
    const d = dynamicWorld();
    d.open();
    await vi.waitFor(() => expect(d.drive).toHaveBeenCalledTimes(1));
    expect(d.ctx.lastDynamicModel).toBe(BULK_MODEL);
    expect(d.ctx.lastClassifiedCategory).toBe('standard');
  });
});
