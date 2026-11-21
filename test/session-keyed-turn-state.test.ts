// test/session-keyed-turn-state.test.ts
// docs/plans/2026-11-07-session-keyed-turn-state.md (TODO "I2 remainder / M1").
//
// The router's turn state (curModel, activeGroup, lastDynamicModel,
// lastClassifiedCategory, turnStart) lived in closure variables of the extension
// factory: one copy per PROCESS. pi-subagents runs child sessions in-process, so
// a child shared — and overwrote — the parent's turn state; clearing it on the
// child's session_shutdown would have wiped the parent's. These tests drive ONE
// extension instance with two session ids and pin that each session sees only
// its own state.
//
// The observable: a tool follow-up (last message is a toolResult) reuses
// lastDynamicModel and skips classification. A session that never served a
// stream has no lastDynamicModel, so its toolResult request must be classified.

import { describe, it, expect, vi } from 'vitest';
import {
  fakeSessionManager,
  makeExtensionContext,
  startSession,
} from './helpers/extension-harness.ts';
import { doneEvent, paidCloudModel } from './helpers/stream-fixtures.ts';
import { withRouterEnv } from './helpers/router-env.ts';

// The observable is whether classification ran, so classifyPrompt is wrapped in a
// counting spy (the real one runs; the network is off, so it falls back fast).
vi.mock('../src/content-classifier.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/content-classifier.ts')>();
  return { ...actual, classifyPrompt: vi.fn(actual.classifyPrompt) };
});

const CONFIG = {
  free_models: [],
  providers: {},
  model_groups: {
    dynamic: { method: 'dynamic' },
    standard: { fallback_groups: [], min_gdpval: 0 },
  },
  gdpval_builtin: { 'paid-model': 1000, 'other-model': 900 },
};

/** Per-session ctxs with a STABLE manager per id (a /resume reopens the SAME file). */
const sessionManagers = new Map<string, any>();
const session = (id: string): any => {
  let s = sessionManagers.get(id);
  if (!s) {
    const mgr = fakeSessionManager();
    mgr.getSessionId = () => id;
    s = { sessionManager: mgr, ui: { setStatus: vi.fn(), setFooter: vi.fn() } };
    sessionManagers.set(id, s);
  }
  return s;
};

const followUpContext = (): any => ({
  messages: [
    { role: 'user', content: 'please read the file and fix it' },
    { role: 'assistant', content: [{ type: 'text', text: 'reading' }] },
    { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'file body' }] },
  ],
});

async function boot(
  fn: (h: {
    defaultExport: any;
    onHandlers: Record<string, any>;
    modelRegistry: any;
    classifierCalls: () => number;
    pi: any;
  }) => Promise<void>
): Promise<void> {
  const classifier = await import('../src/content-classifier.ts');
  await withRouterEnv(
    async (defaultExport, tmpDir) => {
      vi.mocked(classifier.classifyPrompt).mockClear();
      const { ctx: pi, onHandlers } = makeExtensionContext();
      defaultExport(pi);
      const paidModel = paidCloudModel();
      const otherModel = paidCloudModel({ id: 'other-model' });
      // Session 'child' cannot use paid-model (429), so it lands on other-model
      // while 'parent' stays on paid-model: the two sessions' turn models differ.
      const streamSimple = vi.fn((model: any, _ctx: any, options: any) =>
        (async function* () {
          if (options?.sessionId === 'child' && model.id === 'paid-model') {
            yield {
              type: 'error',
              reason: 'error',
              error: {
                role: 'assistant',
                content: [],
                errorMessage: '429 rate limit exceeded',
                stopReason: 'error',
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
              },
            };
            return;
          }
          yield { type: 'text_delta', delta: 'reply' };
          yield doneEvent();
        })()
      );
      const modelRegistry = {
        getAvailable: () => [paidModel, otherModel],
        find: (_provider: string, id: string) => (id === 'other-model' ? otherModel : paidModel),
        getApiKeyForProvider: async () => null,
        runtime: { streamSimple },
      };
      await startSession(onHandlers, { modelRegistry, cwd: tmpDir });
      await fn({
        defaultExport,
        onHandlers,
        modelRegistry,
        classifierCalls: () => vi.mocked(classifier.classifyPrompt).mock.calls.length,
        cwd: tmpDir,
        pi,
      });
    },
    { config: CONFIG, disableNetwork: true }
  );
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const ev of stream) void ev;
}

