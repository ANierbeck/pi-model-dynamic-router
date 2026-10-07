// test/classifier-derived-flow.test.ts
// ADR-0025 C2: the classification flow takes its local models from the
// derived chain (user pin > cache.classifier_local_models > provisional >
// none) and never from a shipped default. Fixtures use made-up model names;
// every assertion also pins that the two former shipped defaults are never
// called.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/ollama-utils', () => ({
  callOllama: vi.fn(),
  isOllamaAvailable: vi.fn(async () => true),
}));

import { callOllama, isOllamaAvailable } from '../src/ollama-utils';
import { classifyPrompt, getLastClassificationSource } from '../src/content-classifier.ts';
import { SessionEscalation, detectLoopWithLLM } from '../src/escalation.ts';
import { formatClassifierStatus } from '../src/commands.ts';
import type { Cache, Group } from '../src/types.ts';

const OLD_DEFAULTS = ['mistral-nemo:latest', 'gemma2:2b'];
const VALID = JSON.stringify({ category: 'trivial', reason: 'test', confidence: 0.9 });
const NO_SCHEMA_501 = 'Ollama HTTP 501: {"error":"structured output is unavailable"}';

// capabilities.completion: the provisional (pre-probe) path only admits
// models the scan has EXPLICITLY seen answering completions (review M7).
const ollama = (id: string) => ({ id, provider: 'ollama', cost_per_m: 0, capabilities: { completion: true } });
const cacheWith = (...ids: string[]): Cache => ({ available_models: ids.map(ollama) }) as Cache;
const calledModels = () => vi.mocked(callOllama).mock.calls.map((c) => c[0]);

// classifyPrompt caches results by raw prompt for 5 minutes — keep prompts unique.
let n = 0;
const prompt = (tag: string) => `derived-flow ${tag} ${++n} please list the modules`;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isOllamaAvailable).mockResolvedValue(true);
});

describe('classifyPrompt — local models come from the derived chain', () => {
  it('a machine whose only local model is foo:3b classifies with foo:3b, never the old defaults', async () => {
    vi.mocked(callOllama).mockResolvedValue(VALID);
    const r = await classifyPrompt(prompt('only-foo'), { cache: cacheWith('foo:3b') });
    expect(r.category).toBe('trivial');
    expect(calledModels()).toEqual(['foo:3b']);
    for (const old of OLD_DEFAULTS) expect(calledModels()).not.toContain(old);
    expect(getLastClassificationSource()?.source).toBe('ollama:foo:3b');
  });

  it('uses the probed list heads: primary first, fallback after a failure', async () => {
    vi.mocked(callOllama).mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(VALID);
    const cache = cacheWith('foo:3b', 'bar:9b');
    cache.classifier_local_models = ['bar:9b', 'foo:3b'];
    await classifyPrompt(prompt('probed-heads'), { cache });
    expect(calledModels()).toEqual(['bar:9b', 'foo:3b']);
  });

  it('a user pin wins over the derived head', async () => {
    vi.mocked(callOllama).mockResolvedValue(VALID);
    await classifyPrompt(prompt('pin'), { cache: cacheWith('foo:3b'), model: 'pinned:7b' });
    expect(calledModels()[0]).toBe('pinned:7b');
  });

  it('a 501 on the derived primary marks it and moves to the derived fallback', async () => {
    vi.mocked(callOllama).mockRejectedValueOnce(new Error(NO_SCHEMA_501)).mockResolvedValueOnce(VALID);
    const cache = cacheWith('foo:3b', 'bar:9b');
    await classifyPrompt(prompt('501'), { cache });
    expect(calledModels()).toEqual(['foo:3b', 'bar:9b']);
    expect(typeof cache.classifier_no_schema?.['foo:3b']).toBe('number');
  });

  it('with a single local model there is no fallback hop to the same model', async () => {
    vi.mocked(callOllama).mockRejectedValue(new Error('timeout'));
    await classifyPrompt(prompt('single'), { cache: cacheWith('foo:3b'), allowStaticFallback: true });
    expect(calledModels()).toEqual(['foo:3b']);
  });

  it('no local models: the cloud leg answers first, with no Ollama availability hop', async () => {
    const completeSimple = vi.fn(async () => ({ content: [{ type: 'text', text: VALID }], stopReason: 'stop' }));
    const r = await classifyPrompt(prompt('no-local-cloud'), {
      allowCloudFallback: true,
      cfg: { model_groups: {} } as any,
      cache: { classifier_fallback_models: ['acme/judge-1'] } as Cache,
      completeSimple,
      findModel: () => ({}),
    });
    expect(r.category).toBe('trivial');
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(isOllamaAvailable).not.toHaveBeenCalled();
    expect(callOllama).not.toHaveBeenCalled();
  });

  it('no local models and cloud failing: no Ollama hop either, static classifier answers', async () => {
    const r = await classifyPrompt(prompt('no-local-static'), { cache: {} as Cache, allowStaticFallback: true });
    expect(r.category).toBeTruthy();
    expect(isOllamaAvailable).not.toHaveBeenCalled();
    expect(callOllama).not.toHaveBeenCalled();
  });
});

