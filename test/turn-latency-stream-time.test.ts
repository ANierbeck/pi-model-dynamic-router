// test/turn-latency-stream-time.test.ts
// M3 (docs/plans/2026-11-07-turn-latency-tool-time.md): the per-model latency
// sample must measure the MODEL STREAM, not the turn. Before this fix
// `turn_end` booked `Date.now() - rt.turnStart` — the whole turn, including
// every tool run and every delegation sub-call — as the latency of the model
// that merely answered, and the same number as its throughput denominator.
// The ranking reads both (`avg_latency_ms`, `benchmarks`), so a 30 s
// `bulk_read` sub-call silently demoted a healthy model.
//
// Two layers are pinned here, because either one alone would stay green while
// the defect came back: the stream proxy must BOOK the stream time, and the
// turn_end handler must USE it instead of the turn wall time.
//
// Red evidence (2026-11-08): with the pre-fix handler the turn_end cases fail
// with latMs ≈ 5000 instead of the stream time, and the proxy cases fail
// because nothing calls addTurnStreamMs at all.

import { describe, it, expect, vi } from 'vitest';
import { createEventHandlers } from '../src/event-handlers.js';
import { SessionEscalation } from '../src/escalation.js';
import { emptyTurnState } from '../src/turn-state.js';
import { walkStubWorld } from './helpers/walk-stub-ctx.js';

describe('M3 — the walk books model-stream time', () => {
  it('books the elapsed time of a successful stream', async () => {
    const world = walkStubWorld({
      consume: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true };
      },
    });
    await world.run(['prov/model']);
    expect(world.ctx.addTurnStreamMs).toHaveBeenCalledTimes(1);
    // The sample is the stream's own duration — not zero, and not the turn.
    expect(world.ctx.addTurnStreamMs.mock.calls[0][0]).toBeGreaterThanOrEqual(15);
  });

  it('books a FAILED attempt too — the user waited for it (open decision 2)', async () => {
    const world = walkStubWorld({
      consume: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { ok: false, reason: 'provider_error', detail: 'boom' };
      },
    });
    await world.run(['prov/model']);
    expect(world.ctx.addTurnStreamMs).toHaveBeenCalledTimes(1);
    expect(world.ctx.addTurnStreamMs.mock.calls[0][0]).toBeGreaterThanOrEqual(15);
  });

  it('books every candidate of a cascade, not only the winner', async () => {
    const world = walkStubWorld({
      results: { 'prov/a': { ok: false, reason: 'stall_timeout' }, 'prov/b': { ok: true } },
    });
    await world.run(['prov/a', 'prov/b']);
    expect(world.ctx.addTurnStreamMs).toHaveBeenCalledTimes(2);
  });
});

describe('M3 — turn_end books stream time, not turn wall time', () => {
  function turnHarness(overrides: Record<string, unknown> = {}) {
    const handlers: Record<string, ((...a: any[]) => any)[]> = {};
    const rt: any = {
      pi: { on: (name: string, fn: any) => (handlers[name] ??= []).push(fn) },
      cache: { usage_log: [] },
      curModel: 'standard/standard',
      // 5 s of "tool time" between turn_start and turn_end.
      turnStart: Date.now() - 5000,
      turnStreamMs: 0,
      turnStreamCount: 0,
      resetTurnStreams: vi.fn(),
      escalation: new SessionEscalation(),
      router: { getCurModel: () => 'prov/model', noteTurnStart: vi.fn() },
      updateMetrics: vi.fn(),
      recordOk: vi.fn(),
      saveCache: vi.fn(),
      ...overrides,
    };
    createEventHandlers(rt);
    return { rt, turnEnd: handlers['turn_end'][0], turnStart: handlers['turn_start'][0] };
  }

  const assistantMsg = {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input: 10, output: 90 },
  };

  it('passes the stream time as latency AND throughput duration', async () => {
    const { rt, turnEnd } = turnHarness({ turnStreamMs: 37, turnStreamCount: 1 });
    await turnEnd({ message: assistantMsg });
    expect(rt.updateMetrics).toHaveBeenCalledTimes(1);
    // updateMetrics(ref, latMs, tokens, durMs)
    expect(rt.updateMetrics.mock.calls[0][1]).toBe(37);
    expect(rt.updateMetrics.mock.calls[0][3]).toBe(37);
  });

  it('sums several streams of the same turn (open decision 1 = sum)', async () => {
    const { rt, turnEnd } = turnHarness({ turnStreamMs: 120, turnStreamCount: 3 });
    await turnEnd({ message: assistantMsg });
    expect(rt.updateMetrics.mock.calls[0][1]).toBe(120);
  });

  it('fails open: a turn with no measured stream keeps the turn-level sample', async () => {
    const { rt, turnEnd } = turnHarness({ turnStreamMs: 0 });
    await turnEnd({ message: assistantMsg });
    const lat = rt.updateMetrics.mock.calls[0][1] as number;
    expect(lat).toBeGreaterThanOrEqual(4900);
  });

  it('resets the accumulator at the turn boundary', async () => {
    const { rt, turnStart } = turnHarness();
    await turnStart({}, { model: null });
    expect(rt.resetTurnStreams).toHaveBeenCalledTimes(1);
  });
});

describe('M3 — turn state keeps the accumulator per session', () => {
  it('starts every session at zero', () => {
    const s = emptyTurnState();
    expect(s.streamMs).toBe(0);
    expect(s.streamCount).toBe(0);
  });
});