/** Session `id` serves one turn through the static `standard` group (sets lastDynamicModel). */
async function serveTurn(defaultExport: any, id: string): Promise<void> {
  await drain(
    defaultExport.groupStream(
      { provider: 'standard', id: 'standard' },
      { messages: [{ role: 'user', content: 'hello' }] },
      { sessionId: id }
    )
  );
}

/** A tool follow-up request on the dynamic group; returns how often the classifier ran. */
async function followUp(
  h: { defaultExport: any; classifierCalls: () => number },
  id: string
): Promise<number> {
  const before = h.classifierCalls();
  await drain(
    h.defaultExport.groupStream({ provider: 'dynamic', id: 'dynamic' }, followUpContext(), {
      sessionId: id,
    })
  );
  return h.classifierCalls() - before;
}

describe('turn state is keyed by session, not by process', () => {
  it('a session that never served a stream does not inherit another session’s turn model', async () => {
    await boot(async (h) => {
      await serveTurn(h.defaultExport, 'parent');
      // Same process, other session: no lastDynamicModel of its own, so this is
      // NOT a tool follow-up and must go through classification.
      expect(await followUp(h, 'child')).toBeGreaterThan(0);
    });
  }, 30000);

  it('the session that served the stream keeps its follow-up path (no classification)', async () => {
    await boot(async (h) => {
      await serveTurn(h.defaultExport, 'parent');
      expect(await followUp(h, 'parent')).toBe(0);
    });
  }, 30000);

  it('another session serving a stream does not replace this session’s turn model', async () => {
    await boot(async (h) => {
      await serveTurn(h.defaultExport, 'parent');
      await serveTurn(h.defaultExport, 'child');
      // Both own a turn model now; each follows up without classifying.
      expect(await followUp(h, 'parent')).toBe(0);
      expect(await followUp(h, 'child')).toBe(0);
    });
  }, 30000);

  it('a child’s session_shutdown clears only the child’s state', async () => {
    await boot(async (h) => {
      await serveTurn(h.defaultExport, 'parent');
      await serveTurn(h.defaultExport, 'child');
      await h.onHandlers['session_shutdown']?.({}, session('child'));
      // The parent's turn model survives the child's shutdown...
      expect(await followUp(h, 'parent')).toBe(0);
      // ...and the child's is gone: its follow-up is classified again.
      expect(await followUp(h, 'child')).toBeGreaterThan(0);
    });
  }, 30000);

  // Review 2026-11-21 (Minor 3): a pin set in a session that ends before its
  // next request must not wait in the handoff for a reused session id.
  it('a session’s pending pin goes with its session_shutdown', async () => {
    await boot(async (h) => {
      const virtual = { provider: 'router', id: 'dynamic', api: 'pi-virtual' };
      const tool = h.pi.registerTool.mock.calls.find(
        (c: any[]) => c[0]?.name === 'set_model_from_group'
      )[0];
      await tool.execute('t', { group: 'standard' }, undefined, undefined, {
        ...session('child'),
        model: virtual,
        modelRegistry: h.modelRegistry,
      });
      await h.onHandlers['session_shutdown']?.({}, session('child'));
      const def = h.pi.registerVirtualModel.mock.calls[0][0];
      const routed = await def.route(
        { reason: 'user', messages: [], thinkingLevel: 'off', model: virtual },
        { modelRegistry: h.modelRegistry, ...session('child') }
      );
      expect(routed.state).toBeUndefined();
    });
  }, 30000);
});

// ── the footer, the category, and sub-calls ─────────────────────────────────

const theme = { fg: (_color: string, text: string): string => text };

/**
 * Starts session `id` with a real footer and returns its render function.
 * Pi's TUI renders from its own callbacks (key input, agent events, a 30 s
 * timer), so the footer is called OUTSIDE any router handler scope — it must
 * name the session it was built for, not whichever one the call stack carries.
 */
async function footerOf(
  h: { onHandlers: Record<string, any>; modelRegistry: any },
  id: string,
  statuses: ReadonlyMap<string, string> = new Map(),
  branch: unknown[] = [],
  model: { provider: string; id: string } = { provider: 'standard', id: 'standard' }
): Promise<() => string> {
  let render: (() => string) | undefined;
  const ctx: any = {
    cwd: process.cwd(),
    model,
    modelRegistry: h.modelRegistry,
    sessionManager: { getSessionId: () => id, getBranch: () => branch },
    getContextUsage: () => null,
    ui: {
      setFooter: (factory: any) => {
        const footer = factory({ requestRender: () => {} }, theme, {
          onBranchChange: () => () => {},
          getGitBranch: () => '',
          getExtensionStatuses: () => statuses,
        });
        render = () => footer.render(400).join('');
      },
    },
  };
  await h.onHandlers['session_start']?.({}, ctx);
  expect(render, 'session_start installs the footer').toBeDefined();
  return render!;
}

