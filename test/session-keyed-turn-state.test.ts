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
  gdpval_builtin: { 'paid-model': 1000 },
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
      const streamSimple = vi.fn(() =>
        (async function* () {
          yield { type: 'text_delta', delta: 'reply' };
          yield doneEvent();
        })()
      );
      const modelRegistry = {
        getAvailable: () => [paidModel],
        find: () => paidModel,
        getApiKeyForProvider: async () => null,
        runtime: { streamSimple },
      };
      await startSession(onHandlers, { modelRegistry, cwd: tmpDir });
      await fn({
        defaultExport,
        onHandlers,
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
