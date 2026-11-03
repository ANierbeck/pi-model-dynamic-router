// A delegation sub-call must not hijack the turn's model.
//
// Live incident 2026-11-03 (session pi-model-router-fork/97208): a planning
// turn was served by mistral/zai-glm-5-3. A 4137-char bash result was
// delegated to bulk_reader; the sub-call streams through the router's own
// groupStream → driveStream, which sets lastDynamicModel to whatever it
// served (openrouter/google/gemma-4-31b-it:free). The NEXT tool follow-up
// step puts lastDynamicModel first (stream-orchestrator isToolFollowUp), so
// the main turn continued on the free bulk_reader model, hit 429s and fell
// to openrouter/openrouter/free, which printed raw tool-call markup as text.
// The free model then stayed pinned for the rest of the turn and, through
// compaction continuity, for the user's next prompt.
//
// The turn's driving ref (Router.turnDriverRef) was already protected
// against this nested overwrite; lastDynamicModel was not.

import { describe, it, expect, vi } from 'vitest';
import { createEventHandlers } from '../src/event-handlers.ts';
import { SessionEscalation } from '../src/escalation.ts';
import type { Config } from '../src/types.ts';

const TURN_MODEL = 'mistral/zai-glm-5-3';
const BULK_MODEL = 'openrouter/google/gemma-4-31b-it:free';

function harness() {
  const handlers: Record<string, ((...a: any[]) => any)[]> = {};
  const cfg = {
    model_groups: {},
    model_metrics: {},
    delegation: { enabled: true },
  } as any as Config;
  const rt: any = {
    pi: { on: (name: string, fn: any) => ((handlers[name] ??= []).push(fn)) },
    cache: { usage_log: [] },
    cfg,
    activeGroup: null,
    curModel: 'dynamic/dynamic',
    lastDynamicModel: TURN_MODEL,
    turnStart: 0,
    escalation: new SessionEscalation(),
    router: { noteTurnStart: vi.fn(), getCurModel: () => TURN_MODEL, getTurnDriverRef: () => TURN_MODEL },
    updateMetrics: vi.fn(),
    recordOk: vi.fn(),
    saveCache: vi.fn(),
  };
  createEventHandlers(rt);

  // The sub-call goes through the router's own stream handler, which
  // overwrites lastDynamicModel with the ref it served — simulated here
  // exactly where driveStream does it (on stream open).
  const summary = 'summary of the result, long enough to be used as a replacement';
  const streamSimple = vi.fn(async function* () {
    rt.lastDynamicModel = BULK_MODEL;
    yield { type: 'text_delta', delta: summary };
    yield { type: 'message_end', usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } } };
  });
  const ctx = {
    modelRegistry: { find: vi.fn(() => ({ provider: 'bulk_reader', id: 'bulk_reader' })), runtime: { streamSimple } },
    signal: undefined,
  };
  return { rt, handlers, ctx, streamSimple };
}

describe('tool_result delegation keeps the turn model', () => {
  it('restores lastDynamicModel after the bulk_reader sub-call overwrote it', async () => {
    const { rt, handlers, ctx, streamSimple } = harness();
    const ev = { toolName: 'bash', input: { command: 'python3 analyze.py' }, content: [{ type: 'text', text: 'x'.repeat(4137) }], isError: false };

    let out: any;
    for (const h of handlers['tool_result'] ?? []) out = (await h(ev, ctx)) ?? out;

    expect(streamSimple).toHaveBeenCalledTimes(1);
    expect(out?.content?.[0]?.text).toContain('[delegated summary');
    // The next tool follow-up must start on the turn's model, not the summarizer's.
    expect(rt.lastDynamicModel).toBe(TURN_MODEL);
  });

  it('restores it when the sub-call fails too (fail-open path)', async () => {
    const { rt, handlers, ctx, streamSimple } = harness();
    streamSimple.mockImplementation(async function* () {
      rt.lastDynamicModel = BULK_MODEL;
      throw new Error('429 rate-limited upstream');
    });
    const ev = { toolName: 'bash', input: { command: 'python3 analyze.py' }, content: [{ type: 'text', text: 'x'.repeat(4137) }], isError: false };

    for (const h of handlers['tool_result'] ?? []) await h(ev, ctx);

    expect(rt.lastDynamicModel).toBe(TURN_MODEL);
  });
});
