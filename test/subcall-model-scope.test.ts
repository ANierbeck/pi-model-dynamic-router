// A nested sub-call must not become the turn's model.
//
// Live incident 2026-11-03 (session pi-model-router-fork/97208): a planning
// turn served by mistral/zai-glm-5-3 had one 4137-char bash result delegated
// to bulk_reader. The sub-call streams through the router's own
// groupStream → driveStream, which recorded the ref it served
// (openrouter/google/gemma-4-31b-it:free) as lastDynamicModel. The next tool
// follow-up step puts lastDynamicModel FIRST (stream-orchestrator
// isToolFollowUp), so the main turn continued on the free summarizer, hit two
// 429s, fell through the `simple` chain to openrouter/openrouter/free and
// stayed there — that model printed raw tool-call markup as text. Compaction
// continuity then used it as a model HINT for the owner's next prompt.
//
// Router.turnDriverRef already protected the turn's driving ref against the
// same nested overwrite (expensive-model read block); the model state that
// the follow-up step reads was not protected. The fix marks sub-calls
// explicitly (Router.enterSubCall/exitSubCall) and driveStream leaves the
// turn's model state alone while a sub-call is in flight. That also keeps
// turn_end's usage attribution on the turn's model (getCurModel) and makes a
// snapshot/restore unnecessary — a restore could clobber a newer model from a
// concurrent stream.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from '../src/routing.ts';
import { StreamOrchestrator } from '../src/stream-orchestrator.ts';
import { createEventHandlers } from '../src/event-handlers.ts';
import { createTools } from '../src/tools.ts';
import { SessionEscalation } from '../src/escalation.ts';
import type { Config } from '../src/types.ts';

const TURN_MODEL = 'mistral/zai-glm-5-3';
const BULK_MODEL = 'openrouter/google/gemma-4-31b-it:free';

function makeRouter(): Router {
  return new Router({ model_groups: {}, model_metrics: {} } as unknown as Config, {} as any, new Map());
}

// ── Router: the sub-call scope itself ─────────────────────────────────────

describe('Router sub-call scope', () => {
  it('is off by default, on between enter/exit, and never goes negative', () => {
    const r = makeRouter();
    expect(r.inSubCall).toBe(false);
    r.enterSubCall();
    expect(r.inSubCall).toBe(true);
    r.enterSubCall();
    r.exitSubCall();
    expect(r.inSubCall).toBe(true); // nesting counts
    r.exitSubCall();
    expect(r.inSubCall).toBe(false);
    r.exitSubCall(); // unbalanced exit must not wrap around
    expect(r.inSubCall).toBe(false);
  });
});

// ── driveStream: the turn's model state is sub-call-proof ─────────────────

function driveHarness() {
  const router = makeRouter();
  const ctx: any = {
    cfg: { model_groups: {}, model_metrics: {} },
    cache: {},
    router,
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
  };
  const orch = new StreamOrchestrator(ctx);
  const proxy: any = { push: vi.fn() };
  const drive = () =>
    orch.driveStream(proxy, [BULK_MODEL], { messages: [] } as any, undefined, undefined, 'simple');
  return { ctx, router, drive };
}

describe('driveStream leaves the turn model alone during a sub-call', () => {
  it('a normal stream records the served ref (baseline — the guard must not disable this)', async () => {
    const h = driveHarness();
    await h.drive();
    expect(h.ctx.lastDynamicModel).toBe(BULK_MODEL);
    expect(h.router.getCurModel()).toBe(BULK_MODEL);
  });

  it('a sub-call stream records nothing: neither lastDynamicModel nor curModel nor activeGroup', async () => {
    const h = driveHarness();
    h.router.enterSubCall();
    try {
      await h.drive();
    } finally {
      h.router.exitSubCall();
    }
    expect(h.ctx.lastDynamicModel).toBe(TURN_MODEL);
    expect(h.router.getCurModel()).toBe('');
    expect(h.router.getTurnDriverRef()).toBe('');
  });
});

// ── the two production sub-call sites ────────────────────────────────────

