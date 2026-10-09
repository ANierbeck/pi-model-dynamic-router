// Regression tests for defects found while reading the classification path
// (classifier decision-log plan, 2026-10-08). The cloud chain is the path
// that actually runs (cloud-first since 2026-09-27), yet:
//
//   D1  MIN_CONFIDENCE gated only the local Ollama path — a cloud reply with
//       confidence 0.2 was trusted as-is.
//   D2  A cloud reply with an invalid category was skipped without a trace
//       (the local path warns); the skip is now visible.
//   D5  tryCloud never wrote the classification cache, so identical prompts
//       (subagent fan-out) re-ran the whole chain; and the local path cached
//       results derived from the previous turn's category (stale across
//       contexts).
//
// Every test uses a UNIQUE prompt (module-level classification cache).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyPrompt } from '../src/content-classifier.ts';
import type { Config, Cache } from '../src/types.ts';
import { callOllama, isOllamaAvailable } from '../src/ollama-utils.ts';
import { localModelCache } from './helpers/local-model-cache.ts';
import * as logger from '../src/logger.ts';

vi.mock('../src/ollama-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ollama-utils.ts')>();
  return { ...actual, callOllama: vi.fn(), isOllamaAvailable: vi.fn() };
});

vi.mock('../src/logger.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/logger.ts')>();
  return { ...actual, warnLog: vi.fn(actual.warnLog) };
});

const cfg: Config = { providers: {}, model_groups: {}, model_metrics: {} };
const cloudCache = (...refs: string[]): Cache => ({ classifier_fallback_models: refs }) as Cache;

const textReply = (obj: Record<string, unknown>) => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  stopReason: 'stop',
});

function cloudOpts(refs: string[], replies: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  let i = 0;
  const completeSimple = vi.fn(async () => textReply(replies[Math.min(i++, replies.length - 1)]!));
  return {
    completeSimple,
    opts: {
      cfg,
      cache: cloudCache(...refs),
      allowCloudFallback: true,
      completeSimple,
      findModel: (ref: string) => ({ provider: ref.split('/')[0], id: ref.split('/').slice(1).join('/') }),
      ...extra,
    } as any,
  };
}

describe('D1 — confidence gate on the cloud path', () => {
  it('a low-confidence cloud reply inherits the previous category', async () => {
    const { opts } = cloudOpts(['p/m1'], [{ category: 'design', reason: 'unsure', confidence: 0.3 }], {
      context: { lastCategory: 'code_complex' },
    });
    const r = await classifyPrompt('d1 low confidence inherits previous category please', opts);
    expect(r).toMatchObject({ category: 'code_complex', confidence: 0.3 });
    expect((r as any).reason).toContain('Low confidence');
    expect((r as any).reason).toContain('prior context');
  });

  it('a low-confidence cloud reply without a previous category falls back', async () => {
    const { opts } = cloudOpts(['p/m1'], [{ category: 'design', reason: 'unsure', confidence: 0.1 }]);
    const r = await classifyPrompt('d1 low confidence without any prior context at all', opts);
    expect(r).toMatchObject({ category: 'fallback', confidence: 0.1 });
    expect((r as any).reason).toContain('falling back');
  });

  it('confidence exactly at the threshold (0.5) is trusted', async () => {
    const { opts } = cloudOpts(['p/m1'], [{ category: 'design', reason: 'borderline', confidence: 0.5 }], {
      context: { lastCategory: 'code_complex' },
    });
    const r = await classifyPrompt('d1 boundary confidence exactly at threshold stays', opts);
    expect(r).toMatchObject({ category: 'design', confidence: 0.5 });
  });

  it('a reply without a confidence field is trusted (the field is optional)', async () => {
    const { opts } = cloudOpts(['p/m1'], [{ category: 'planning', reason: 'no confidence given' }], {
      context: { lastCategory: 'code_complex' },
    });
    const r = await classifyPrompt('d1 missing confidence field is not a low confidence', opts);
    expect(r).toMatchObject({ category: 'planning' });
  });

  it('a low-confidence HINT conversion is never gated (hints carry confidence 1.0 by contract)', async () => {
    const { opts } = cloudOpts(['p/m1'], [{ category: 'hint:group:tactical', reason: 'user asked', confidence: 0.2 }]);
    const r = await classifyPrompt('d1 please HINT: group tactical for this one', opts);
    expect(r).toMatchObject({ hintType: 'group', hintTarget: 'tactical' });
  });
});

