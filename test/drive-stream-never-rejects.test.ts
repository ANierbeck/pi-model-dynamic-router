// Regression test: driveStream must never reject, and its proxy stream must
// always terminate. Found by the lint burn-down (S2,
// @typescript-eslint/no-floating-promises, docs/plans/2026-11-04-lint-gate.md).
//
// All three callers start driveStream without awaiting or catching it: the
// static-group path of groupStream, the dynamic path's async IIFE (whose own
// try/catch only covers classification), and the stream proxy. driveStream had
// no outer try — only each candidate attempt is guarded. A throw anywhere else
// (the context-token estimate, the pre-flight cooldown/breaker/window checks,
// the narration lookahead, the final error aggregation) therefore became an
// unhandled rejection (Node's default mode terminates the process) and left
// the proxy without a terminal event, so Pi awaited a stream that never ended.
import { describe, it, expect, vi } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { StreamOrchestrator } from '../src/stream-orchestrator.ts';

vi.mock('../src/logger.ts', async (orig) => {
  const actual = await orig<typeof import('../src/logger.ts')>();
  return { ...actual, appendRawLog: vi.fn(), routerLog: vi.fn(), warnLog: vi.fn(), errorLog: vi.fn() };
});

/** A context whose very first call inside driveStream throws. */
function throwingCtx(): any {
  return {
    cfg: { model_groups: { standard: { method: 'best' } }, model_metrics: {}, providers: {} },
    cache: {},
    router: { setActiveGroup: vi.fn(), setCurModel: vi.fn() },
    escalation: { level: 'standard' },
    resolve: () => ({ candidates: ['mistral/glm'], selected: 'mistral/glm' }),
    estimateContextTokens: () => {
      throw new Error('estimate exploded');
    },
  };
}

/** Collects events; fails instead of hanging when the stream never terminates. */
async function drain(stream: AsyncIterable<any>, ms = 2000): Promise<any[]> {
  const events: any[] = [];
  const done = (async () => {
    for await (const ev of stream) events.push(ev);
  })();
  const timeout = new Promise<'hang'>((resolve) => setTimeout(() => resolve('hang'), ms));
  const outcome = await Promise.race([done.then(() => 'ended' as const), timeout]);
  expect(outcome, 'the proxy stream never received a terminal event').toBe('ended');
  return events;
}

describe('driveStream never rejects', () => {
  it('resolves and terminates the proxy with a router error when it throws outside the candidate loop', async () => {
    const orch = new StreamOrchestrator(throwingCtx());
    const proxy = createAssistantMessageEventStream();
    await expect(
      orch.driveStream(proxy, ['mistral/glm'], { messages: [] } as any, undefined, undefined, 'standard'),
    ).resolves.toBeUndefined();
    const events = await drain(proxy);
    const err = events.find((e) => e.type === 'error');
    expect(err, 'a terminal error event').toBeDefined();
    expect(JSON.stringify(err)).toContain('estimate exploded');
  });

  it('the static-group path of groupStream ends its stream instead of leaking a rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const orch = new StreamOrchestrator(throwingCtx());
      const stream = orch.groupStream(
        { provider: 'router', id: 'standard', api: 'openai-completions' } as any,
        { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] } as any,
        undefined,
      );
      const events = await drain(stream as AsyncIterable<any>);
      expect(events.some((e) => e.type === 'error')).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('the dynamic path ends its stream when even the fallback resolution throws', async () => {
    // The async IIFE's try/catch covers classification, but its catch branch
    // resolves the fallback group itself; a throw there escaped the IIFE.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const ctx = throwingCtx();
      ctx.cfg.model_groups = { dynamic: { method: 'dynamic' }, simple: { method: 'best' } };
      ctx.extractLastUserPrompt = () => 'hi';
      ctx.detectHintDirectly = () => null;
      ctx.isCompactionTurn = () => false;
      ctx.classifyPrompt = async () => {
        throw new Error('classifier down');
      };
      ctx.resolve = () => {
        throw new Error('resolve exploded');
      };
      const orch = new StreamOrchestrator(ctx);
      const stream = orch.groupStream(
        { provider: 'router', id: 'dynamic', api: 'openai-completions' } as any,
        { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] } as any,
        undefined,
      );
      const events = await drain(stream as AsyncIterable<any>);
      const err = events.find((e) => e.type === 'error');
      expect(JSON.stringify(err)).toContain('resolve exploded');
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
