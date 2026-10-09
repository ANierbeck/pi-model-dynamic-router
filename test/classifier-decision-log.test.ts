// Classifier decision log (docs/plans/2026-10-08-classifier-decision-log.md,
// Phase 1): one JSONL record per classifyPrompt call, written to
// ~/.pi/logs/classifier-decisions.jsonl, so "how did the known classifier
// decide" and — later — "how would Laya have decided on the same input" are
// answerable offline. Every test uses a UNIQUE prompt (module-level
// classification cache).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyPrompt, getGroupForCategory } from '../src/content-classifier.ts';
import { callOllama, isOllamaAvailable } from '../src/ollama-utils.ts';
import { localModelCache } from './helpers/local-model-cache.ts';
import type { Config, Cache } from '../src/types.ts';

vi.mock('../src/ollama-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ollama-utils.ts')>();
  return { ...actual, callOllama: vi.fn(), isOllamaAvailable: vi.fn() };
});

const logFile = () => join(homedir(), '.pi', 'logs', 'classifier-decisions.jsonl');
const records = (): any[] =>
  existsSync(logFile())
    ? readFileSync(logFile(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

const cfgWith = (log: Record<string, unknown> | undefined = { enabled: true, store_text: 'none' }): Config =>
  ({ providers: {}, model_groups: {}, model_metrics: {}, ...(log ? { classifier_log: log } : {}) }) as Config;

const reply = (obj: Record<string, unknown>) => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  stopReason: 'stop',
});
const modelFor = (ref: string) => ({ provider: ref.split('/')[0], id: ref.split('/').slice(1).join('/') });
const cloudCache = (...refs: string[]): Cache => ({ classifier_fallback_models: refs }) as Cache;

function cloud(refs: string[], answers: Array<(ref: string) => unknown>, extra: Record<string, unknown> = {}) {
  let i = 0;
  const completeSimple = vi.fn(async (m: any) => answers[Math.min(i++, answers.length - 1)]!(`${m.provider}/${m.id}`));
  return {
    cfg: cfgWith(),
    cache: cloudCache(...refs),
    allowCloudFallback: true,
    completeSimple,
    findModel: modelFor,
    ...extra,
  } as any;
}
const ok = (category: string, confidence = 0.9, reasonText = 'a reason') => () =>
  reply({ category, reason: reasonText, confidence });

beforeEach(() => {
  rmSync(join(homedir(), '.pi'), { recursive: true, force: true });
  vi.mocked(isOllamaAvailable).mockResolvedValue(true);
  vi.mocked(callOllama).mockReset();
});

describe('record per stage', () => {
  it('hint: deterministic, no model, no chain', async () => {
    await classifyPrompt('HINT: use group tactical for the dl-hint-stage prompt', { cfg: cfgWith() });
    const [r] = records();
    expect(r).toMatchObject({ v: 1, stage: 'hint', chain: [], raw: null });
    expect(r.final.hint).toMatchObject({ type: 'group', target: 'tactical' });
    expect(r.final.category).toBeNull();
  });

  it('compaction', async () => {
    await classifyPrompt('dl compaction stage prompt with enough words in it', {
      cfg: cfgWith(),
      context: { isCompaction: true, lastModel: 'cloud/big-model' },
    });
    const [r] = records();
    expect(r.stage).toBe('compaction');
    expect(r.input.context.isCompaction).toBe(true);
  });

  it('momentum: short prompt inherits the previous category', async () => {
    await classifyPrompt('mach weiter', { cfg: cfgWith(), context: { lastCategory: 'design' } });
    const [r] = records();
    expect(r).toMatchObject({ stage: 'momentum' });
    expect(r.final.category).toBe('design');
    expect(r.final.group).toBe(getGroupForCategory('design'));
    expect(r.input.words).toBe(2);
  });

  it('llm-cloud: chain, raw, answered_by, group', async () => {
    await classifyPrompt('dl cloud stage unique prompt number one here', cloud(['p/m1'], [ok('code_complex', 0.8)]));
    const [r] = records();
    expect(r.stage).toBe('llm-cloud');
    expect(r.answered_by).toBe('cloud:p/m1');
    expect(r.chain).toHaveLength(1);
    expect(r.chain[0]).toMatchObject({ ref: 'p/m1', outcome: 'ok' });
    expect(typeof r.chain[0].ms).toBe('number');
    expect(r.raw).toMatchObject({ category: 'code_complex', confidence: 0.8 });
    expect(r.final).toMatchObject({ category: 'code_complex', group: getGroupForCategory('code_complex') });
    expect(r.steps).toEqual([]);
    expect(typeof r.ms).toBe('number');
  });

  it('llm-local: the Ollama attempt is in the chain', async () => {
    vi.mocked(callOllama).mockResolvedValue(JSON.stringify({ category: 'simple', reason: 'x', confidence: 0.9 }));
    await classifyPrompt('dl local stage unique prompt number two here', { cfg: cfgWith(), cache: localModelCache('foo:3b') });
    const [r] = records();
    expect(r.stage).toBe('llm-local');
    expect(r.chain[0]).toMatchObject({ ref: 'ollama:foo:3b', outcome: 'ok' });
    expect(r.answered_by).toBe('ollama:foo:3b');
  });

  it('fallback: every attempt failed — the chain says why', async () => {
    const opts = cloud(['p/a', 'p/b'], [() => ({ errorMessage: '503: upstream gone', stopReason: 'error', content: [] })]);
    const result = await classifyPrompt('dl all attempts fail unique prompt three', opts);
    const [r] = records();
    expect(result).toMatchObject({ category: 'fallback' });
    expect(r.stage).toBe('fallback');
    expect(r.chain.map((a: any) => [a.ref, a.outcome, a.why])).toEqual([
      ['p/a', 'failed', 'http-5xx'],
      ['p/b', 'failed', 'http-5xx'],
    ]);
    expect(r.answered_by).toBeNull();
  });

  it('cache hit keeps the origin of the cached classification (D4)', async () => {
    const opts = cloud(['p/m1'], [ok('simple')]);
    const prompt = 'dl cache origin unique prompt number four here';
    await classifyPrompt(prompt, opts);
    await classifyPrompt(prompt, opts);
    const recs = records();
    expect(recs.map((r) => r.stage)).toEqual(['llm-cloud', 'cache']);
    expect(recs[1].cache_origin).toBe('cloud:p/m1');
    expect(recs[0].cache_origin).toBeNull();
  });
});