describe('footer, category and sub-calls follow the session', () => {
  // Pi 1.6 records each cache warm as a `usage` entry (kind cache_warm). Pi's
  // built-in footer adds those to the session totals; ours replaces it, so it
  // must too (docs/plans/2026-11-20-honor-pi-cache-warming.md, O1). The
  // per-step average stays a per-STEP figure: a warm is not a step.
  it('session totals include Pi’s cache-warm usage, the per-step average does not', async () => {
    await boot(async (h) => {
      const usage = (input: number, output: number, cacheRead: number, total: number): any => ({
        input,
        output,
        cacheRead,
        cacheWrite: 0,
        totalTokens: input + output + cacheRead,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
      });
      const branch = [
        { type: 'message', message: { role: 'assistant', usage: usage(1000, 100, 9000, 0.1) } },
        { type: 'usage', kind: 'cache_warm', usage: usage(0, 1, 10_000, 0.25) },
      ];
      const text = (await footerOf(h, 'parent', new Map(), branch))();
      expect(text).toContain('$0.35');
      expect(text).toContain('~$0.10/step');
    });
  }, 30000);

  // Pi's built-in footer is the only renderer of ctx.ui.setStatus texts; our
  // footer REPLACES it, so it must render them itself (footerData, the
  // documented setFooter contract). Red-first: written against the footer that
  // rendered only its own parts.
  it('renders the status texts other extensions set, on their own line, sorted by key', async () => {
    await boot(async (h) => {
      const footer = await footerOf(
        h,
        'parent',
        new Map([
          ['zeta-ext', 'zeta  ready'],
          ['pi-memory', 'memory\t3 notes'],
        ])
      );
      expect(footer()).toContain('memory 3 notes');
      expect(footer()).toContain('zeta ready');
      expect(footer().indexOf('memory 3 notes')).toBeLessThan(footer().indexOf('zeta ready'));
    });
  }, 30000);

  it('does not repeat the router’s own status key (its error count is already a footer part)', async () => {
    await boot(async (h) => {
      const footer = await footerOf(
        h,
        'parent',
        new Map([
          ['router', '⚠2 err'],
          ['pi-memory', 'memory 3 notes'],
        ])
      );
      expect(footer()).toContain('memory 3 notes');
      expect(footer()).not.toContain('⚠2 err');
    });
  }, 30000);

  it('each footer names its own session’s resolved model, rendered outside any scope', async () => {
    await boot(async (h) => {
      const parentFooter = await footerOf(h, 'parent');
      const childFooter = await footerOf(h, 'child');
      await serveTurn(h.defaultExport, 'parent'); // paid-model
      await serveTurn(h.defaultExport, 'child'); // paid-model is 429 for the child -> other-model
      expect(parentFooter()).toContain('paid-cloud-provider/paid-model');
      expect(parentFooter()).not.toContain('other-model');
      expect(childFooter()).toContain('paid-cloud-provider/other-model');
      expect(childFooter()).not.toContain('paid-cloud-provider/paid-model');
    });
  }, 30000);

  // Virtual-models migration step 2: ctx.model stays router/dynamic, so the
  // footer names the group route() last dispatched this session to and the
  // model it served (review 2026-11-21, Important 4).
  it('on router/dynamic the footer names the routed group and the served model', async () => {
    await boot(async (h) => {
      const virtual = { provider: 'router', id: 'dynamic', api: 'pi-virtual' };
      const footer = await footerOf(h, 'parent', new Map(), [], virtual);
      const def = h.pi.registerVirtualModel.mock.calls[0][0];
      await def.route(
        {
          reason: 'user',
          messages: [],
          thinkingLevel: 'off',
          model: virtual,
          state: { pin: 'standard' },
        },
        { modelRegistry: h.modelRegistry, sessionManager: { getSessionId: () => 'parent' } }
      );
      await serveTurn(h.defaultExport, 'parent');
      expect(footer()).toContain('standard/paid-cloud-provider/paid-model');
      expect(footer()).not.toContain('dynamic/');
    });
  }, 30000);

  // Re-review 2026-11-21 (Minor 1): after /tree the last served group
  // belongs to the branch left behind; the new branch's stored pin counts.
  it('after /tree the footer names the new branch’s stored group', async () => {
    await boot(async (h) => {
      const virtual = { provider: 'router', id: 'dynamic', api: 'pi-virtual' };
      const branch: unknown[] = [];
      const footer = await footerOf(h, 'parent', new Map(), branch, virtual);
      const def = h.pi.registerVirtualModel.mock.calls[0][0];
      await def.route(
        { reason: 'user', messages: [], thinkingLevel: 'off', model: virtual },
        { modelRegistry: h.modelRegistry, ...session('parent') }
      );
      expect(footer()).toContain('dynamic/');
      branch.push({
        type: 'custom',
        customType: 'pi.virtual-model-state',
        data: { provider: 'router', modelId: 'dynamic', state: { pin: 'standard' } },
      });
      await h.onHandlers['session_tree']?.({}, session('parent'));
      expect(footer()).toContain('standard/');
    });
  }, 30000);

  it('on router/dynamic before any request the footer names the classifying group', async () => {
    await boot(async (h) => {
      const virtual = { provider: 'router', id: 'dynamic', api: 'pi-virtual' };
      const footer = await footerOf(h, 'parent', new Map(), [], virtual);
      expect(footer()).toContain('dynamic/router/dynamic');
    });
  }, 30000);

  it('a sub-call inside a session leaves every session’s turn model alone', async () => {
    await boot(async (h) => {
      const parentFooter = await footerOf(h, 'parent');
      const childFooter = await footerOf(h, 'child');
      await serveTurn(h.defaultExport, 'parent');
      // The child serves ONLY a router sub-call (e.g. bulk_read): it must not
      // become the child's turn model, nor touch the parent's.
      // (imported here: withRouterEnv reset the module graph, so the extension's
      // sub-call scope is a different instance from a top-level import's)
      const { runAsSubCall } = await import('../src/subcall-scope.ts');
      await runAsSubCall(() => serveTurn(h.defaultExport, 'child'));
      expect(parentFooter()).toContain('paid-cloud-provider/paid-model');
      expect(childFooter()).not.toContain('paid-cloud-provider/other-model');
    });
  }, 30000);

  it('the classified category belongs to its session and survives its shutdown', async () => {
    await boot(async (h) => {
      const classifier = await import('../src/content-classifier.ts');
      const { currentSessionId } = await import('../src/turn-state.ts');
      // Which session asked, and what it inherited: recorded per classify call.
      const calls: Array<[string, unknown]> = [];
      const stub = async (prompt: string, opts: any): Promise<any> => {
        calls.push([currentSessionId() ?? '(none)', opts?.context?.lastCategory]);
        return { category: 'continue', reason: 'probe', confidence: 0.1 };
      };
      vi.mocked(classifier.classifyPrompt).mockImplementation(stub as any);
      const lastInherited = (): unknown => calls[calls.length - 1]?.[1];
      const dynamicTurn = async (id: string): Promise<void> =>
        drain(
          h.defaultExport.groupStream(
            { provider: 'dynamic', id: 'dynamic' },
            { messages: [{ role: 'user', content: 'refactor the parser module' }] },
            { sessionId: id }
          )
        );

      // Production semantics: parent and subagent child each fire their own
      // session_start — that is what keys the branch state per id.
      await h.onHandlers['session_start']?.(
        {},
        { ...session('parent'), modelRegistry: h.modelRegistry, cwd: h.cwd }
      );
      await h.onHandlers['session_start']?.(
        {},
        { ...session('child'), modelRegistry: h.modelRegistry, cwd: h.cwd }
      );

      await dynamicTurn('parent'); // classifies, category persisted on the parent's branch
      await dynamicTurn('child'); // the child's branch stores nothing of the parent's
      expect(lastInherited(), JSON.stringify(calls)).toBeUndefined();
      await dynamicTurn('parent'); // sees its own again
      expect(lastInherited(), JSON.stringify(calls)).toBeDefined();
      await h.onHandlers['session_shutdown']?.({}, session('parent'));
      // Resuming is a new session_start for the same id (pi reopens the
      // file): the category is still on the branch — a restart keeps it.
      await h.onHandlers['session_start']?.(
        {},
        { ...session('parent'), modelRegistry: h.modelRegistry, cwd: h.cwd }
      );
      await dynamicTurn('parent');
      expect(lastInherited(), JSON.stringify(calls)).toBeDefined();
    });
  }, 30000);
});
