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
    pi: { on: (name: string, fn: any) => (handlers[name] ??= []).push(fn) },
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

// Release review 2026-11-08 (lane B, finding I1): pi's agent loop emits
// `turn_end` even for a failed turn (stopReason 'error'/'aborted' —
// node_modules/@earendil-works/pi-agent-core agent-loop.js:148-156), and the
// router's all-candidates-failed path ends the proxy with exactly such a
// synthetic error message (buildErrorAssistantMessage, src/stream-driver.ts).
// The handler must NOT treat that as a model success: recordOk() closes the
// provider's circuit breaker (ADR-0026 D5), clears the ref's health streak and
// blocklist entry, and resets the rate-limit hit counter — right after the
// cascade failed on that provider. Metrics/usage must not be booked either:
// the error text is router narration, not model output.
//
// Red evidence: before the stopReason gate, both error/aborted cases called
// recordOk + updateMetrics (2 failures).
describe('turn_end with a failed stopReason records no success', () => {
  const failedMsg = (stopReason: string) => ({
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '[router] All 2 candidate(s) failed: …' }],
      usage: { input: 5, output: 0 },
      stopReason,
    },
  });

  it.each(['error', 'aborted'])(
    'stopReason %s: no recordOk, no metrics, no usage_log',
    async (sr) => {
      const { rt, turnEnd } = harness();
      await turnEnd(failedMsg(sr));
      expect(rt.recordOk).not.toHaveBeenCalled();
      expect(rt.updateMetrics).not.toHaveBeenCalled();
      expect(rt.cache.usage_log).toHaveLength(0);
    }
  );

  it.each(['stop', 'toolUse', 'length'])(
    'stopReason %s: success is recorded as before',
    async (sr) => {
      const { rt, turnEnd } = harness();
      await turnEnd(failedMsg(sr));
      expect(rt.recordOk).toHaveBeenCalledTimes(1);
      expect(rt.updateMetrics).toHaveBeenCalledTimes(1);
    }
  );
});