describe('raw vs final and steps', () => {
  it('low-confidence inherit is a recorded step', async () => {
    await classifyPrompt(
      'dl low confidence unique prompt number five here',
      cloud(['p/m1'], [ok('design', 0.2)], { context: { lastCategory: 'code_complex' } }),
    );
    const [r] = records();
    expect(r.raw).toMatchObject({ category: 'design', confidence: 0.2 });
    expect(r.final.category).toBe('code_complex');
    expect(r.steps).toEqual(['low-confidence-inherit']);
  });

  it('fallback-inherit: raw says fallback, final is the previous category', async () => {
    await classifyPrompt(
      'dl fallback inherit unique prompt number six here',
      cloud(['p/m1'], [ok('fallback', 0.9)], { context: { lastCategory: 'design' } }),
    );
    const [r] = records();
    expect(r.raw.category).toBe('fallback');
    expect(r.final.category).toBe('design');
    expect(r.steps).toEqual(['fallback-inherit']);
  });

  it('chain: skipped (registry, credentials), failed (class only, no body), ok', async () => {
    const opts = cloud(
      ['p/missing', 'q/nocred', 'r/rate', 's/bad', 't/good'],
      [
        (ref: string) =>
          ref === 'r/rate'
            ? { errorMessage: '429: {"message":"SECRETBODY free-models-per-day"}', stopReason: 'error', content: [] }
            : ref === 's/bad'
              ? reply({ category: 'banana', reason: 'x', confidence: 0.9 })
              : reply({ category: 'standard', reason: 'x', confidence: 0.9 }),
      ],
      {
        findModel: (ref: string) => (ref === 'p/missing' ? undefined : modelFor(ref)),
        hasConfiguredAuth: (m: any) => m.provider !== 'q',
      },
    );
    // the answer function dispatches on ref — one answerer for every call
    opts.completeSimple.mockImplementation(async (m: any) => {
      const ref = `${m.provider}/${m.id}`;
      return ref === 'r/rate'
        ? { errorMessage: '429: {"message":"SECRETBODY free-models-per-day"}', stopReason: 'error', content: [] }
        : ref === 's/bad'
          ? reply({ category: 'banana', reason: 'x', confidence: 0.9 })
          : reply({ category: 'standard', reason: 'x', confidence: 0.9 });
    });
    await classifyPrompt('dl mixed chain unique prompt number seven here', opts);
    const [r] = records();
    expect(r.chain.map((a: any) => [a.ref, a.outcome, a.why ?? null])).toEqual([
      ['p/missing', 'skipped', 'not-in-registry'],
      ['q/nocred', 'skipped', 'no-credentials'],
      ['r/rate', 'failed', 'http-429'],
      ['s/bad', 'failed', 'invalid-category'],
      ['t/good', 'ok', null],
    ]);
    expect(JSON.stringify(r)).not.toContain('SECRETBODY');
  });
});