describe('D2 — an invalid cloud category is visible, then the chain moves on', () => {
  beforeEach(() => vi.mocked(logger.warnLog).mockClear());

  it('warns about the invalid category and still uses the next candidate', async () => {
    const { opts, completeSimple } = cloudOpts(
      ['p/bad', 'p/good'],
      [
        { category: 'banana', reason: 'made up category', confidence: 0.9 },
        { category: 'standard', reason: 'sane', confidence: 0.9 },
      ],
    );
    const r = await classifyPrompt('d2 invalid category from the first cloud candidate', opts);
    expect(r).toMatchObject({ category: 'standard' });
    expect(completeSimple).toHaveBeenCalledTimes(2);
    const warned = vi.mocked(logger.warnLog).mock.calls.map((c) => String(c[0]));
    expect(warned.some((m) => m.includes('p/bad') && m.includes('banana'))).toBe(true);
  });
});

describe('D5 — classification cache', () => {
  beforeEach(() => {
    vi.mocked(isOllamaAvailable).mockResolvedValue(true);
  });

  it('an identical prompt is served from the cache after a cloud classification', async () => {
    const { opts, completeSimple } = cloudOpts(['p/m1'], [{ category: 'simple', reason: 'ok', confidence: 0.9 }]);
    const prompt = 'd5 identical prompt repeated by a subagent fan-out';
    const first = await classifyPrompt(prompt, opts);
    const second = await classifyPrompt(prompt, opts);
    expect(second).toEqual(first);
    expect(completeSimple).toHaveBeenCalledTimes(1);
  });

  it('a cloud result derived from the previous category is NOT cached (context-dependent)', async () => {
    const prompt = 'd5 gated cloud result must not leak across contexts';
    const a = cloudOpts(['p/m1'], [{ category: 'design', reason: 'unsure', confidence: 0.2 }], {
      context: { lastCategory: 'code_complex' },
    });
    const first = await classifyPrompt(prompt, a.opts);
    expect(first).toMatchObject({ category: 'code_complex' });
    const b = cloudOpts(['p/m1'], [{ category: 'design', reason: 'unsure', confidence: 0.2 }], {
      context: { lastCategory: 'exploration' },
    });
    const second = await classifyPrompt(prompt, b.opts);
    expect(second).toMatchObject({ category: 'exploration' });
    expect(b.completeSimple).toHaveBeenCalledTimes(1);
  });

  it('a gated cloud result that fell back (no previous category) is NOT cached either', async () => {
    const prompt = 'd5 gated fallback must not poison a later conversation that has context';
    const a = cloudOpts(['p/m1'], [{ category: 'design', reason: 'unsure', confidence: 0.2 }]);
    expect(await classifyPrompt(prompt, a.opts)).toMatchObject({ category: 'fallback' });
    const b = cloudOpts(['p/m1'], [{ category: 'design', reason: 'now sure', confidence: 0.9 }]);
    expect(await classifyPrompt(prompt, b.opts)).toMatchObject({ category: 'design' });
    expect(b.completeSimple).toHaveBeenCalledTimes(1);
  });

  it('a local result derived from the previous category is NOT cached either', async () => {
    const prompt = 'd5 gated local result must not leak across contexts either';
    vi.mocked(callOllama).mockResolvedValue(JSON.stringify({ category: 'design', reason: 'unsure', confidence: 0.2 }));
    const base = { cache: localModelCache('foo:3b'), cfg };
    const first = await classifyPrompt(prompt, { ...base, context: { lastCategory: 'code_complex' } });
    expect(first).toMatchObject({ category: 'code_complex' });
    const second = await classifyPrompt(prompt, { ...base, context: { lastCategory: 'exploration' } });
    expect(second).toMatchObject({ category: 'exploration' });
  });
});