/** Mirrors driveStream's guard: only a non-sub-call stream records the ref. */
function fakeSubCallStream(rt: { lastDynamicModel: string }, router: Router, seen: boolean[]) {
  return vi.fn(async function* () {
    seen.push(router.inSubCall);
    if (!router.inSubCall) rt.lastDynamicModel = BULK_MODEL;
    yield { type: 'text_delta', delta: 'a summary of the result, long enough to be used as a replacement' };
    yield { type: 'message_end', usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } } };
  });
}

describe('tool_result delegation runs inside the sub-call scope', () => {
  function harness() {
    const handlers: Record<string, ((...a: any[]) => any)[]> = {};
    const router = makeRouter();
    const rt: any = {
      pi: { on: (name: string, fn: any) => ((handlers[name] ??= []).push(fn)) },
      cache: { usage_log: [] },
      cfg: { model_groups: {}, model_metrics: {}, delegation: { enabled: true } } as any as Config,
      activeGroup: null,
      curModel: 'dynamic/dynamic',
      lastDynamicModel: TURN_MODEL,
      turnStart: 0,
      escalation: new SessionEscalation(),
      router,
      updateMetrics: vi.fn(),
      recordOk: vi.fn(),
      saveCache: vi.fn(),
    };
    createEventHandlers(rt);
    const seen: boolean[] = [];
    const streamSimple = fakeSubCallStream(rt, router, seen);
    const ctx = {
      modelRegistry: { find: vi.fn(() => ({ provider: 'bulk_reader', id: 'bulk_reader' })), runtime: { streamSimple } },
      signal: undefined,
    };
    return { rt, handlers, ctx, streamSimple, seen };
  }

  const ev = () => ({
    toolName: 'bash',
    input: { command: 'python3 analyze.py' },
    content: [{ type: 'text', text: 'x'.repeat(4137) }],
    isError: false,
  });

  it('the sub-call runs scoped and the turn keeps its model', async () => {
    const { rt, handlers, ctx, streamSimple, seen } = harness();
    let out: any;
    for (const h of handlers['tool_result'] ?? []) out = (await h(ev(), ctx)) ?? out;

    expect(streamSimple).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([true]); // the scope really was active
    expect(out?.content?.[0]?.text).toContain('[delegated summary');
    expect(rt.lastDynamicModel).toBe(TURN_MODEL);
    expect(rt.router.inSubCall).toBe(false); // scope closed again
  });

  it('the scope closes when the sub-call throws (fail-open path)', async () => {
    const { rt, handlers, ctx, streamSimple } = harness();
    streamSimple.mockImplementation(async function* () {
      throw new Error('429 rate-limited upstream');
    } as any);
    for (const h of handlers['tool_result'] ?? []) await h(ev(), ctx);

    expect(rt.lastDynamicModel).toBe(TURN_MODEL);
    expect(rt.router.inSubCall).toBe(false);
  });
});

describe('the bulk_read tool runs inside the sub-call scope', () => {
  it('a reader stream inside bulk_read does not become the turn model', async () => {
    const router = makeRouter();
    const registered: Record<string, any> = {};
    const rt: any = {
      pi: { registerTool: (def: any) => (registered[def.name] = def), setModel: vi.fn() },
      cfg: { model_groups: {}, model_metrics: {}, delegation: { enabled: true } } as any as Config,
      cfgPath: '/tmp/router-config.json',
      activeGroup: null,
      router,
      getM: () => ({}) as any,
      resolve: () => null,
      fmtModel: () => '',
      load: () => {},
    };
    createTools(rt);

    const seen: boolean[] = [];
    const state = { lastDynamicModel: TURN_MODEL };
    const streamSimple = fakeSubCallStream(state, router, seen);
    const ctx: any = {
      modelRegistry: { find: vi.fn(() => ({ provider: 'bulk_reader', id: 'bulk_reader' })), runtime: { streamSimple } },
      cwd: process.cwd(),
      signal: undefined,
    };

    const tool = registered['bulk_read'];
    expect(tool).toBeDefined();
    await tool.execute('id', { question: 'what?', paths: ['package.json'] }, undefined, undefined, ctx);

    expect(seen).toEqual([true]);
    expect(state.lastDynamicModel).toBe(TURN_MODEL);
    expect(router.inSubCall).toBe(false);
  });
});

beforeEach(() => vi.clearAllMocks());