describe('privacy: store_text', () => {
  const PROMPT = 'dl privacy UNIQUEPROMPTWORD about the quarterly figures';
  const run = (store_text?: string, extra: Record<string, unknown> = {}) =>
    classifyPrompt(PROMPT + ' ' + String(store_text), {
      ...cloud(['p/m1'], [ok('simple', 0.9, 'REASONTEXT mentions UNIQUEPROMPTWORD')]),
      cfg: cfgWith({ enabled: true, ...(store_text ? { store_text } : {}) }),
      context: { previousUserMessage: 'PREVMESSAGE text', lastAssistantSnippet: 'SNIPPETTEXT here' },
      ...extra,
    } as any);

  it('"none" (and the unset default): no prompt-derived text anywhere in the record', async () => {
    await run('none');
    await run(undefined);
    for (const r of records()) {
      const s = JSON.stringify(r);
      for (const leak of ['UNIQUEPROMPTWORD', 'REASONTEXT', 'PREVMESSAGE', 'SNIPPETTEXT']) expect(s).not.toContain(leak);
      expect(r.input.text).toBeNull();
      expect(r.input.chars).toBeGreaterThan(10);
      expect(r.input.sha).toMatch(/^[0-9a-f]{12}$/);
      expect(r.raw.reason).toBeNull();
      expect(r.final.reason).toBeNull();
    }
    expect(records()).toHaveLength(2);
  });

  it('"snippet": prompt prefix capped at 120 chars, no context texts', async () => {
    const long = 'x'.repeat(300);
    await classifyPrompt('dl snippet ' + long, { ...cloud(['p/m1'], [ok('simple')]), cfg: cfgWith({ enabled: true, store_text: 'snippet' }) });
    const [r] = records();
    expect(r.input.text.prompt.length).toBe(120);
    expect(r.input.text.prompt.startsWith('dl snippet xxx')).toBe(true);
    expect(r.input.text.previousUserMessage).toBeUndefined();
  });

  it('"full": prompt and both context texts (replay input), reasons included', async () => {
    await run('full');
    const [r] = records();
    expect(r.input.text.prompt).toContain('UNIQUEPROMPTWORD');
    expect(r.input.text.previousUserMessage).toBe('PREVMESSAGE text');
    expect(r.input.text.lastAssistantSnippet).toBe('SNIPPETTEXT here');
    expect(r.raw.reason).toContain('REASONTEXT');
  });
});

describe('switches and robustness', () => {
  it('no cfg, no classifier_log block, or enabled:false → nothing is written', async () => {
    await classifyPrompt('dl switch no cfg at all unique prompt eight', { ...cloud(['p/m1'], [ok('simple')]), cfg: undefined });
    await classifyPrompt('dl switch absent block unique prompt nine', {
      ...cloud(['p/m1'], [ok('simple')]),
      cfg: { providers: {}, model_groups: {}, model_metrics: {} } as Config,
    });
    await classifyPrompt('dl switch disabled unique prompt ten here', { ...cloud(['p/m1'], [ok('simple')]), cfg: cfgWith({ enabled: false }) });
    expect(existsSync(logFile())).toBe(false);
  });

  it('fail-open: an unwritable log location never changes the classification', async () => {
    writeFileSync(join(homedir(), '.pi'), 'a file where the log directory should be');
    const result = await classifyPrompt('dl fail open unique prompt number eleven', cloud(['p/m1'], [ok('planning')]));
    expect(result).toMatchObject({ category: 'planning' });
  });

  it('overlapping calls keep separate chains (subagent fan-out)', async () => {
    const slow = cloud(['slow/a'], [ok('simple')]);
    slow.completeSimple.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return reply({ category: 'simple', reason: 'x', confidence: 0.9 });
    });
    const fast = cloud(['fast/b'], [ok('design')]);
    await Promise.all([
      classifyPrompt('dl overlap slow unique prompt number twelve', slow),
      classifyPrompt('dl overlap fast unique prompt number thirteen', fast),
    ]);
    const byAnswer = Object.fromEntries(records().map((r) => [r.answered_by, r.chain.map((a: any) => a.ref)]));
    expect(byAnswer).toEqual({ 'cloud:slow/a': ['slow/a'], 'cloud:fast/b': ['fast/b'] });
  });

  it('size rotation: max_bytes/keep from classifier_log', async () => {
    const cfg = cfgWith({ enabled: true, store_text: 'none', max_bytes: 600, keep: 2 });
    for (let i = 0; i < 4; i++) {
      await classifyPrompt(`dl rotation unique prompt number ${i} padding words`, { ...cloud(['p/m1'], [ok('simple')]), cfg });
    }
    expect(existsSync(logFile() + '.1')).toBe(true);
    expect(existsSync(logFile() + '.2')).toBe(false);
  });

  it('the file is private (0600) and every line is valid JSON', async () => {
    await classifyPrompt('dl file mode unique prompt number fourteen', cloud(['p/m1'], [ok('simple')]));
    expect(statSync(logFile()).mode & 0o777).toBe(0o600);
    expect(records()).toHaveLength(1);
    expect(records()[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof records()[0].proc).toBe('string');
  });
});
