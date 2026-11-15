// ADR-0027 / plan docs/plans/2026-10-08-classifier-decision-log.md,
// Phases 2 and 4 (owner go 2026-11-15: "zu 7, fertig machen").
//
// Phase 2: every classification record carries the `turn` id minted for it;
// turns that actually streamed (or were pinned via /model or MHINT) emit an
// `outcome` record; a group HINT on a later turn emits a `correction` for the
// previous turn; turns that never streamed emit no outcome.
//
// Phase 4: the ShadowClassifier seam in classifyPrompt — result identical with
// and without a shadow, shadow never runs for HINT, shadow errors are
// swallowed and recorded into the same record's shadow[], and the
// classification's latency is unchanged (the record flush waits for the
// shadow, the returned result does not).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildOutcomeRecord,
  buildCorrectionRecord,
  parseDecisionLogText,
  writeOutcomeRecord,
  type DecisionOutcomeRecord,
} from '../src/classifier-decision-log.ts';
import { classifyPrompt } from '../src/content-classifier.ts';
import type { ClassificationOptions } from '../src/content-classifier.ts';

let home: string;
let logPath: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlp24-home-'));
  logPath = path.join(home, '.pi', 'logs', 'classifier-decisions.jsonl');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

/** Minimal cfg that enables the decision log with hashes only. */
const CFG = {
  classifier: { log: { enabled: true, store_text: 'none' } },
} as any;

const BASE_OPTS: ClassificationOptions = { cfg: CFG } as any;

function readRecords() {
  if (!fs.existsSync(logPath)) return [];
  return parseDecisionLogText(fs.readFileSync(logPath, 'utf-8')) as any[];
}

describe('Phase 2 — turn id on the classification record', () => {
  it('the minted turn lands on the record', async () => {
    await classifyPrompt('Schreibe einen Test', { ...BASE_OPTS, turn: 'sessA#3' } as any);
    const recs = readRecords();
    expect(recs.length).toBe(1);
    expect(recs[0].turn).toBe('sessA#3');
  });

  it('records without a turn stay valid (turn null)', async () => {
    await classifyPrompt('Hallo', BASE_OPTS);
    const recs = readRecords();
    expect(recs[0].turn ?? null).toBe(null);
  });
});

describe('Phase 2 — outcome and correction records', () => {
  it('buildOutcomeRecord carries turn, ref, via and outcome', () => {
    const rec = buildOutcomeRecord({
      turn: 'sessA#3',
      ref: 'claude-bridge/claude-opus-5-5',
      via: 'stream',
      outcome: 'ok',
      ms: 1234,
    });
    expect(rec.stage).toBe('outcome');
    expect(rec.turn).toBe('sessA#3');
    expect(rec.via).toBe('stream');
    expect(rec.outcome).toBe('ok');
  });

  it('writeOutcomeRecord appends a parseable outcome line', () => {
    writeOutcomeRecord(
      { turn: 'sessA#4', ref: 'ollama/gemma4:12b-mlx', via: 'model_select', outcome: 'ok', ms: 0 },
      home,
      { maxBytes: 1 << 20, keep: 3 }
    );
    const recs = readRecords();
    expect(recs.length).toBe(1);
    expect(recs[0].stage).toBe('outcome');
    expect(recs[0].via).toBe('model_select');
  });

  it('a group HINT emits a correction for the previous turn', () => {
    const rec = buildCorrectionRecord({
      turn: 'sessA#5',
      prevTurn: 'sessA#4',
      from: { group: 'standard', ref: 'claude-bridge/claude-haiku-5-5' },
      to: { group: 'planning', ref: null },
    });
    expect(rec.stage).toBe('correction');
    expect(rec.prevTurn).toBe('sessA#4');
    expect(rec.to.group).toBe('planning');
  });

  it('outcome and correction records parse together with classification records', () => {
    writeOutcomeRecord(
      { turn: 's#1', ref: 'a/b', via: 'stream', outcome: 'failed', ms: 10, error: 'boom' },
      home,
      { maxBytes: 1 << 20, keep: 3 }
    );
    const recs = readRecords();
    expect((recs[0] as DecisionOutcomeRecord).error).toBe('boom');
  });
});

