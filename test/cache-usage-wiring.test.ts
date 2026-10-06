// test/cache-usage-wiring.test.ts
// Phase 5a wiring pin: the REAL turn_end handler must write cache tokens
// into usage_log (pure-helper tests alone would stay green if the handler
// kept logging input+output only — the original defect).

import { describe, it, expect, vi } from 'vitest';
import { createEventHandlers } from '../src/event-handlers.js';
import { SessionEscalation } from '../src/escalation.js';

function harness() {
  const handlers: Record<string, ((...a: any[]) => any)[]> = {};
  const rt: any = {
    pi: { on: (name: string, fn: any) => ((handlers[name] ??= []).push(fn)) },
    cache: { usage_log: [] },
    curModel: 'standard/standard',
    turnStart: Date.now() - 1000,
    escalation: new SessionEscalation(),
    router: { getCurModel: () => 'claude-bridge/claude-opus-5-5' },
    updateMetrics: vi.fn(),
    recordOk: vi.fn(),
    saveCache: vi.fn(),
  };
  createEventHandlers(rt);
  return { rt, turnEnd: handlers['turn_end'][0] };
}

describe('turn_end usage_log wiring (Phase 5a)', () => {
  it('logs cacheRead/cacheWrite and counts them in tokens', async () => {
    const { rt, turnEnd } = harness();
    await turnEnd({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input: 2, output: 163, cacheRead: 50120, cacheWrite: 3322, cost: { total: 0 } },
      },
    });
    expect(rt.cache.usage_log).toHaveLength(1);
    expect(rt.cache.usage_log[0]).toMatchObject({
      ref: 'claude-bridge/claude-opus-5-5',
      tokens: 2 + 163 + 50120 + 3322,
      cacheRead: 50120,
      cacheWrite: 3322,
    });
  });

  it('feeds throughput metrics WITHOUT cache tokens (tps must not inflate ~40x)', async () => {
    const { rt, turnEnd } = harness();
    await turnEnd({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input: 2, output: 163, cacheRead: 50120, cacheWrite: 3322, cost: { total: 0 } },
      },
    });
    // updateMetrics(ref, latMs, tokens, durMs): tokens drive throughput_tps.
    expect(rt.updateMetrics).toHaveBeenCalledTimes(1);
    expect(rt.updateMetrics.mock.calls[0][2]).toBe(2 + 163);
  });

  it('keeps the legacy shape for a provider without cache fields', async () => {
    const { rt, turnEnd } = harness();
    await turnEnd({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input: 10, output: 5, cost: { total: 0 } },
      },
    });
    expect(rt.cache.usage_log[0].tokens).toBe(15);
    expect(rt.cache.usage_log[0]).not.toHaveProperty('cacheRead');
  });
});
