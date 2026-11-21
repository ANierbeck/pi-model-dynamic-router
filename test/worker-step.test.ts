// Long-turn plan (docs/plans/2026-11-21-long-turn-model-use.md), Phase 2:
// the `worker_step` tool — hand a fully specified MECHANICAL task to the
// cheap delegation group as a text-only sub-call. Red-first per AGENTS.md §4.

import { describe, it, expect, vi } from 'vitest';
import { createTools } from '../src/tools.ts';
import { runWorkerStep, WORKER_TASK_MAX_CHARS, buildWorkerPrompt } from '../src/worker-step.ts';
import type { Config } from '../src/types.ts';

type Handler = (
  id: string,
  params: unknown,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown
) => Promise<unknown>;

/** Capture the registered tools, as in test/router-command-help.test.ts. */
function toolRig(cfg: unknown) {
  const tools: Record<string, { execute: Handler }> = {};
  const rt = {
    pi: { registerTool: (t: { name: string; execute: Handler }) => (tools[t.name] = t) },
    load: () => {},
    cfg,
  };
  createTools(rt as never);
  return tools;
}

const cfgWith = (delegation: unknown) => ({ model_groups: {}, delegation }) as unknown as Config;

function makeCtx(
  events: unknown[] = [],
  groupModel: unknown = { provider: 'bulk_reader', id: 'bulk_reader' }
) {
  const streamSimple = vi.fn(async function* () {
    for (const e of events) yield e;
  });
  const find = vi.fn(() => groupModel);
  const ctx = {
    modelRegistry: { find, runtime: { streamSimple } },
    signal: undefined,
  };
  return { ctx, streamSimple, find };
}

const done = (text: string) => [
  { type: 'text_delta', delta: text },
  { type: 'done', message: { usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0 } } } },
];

describe('worker_step tool (Phase 2)', () => {
  it('is registered with a task parameter', () => {
    const tools = toolRig(cfgWith({ enabled: true, group: 'bulk_reader' }));
    expect(tools['worker_step']).toBeDefined();
  });

  it('disabled delegation: the call fails with a clear message, no sub-call', async () => {
    const { ctx, streamSimple } = makeCtx(done('x'));
    await expect(
      runWorkerStep('do x', ctx as never, cfgWith(undefined), undefined)
    ).rejects.toThrow(/disabled/i);
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('resolves the worker model through the registry as <group>/<group> — never a hardcoded model', async () => {
    const { ctx, streamSimple, find } = makeCtx(done('worker answer'), {
      provider: 'cheap',
      id: 'cheap',
    });
    const cfg = cfgWith({ enabled: true, group: 'bulk_reader' });
    const out = await runWorkerStep('summarize this log', ctx as never, cfg, undefined);
    expect(find).toHaveBeenCalledWith('bulk_reader', 'bulk_reader');
    expect(streamSimple).toHaveBeenCalledTimes(1);
    expect(streamSimple.mock.calls[0][0]).toEqual({ provider: 'cheap', id: 'cheap' });
    expect(out.content[0].text).toMatch(/worker answer/);
  });

  it('an unregistered delegation group fails closed with a clear message', async () => {
    const { ctx, streamSimple } = makeCtx(done('x'), null);
    await expect(
      runWorkerStep(
        'do x',
        ctx as never,
        cfgWith({ enabled: true, group: 'bulk_reader' }),
        undefined
      )
    ).rejects.toThrow(/not registered/i);
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('a task longer than the cap is rejected before any sub-call', async () => {
    const { ctx, streamSimple } = makeCtx(done('x'));
    const longTask = 'x'.repeat(WORKER_TASK_MAX_CHARS + 1);
    await expect(
      runWorkerStep(
        longTask,
        ctx as never,
        cfgWith({ enabled: true, group: 'bulk_reader' }),
        undefined
      )
    ).rejects.toThrow(/too long/i);
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it('the prompt states the mechanical-only contract and carries the task', () => {
    const p = buildWorkerPrompt('run the gates and report pass/fail');
    expect(p).toMatch(/mechanical/i);
    expect(p).toContain('run the gates and report pass/fail');
    expect(p).toMatch(/no tools/i); // the worker cannot run commands
  });

  it('a stream error fails the tool with the worker error text', async () => {
    const { ctx } = makeCtx([
      { type: 'text_delta', delta: 'partial' },
      { type: 'error', error: { content: [{ type: 'text', text: 'boom' }] } },
    ]);
    await expect(
      runWorkerStep(
        'do x',
        ctx as never,
        cfgWith({ enabled: true, group: 'bulk_reader' }),
        undefined
      )
    ).rejects.toThrow(/boom/);
  });

  it('nested usage is attached to the result', async () => {
    const { ctx } = makeCtx(done('answer'));
    const out = await runWorkerStep(
      'do x',
      ctx as never,
      cfgWith({ enabled: true, group: 'bulk_reader' }),
      undefined
    );
    expect(out.content[0].text).toMatch(/answer/);
    expect(out.usage).toMatchObject({ output: 2 });
  });
});