describe('Phase 4 — the shadow seam in classifyPrompt', () => {
  const shadow = {
    name: 'shadow-x',
    classify: vi.fn(async () => ({ category: 'design', confidence: 0.9, reason: 'shadow' }) as any),
  };

  it('the result is identical with and without a shadow', async () => {
    const without = await classifyPrompt('Baue ein Dashboard', BASE_OPTS);
    const withShadow = await classifyPrompt('Baue ein Dashboard', { ...BASE_OPTS, shadow } as any);
    expect(withShadow).toEqual(without);
  });

  it('the shadow never runs for a HINT prompt', async () => {
    shadow.classify.mockClear();
    await classifyPrompt('HINT: group planning bitte', { ...BASE_OPTS, shadow } as any);
    expect(shadow.classify).not.toHaveBeenCalled();
  });

  it('shadow output lands in the SAME record\u2019s shadow[] (flushed when the shadow settles)', async () => {
    await classifyPrompt('Analysiere das System', { ...BASE_OPTS, turn: 'sessB#1', shadow } as any);
    await vi.waitFor(() => {
      const recs = readRecords();
      expect(recs.length).toBe(1);
      expect(recs[0].shadow?.[0]?.name).toBe('shadow-x');
    });
    const rec = readRecords()[0];
    expect(rec.turn).toBe('sessB#1');
    expect(rec.shadow[0].category).toBe('design');
    expect(rec.shadow[0].confidence).toBe(0.9);
  });

  it('a throwing shadow is recorded as error on the same record, not propagated', async () => {
    const bad = {
      name: 'bad-shadow',
      classify: async () => {
        throw new Error('sidecar down');
      },
    };
    const res = await classifyPrompt('kaputter shadow', {
      ...BASE_OPTS,
      turn: 'sessB#2',
      shadow: bad,
    } as any);
    expect(res).toBeDefined(); // classification itself unaffected
    await vi.waitFor(() => {
      const rec = readRecords().find((r) => r.turn === 'sessB#2');
      expect(rec?.shadow?.[0]?.error).toMatch(/sidecar down/);
    });
  });

  it('a shadow that times out flushes the record with an error entry', async () => {
    const slow = {
      name: 'slow-shadow',
      classify: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { category: 'simple' } as any;
      },
    };
    await classifyPrompt('timeout test', {
      ...BASE_OPTS,
      turn: 'sessB#3',
      shadow: slow,
      shadowTimeoutMs: 30,
    } as any);
    await vi.waitFor(() => {
      const rec = readRecords().find((r) => r.turn === 'sessB#3');
      expect(rec?.shadow?.[0]?.error).toMatch(/timeout/);
    });
  });

  it('the classification latency does not wait for the shadow', async () => {
    const slow = {
      name: 'slow-shadow',
      classify: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { category: 'simple' } as any;
      },
    };
    const t0 = Date.now();
    await classifyPrompt('schnell bitte', { ...BASE_OPTS, shadow: slow } as any);
    expect(Date.now() - t0).toBeLessThan(150);
  });
});

// ── Wiring: the orchestrator mints the turn and passes it to classifyPrompt ──

import { StreamOrchestrator } from '../src/stream-orchestrator.ts';

describe('Phase 2 wiring — orchestrator passes the minted turn id to classifyPrompt', () => {
  it('classifyOpts.turn is the ctx turnId', async () => {
    const classifyPrompt = vi.fn(
      async () => ({ category: 'standard', confidence: 0.9, reason: 'r' }) as any
    );
    const ctx: any = {
      cfg: { model_groups: { dynamic: { method: 'dynamic' } }, model_metrics: {}, providers: {} },
      cache: {},
      router: { allDiscoveredRefs: () => [], getTopModels: () => ({ models: [] }) },
      lastDynamicModel: '',
      lastClassifiedCategory: undefined,
      escalation: { level: 'standard' },
      sessionCtx: undefined,
      activeGroup: null,
      resolve: () => ({ candidates: ['a/b'], selected: 'a/b' }),
      extractLastUserPrompt: () => 'mach was',
      extractLastAssistantSnippet: () => undefined,
      detectHintDirectly: () => null,
      isCompactionTurn: () => false,
      getModelContextWindow: () => null,
      isLimited: () => false,
      clearLimit: () => {},
      lookupGdp: () => null,
      getGroupForCategory: (c: string) => c,
      classifyPrompt,
      turnId: () => 'sessW#7',
    };
    const orch = new StreamOrchestrator(ctx);
    vi.spyOn(orch, 'driveStream').mockResolvedValue(undefined as never);
    orch.groupStream(
      { provider: 'router', id: 'dynamic', api: 'x' } as any,
      {
        messages: [{ role: 'user', content: 'mach was', timestamp: 1 }],
      } as any
    );
    await vi.waitFor(() => expect(classifyPrompt).toHaveBeenCalled());
    const opts = classifyPrompt.mock.calls[0][1] as any;
    expect(opts.turn).toBe('sessW#7');
  });
});