describe('SessionEscalation / detectLoopWithLLM — no model, no LLM leg', () => {
  const history = [
    { prompt: 'same ask', response: 'same answer' },
    { prompt: 'same ask', response: 'same answer' },
  ];

  it('detectLoopWithLLM without a model skips the daemon entirely (rule-based path only)', async () => {
    const r = await detectLoopWithLLM(history, {});
    expect(r.shouldEscalate).toBe(false);
    expect(isOllamaAvailable).not.toHaveBeenCalled();
    expect(callOllama).not.toHaveBeenCalled();
  });

  it('a SessionEscalation with no derived model never dispatches the LLM check', async () => {
    const esc = new SessionEscalation();
    for (let i = 0; i < 3; i++) esc.recordTurn('same ask', 'same answer');
    await new Promise((r) => setTimeout(r, 10));
    expect(callOllama).not.toHaveBeenCalled();
  });

  it('a model source resolved at call time feeds the loop check (head of the derived list)', async () => {
    vi.mocked(callOllama).mockResolvedValue('{"shouldEscalate": false, "reason": "ok"}');
    const esc = new SessionEscalation();
    esc.setClassifierModel(() => 'foo:3b');
    for (let i = 0; i < 3; i++) esc.recordTurn('same ask', 'same answer');
    await new Promise((r) => setTimeout(r, 10));
    expect(calledModels()).toContain('foo:3b');
  });
});

describe('formatClassifierStatus — derived heads, no shipped defaults', () => {
  const group = { name: 'dynamic', method: 'dynamic', models: [] } as unknown as Group;
  const chainLine = (input: Partial<Parameters<typeof formatClassifierStatus>[0]>) =>
    formatClassifierStatus({ group, last: null, probedCount: 0, ollamaUp: true, ...input }).find((l) => l.includes('Chain:')) ?? '';

  it('shows the derived heads', () => {
    const line = chainLine({ localChain: { primary: 'foo:3b', fallback: 'bar:9b' }, localProbed: true });
    expect(line).toContain('Ollama (up: foo:3b → bar:9b)');
  });

  it('marks provisional (unprobed) heads', () => {
    expect(chainLine({ localChain: { primary: 'foo:3b' }, localProbed: false })).toContain('foo:3b (unprobed)');
  });

  it('says "none yet" when nothing is derived, and never prints the old defaults', () => {
    const line = chainLine({});
    expect(line).toContain('none yet');
    for (const old of OLD_DEFAULTS) expect(line).not.toContain(old);
  });

  it('says "none qualified" after a probe where nothing passed (review N2)', () => {
    // A probe ran (localProbed: true) and every candidate failed: the empty
    // result is final — the status names the recovery paths instead of
    // pretending no probe ever happened.
    const line = chainLine({ localProbed: true });
    expect(line).toContain('none qualified');
    expect(line).not.toContain('none yet');
  });
});
