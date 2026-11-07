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
import { makeExtensionContext, startSession } from './helpers/extension-harness.ts';
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

const session = (id: string): any => ({ sessionManager: { getSessionId: () => id } });

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
  id: string
): Promise<() => string> {
  let render: (() => string) | undefined;
  const ctx: any = {
    cwd: process.cwd(),
    model: { provider: 'standard', id: 'standard' },
    modelRegistry: h.modelRegistry,
    sessionManager: { getSessionId: () => id, getBranch: () => [] },
    getContextUsage: () => null,
    ui: {
      setFooter: (factory: any) => {
        const footer = factory({ requestRender: () => {} }, theme, {
          onBranchChange: () => () => {},
          getGitBranch: () => '',
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

  it('the classified category belongs to its session and goes with its shutdown', async () => {
    await boot(async (h) => {
      const classifier = await import('../src/content-classifier.ts');
      const lastCategoryOfCall = (n: number): unknown =>
        (vi.mocked(classifier.classifyPrompt).mock.calls[n]?.[1] as any)?.context?.lastCategory;
      const dynamicTurn = async (id: string): Promise<void> =>
        drain(
          h.defaultExport.groupStream(
            { provider: 'dynamic', id: 'dynamic' },
            { messages: [{ role: 'user', content: 'refactor the parser module' }] },
            { sessionId: id }
          )
        );
      await dynamicTurn('parent'); // call 0: classified, category remembered for 'parent'
      await dynamicTurn('child'); // call 1: must NOT see the parent's category
      expect(lastCategoryOfCall(1)).toBeUndefined();
      await dynamicTurn('parent'); // call 2: sees its own
      expect(lastCategoryOfCall(2)).toBeDefined();
      await h.onHandlers['session_shutdown']?.({}, session('parent'));
      await dynamicTurn('parent'); // call 3: the shutdown dropped it
      expect(lastCategoryOfCall(3)).toBeUndefined();
    });
  }, 30000);
});
