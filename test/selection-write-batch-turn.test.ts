// Live-phase follow-up of the step-5 migration: a `router/dynamic` turn
// writes its selection state (run cleared at turn start, category after
// classification, run group, served group) as ONE branch entry, and that
// entry is on the branch as soon as a stream opened — not only when the
// stream ends, so a process that dies while the model answers keeps the
// turn's state. Red-first per AGENTS.md §4: the dynamic turn's writes before
// the walk sat outside the walk's batch (one entry each), and the batch
// flushed only at the walk's end.
import { describe, it, expect, vi } from 'vitest';
import { makeExtensionContext, startSession } from './helpers/extension-harness.ts';
import { paidCloudModel } from './helpers/stream-fixtures.ts';
import { withRouterEnv } from './helpers/router-env.ts';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { STATE_ENTRY, branchState } from '../src/virtual-selection.ts';

const CONFIG = {
  free_models: [],
  providers: {},
  model_groups: {
    dynamic: { method: 'dynamic' },
    planning: { fallback_groups: [], min_gdpval: 950 },
    standard: { fallback_groups: [], min_gdpval: 0 },
  },
  gdpval_builtin: { 'paid-model': 1000 },
};

const stateEntries = (ctx: any): any[] =>
  ctx.sessionManager
    .getBranch()
    .filter((e: any) => e.type === 'custom' && e.customType === STATE_ENTRY);

/** A provider stream the test finishes by hand (the model is "still answering"). */
function heldStream(): { stream: any; finish: () => void } {
  const stream = createAssistantMessageEventStream();
  const message: any = {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: 'openai-completions',
    provider: 'paid-cloud-provider',
    model: 'paid-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'text_start', contentIndex: 0, partial: message });
  stream.push({ type: 'text_delta', contentIndex: 0, delta: 'ok', partial: message });
  return {
    stream,
    finish: () => {
      stream.push({ type: 'text_end', contentIndex: 0, content: 'ok', partial: message });
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
    },
  };
}

describe('a router/dynamic turn writes its selection state once', () => {
  it('one entry per turn, on the branch while the model still answers', async () => {
    await withRouterEnv(
      async (defaultExport, tmpDir) => {
        const { ctx: pi, onHandlers } = makeExtensionContext();
        defaultExport(pi);
        const paid = paidCloudModel();
        let held: ReturnType<typeof heldStream> | undefined;
        const modelRegistry = {
          getAvailable: () => [paid],
          find: () => paid,
          getApiKeyForProvider: async () => null,
          runtime: {
            streamSimple: vi.fn(() => {
              held = heldStream();
              return held.stream;
            }),
          },
        };
        const ctx: any = await startSession(onHandlers, { modelRegistry, cwd: tmpDir });
        const before = stateEntries(ctx).length;
        await onHandlers['turn_start']?.({}, ctx);
        const proxy: AsyncIterable<unknown> = await defaultExport.groupStream(
          { provider: 'dynamic', id: 'dynamic' },
          {
            messages: [
              { role: 'user', content: 'HINT use group planning and do it', timestamp: Date.now() },
            ],
          },
          { sessionId: ctx.sessionManager.getSessionId() }
        );
        const it = proxy[Symbol.asyncIterator]();
        // Wait until the provider stream is open and its first delta arrived.
        for (;;) {
          const r = await it.next();
          if (r.done || (r.value as any)?.type === 'text_delta') break;
        }
        expect(held, 'the provider stream opened').toBeDefined();
        const mid = stateEntries(ctx).slice(before);
        expect(mid, 'the turn state is on the branch while the model answers').toHaveLength(1);
        expect(branchState(ctx.sessionManager.getBranch())).toMatchObject({
          runGroup: 'planning',
          group: 'planning',
        });
        held!.finish();
        for (;;) {
          const r = await it.next();
          if (r.done) break;
        }
        expect(stateEntries(ctx).slice(before), 'one entry for the whole turn').toHaveLength(1);
      },
      { config: CONFIG, disableNetwork: true }
    );
  }, 30_000);
});
