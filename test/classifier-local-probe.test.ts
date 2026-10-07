// test/classifier-local-probe.test.ts
// ADR-0025 Phase C1: the local classifier chain is DERIVED from the models
// Ollama reports (cache.available_models), verified by the shared
// classification probe, and persisted as cache.classifier_local_models.
// No model literal in the shipped code decides anything here — the fixtures
// use made-up names (foo:3b, bar:9b …) precisely so a hidden default cannot
// pass these tests by accident.

import { describe, it, expect, vi } from 'vitest';
import {
  selectLocalClassifierCandidates,
  probeLocalClassifierCandidates,
  resolveLocalClassifierChain,
  isMarkedNoSchema,
  type LocalProbeDeps,
} from '../src/classifier-local-probe.ts';
import { recordBlocklistFailure } from '../src/model-blocklist.ts';
import type { Cache, Config } from '../src/types.ts';

const cfg = { model_groups: {}, model_metrics: {} } as Config;
const NO_SCHEMA_501 = 'Ollama HTTP 501: {"error":"structured output is unavailable"}';

const ollama = (id: string, capabilities?: Record<string, unknown>) => ({
  id,
  provider: 'ollama',
  cost_per_m: 0,
  ...(capabilities ? { capabilities } : {}),
});

function cacheWith(...models: ReturnType<typeof ollama>[]): Cache {
  return { available_models: models } as Cache;
}

/** Answers every probe case with an accepted category (case-aware, like the cloud probe test). */
function goodReply(prompt: string): string {
  if (prompt.includes('What is in this file?')) return JSON.stringify({ category: 'trivial', reason: 'r', confidence: 0.9 });
  if (prompt.includes('Fix the typo in line 3')) return JSON.stringify({ category: 'code_simple', reason: 'r', confidence: 0.9 });
  return JSON.stringify({ category: 'simple', reason: 'r', confidence: 0.9 });
}

function deps(impl: (model: string, prompt: string) => Promise<string>): LocalProbeDeps & { callOllama: ReturnType<typeof vi.fn> } {
  return { callOllama: vi.fn(async (m: string, p: string) => impl(m, p)), isAvailable: async () => true };
}

describe('selectLocalClassifierCandidates — derivation from the registry', () => {
  it('orders by parameter size ascending, regardless of registry order', () => {
    const cache = cacheWith(ollama('bar:9b'), ollama('foo:3b'), ollama('baz:27b'));
    expect(selectLocalClassifierCandidates(cache, cfg)).toEqual(['foo:3b', 'bar:9b', 'baz:27b']);
  });

  it('prefers the size Ollama reported over the size parsed from the id', () => {
    const cache = cacheWith(ollama('tagless:latest', { parameterSizeB: 1.5 }), ollama('foo:3b'));
    expect(selectLocalClassifierCandidates(cache, cfg)).toEqual(['tagless:latest', 'foo:3b']);
  });

  it('sorts size-unknown models after sized ones, by name', () => {
    const cache = cacheWith(ollama('zeta:latest'), ollama('alpha:latest'), ollama('foo:3b'));
    expect(selectLocalClassifierCandidates(cache, cfg)).toEqual(['foo:3b', 'alpha:latest', 'zeta:latest']);
  });

  it('breaks size ties by name (deterministic)', () => {
    const cache = cacheWith(ollama('b-model:7b'), ollama('a-model:7b'));
    expect(selectLocalClassifierCandidates(cache, cfg)).toEqual(['a-model:7b', 'b-model:7b']);
  });

  it('drops embedding-only and non-completion models, keeps unknown-capability ones', () => {
    const cache = cacheWith(
      ollama('emb:1b', { embedding: true }),
      ollama('noncompl:2b', { completion: false }),
      ollama('chat:3b', { completion: true }),
      ollama('unknown:4b'),
    );
    expect(selectLocalClassifierCandidates(cache, cfg)).toEqual(['chat:3b', 'unknown:4b']);
  });

  it('ignores non-local providers entirely', () => {
    const cache = { available_models: [{ id: 'cloud-x:1b', provider: 'openrouter', cost_per_m: 0 }, ollama('foo:3b')] } as Cache;
    expect(selectLocalClassifierCandidates(cache, cfg)).toEqual(['foo:3b']);
  });

  it('drops models marked no-structured-output within the TTL, keeps them after it', () => {
    const cache = cacheWith(ollama('foo:3b'), ollama('bar:9b'));
    cache.classifier_no_schema = { 'foo:3b': Date.now() };
    expect(selectLocalClassifierCandidates(cache, cfg)).toEqual(['bar:9b']);
    cache.classifier_no_schema = { 'foo:3b': Date.now() - 25 * 60 * 60_000 };
    expect(selectLocalClassifierCandidates(cache, cfg)).toEqual(['foo:3b', 'bar:9b']);
  });

  it('drops excluded and blocklisted models', () => {
    const cache = cacheWith(ollama('foo:3b'), ollama('bar:9b'), ollama('baz:27b'));
    recordBlocklistFailure(cache, 'ollama/baz:27b', 'HTTP 404: model does not support tools');
    const excluding = { ...cfg, exclude: { models: ['ollama/bar:9b'] } } as Config;
    const result = selectLocalClassifierCandidates(cache, excluding);
    expect(result).toContain('foo:3b');
    expect(result).not.toContain('bar:9b');
  });

  it('returns an empty list when Ollama has no models (chain proceeds to cloud/static)', () => {
    expect(selectLocalClassifierCandidates({} as Cache, cfg)).toEqual([]);
    expect(selectLocalClassifierCandidates(cacheWith(), cfg)).toEqual([]);
  });
});

describe('probeLocalClassifierCandidates — verified, persisted chain', () => {
  it('persists the working list in size order: foo:3b primary, bar:9b fallback', async () => {
    const cache = cacheWith(ollama('bar:9b'), ollama('foo:3b'));
    const d = deps(async (_m, p) => goodReply(p));
    const working = await probeLocalClassifierCandidates(cfg, cache, d);
    expect(working).toEqual(['foo:3b', 'bar:9b']);
    expect(cache.classifier_local_models).toEqual(['foo:3b', 'bar:9b']);
  });

  it('skips a model answering 501 AND marks it in classifier_no_schema', async () => {
    const cache = cacheWith(ollama('foo:3b'), ollama('bar:9b'));
    const d = deps(async (m, p) => {
      if (m === 'foo:3b') throw new Error(NO_SCHEMA_501);
      return goodReply(p);
    });
    const working = await probeLocalClassifierCandidates(cfg, cache, d);
    expect(working).toEqual(['bar:9b']);
    expect(cache.classifier_local_models).toEqual(['bar:9b']);
    expect(isMarkedNoSchema(cache, 'foo:3b')).toBe(true);
    expect(typeof cache.classifier_no_schema?.['foo:3b']).toBe('number');
  });

  it('does not probe a model that is already marked no-schema within the TTL', async () => {
    const cache = cacheWith(ollama('foo:3b'), ollama('bar:9b'));
    cache.classifier_no_schema = { 'foo:3b': Date.now() };
    const d = deps(async (_m, p) => goodReply(p));
    await probeLocalClassifierCandidates(cfg, cache, d);
    expect(d.callOllama.mock.calls.map((c) => c[0])).not.toContain('foo:3b');
  });

  it('rejects a model that misclassifies a probe case (quality, not reachability)', async () => {
    const cache = cacheWith(ollama('foo:3b'), ollama('bar:9b'));
    const d = deps(async (m, p) => (m === 'foo:3b' ? '{"category":"design","reason":"r","confidence":0.9}' : goodReply(p)));
    expect(await probeLocalClassifierCandidates(cfg, cache, d)).toEqual(['bar:9b']);
  });

  it('rejects a model that echoes a HINT out of the narration trap', async () => {
    const cache = cacheWith(ollama('foo:3b'));
    const d = deps(async (_m, p) =>
      p.includes('Explain what a closure')
        ? '{"category":"hint:group:tactical","reason":"copied","confidence":0.9}'
        : goodReply(p)
    );
    expect(await probeLocalClassifierCandidates(cfg, cache, d)).toEqual([]);
  });

  it('bounds the probe: stops once enough working models are found', async () => {
    const cache = cacheWith(...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) => ollama(`${n}:${i + 1}b`)));
    const d = deps(async (_m, p) => goodReply(p));
    const working = await probeLocalClassifierCandidates(cfg, cache, d);
    expect(working.length).toBeLessThanOrEqual(3);
    expect(working[0]).toBe('a:1b');
  });

  it('empty registry: empty list, no Ollama call at all', async () => {
    const cache = {} as Cache;
    const d = deps(async (_m, p) => goodReply(p));
    expect(await probeLocalClassifierCandidates(cfg, cache, d)).toEqual([]);
    expect(cache.classifier_local_models).toEqual([]);
    expect(d.callOllama).not.toHaveBeenCalled();
  });

  it('daemon down: keeps the previous list untouched (no wipe on a transient outage)', async () => {
    const cache = cacheWith(ollama('foo:3b'));
    cache.classifier_local_models = ['foo:3b'];
    const d = { ...deps(async (_m, p) => goodReply(p)), isAvailable: async () => false };
    expect(await probeLocalClassifierCandidates(cfg, cache, d)).toEqual(['foo:3b']);
    expect(cache.classifier_local_models).toEqual(['foo:3b']);
    expect(d.callOllama).not.toHaveBeenCalled();
  });

  it('a timeout or load error is not a no-schema mark', async () => {
    const cache = cacheWith(ollama('foo:3b'));
    const d = deps(async () => {
      throw new Error('The operation was aborted due to timeout');
    });
    expect(await probeLocalClassifierCandidates(cfg, cache, d)).toEqual([]);
    expect(cache.classifier_no_schema).toBeUndefined();
  });
});

describe('resolveLocalClassifierChain — pin › probed list › provisional › none', () => {
  it('uses the probed list heads', () => {
    const cache = cacheWith(ollama('foo:3b'), ollama('bar:9b'));
    cache.classifier_local_models = ['bar:9b', 'foo:3b'];
    expect(resolveLocalClassifierChain(cache, cfg)).toEqual({ primary: 'bar:9b', fallback: 'foo:3b' });
  });

  it('user pins win per slot and are never duplicated into the derived slot', () => {
    const cache = cacheWith(ollama('foo:3b'), ollama('bar:9b'));
    cache.classifier_local_models = ['foo:3b', 'bar:9b'];
    expect(resolveLocalClassifierChain(cache, cfg, { model: 'pin:1b' })).toEqual({ primary: 'pin:1b', fallback: 'foo:3b' });
    expect(resolveLocalClassifierChain(cache, cfg, { fallbackModel: 'pin:1b' })).toEqual({ primary: 'foo:3b', fallback: 'pin:1b' });
    expect(resolveLocalClassifierChain(cache, cfg, { model: 'foo:3b' })).toEqual({ primary: 'foo:3b', fallback: 'bar:9b' });
  });

  it('provisional: before the first probe, the smallest completion-capable model leads', () => {
    const cache = cacheWith(ollama('bar:9b'), ollama('foo:3b'));
    expect(resolveLocalClassifierChain(cache, cfg)).toEqual({ primary: 'foo:3b', fallback: 'bar:9b' });
  });

  it('none: no local models and no pins leaves both slots empty', () => {
    expect(resolveLocalClassifierChain({} as Cache, cfg)).toEqual({});
    expect(resolveLocalClassifierChain(undefined, undefined)).toEqual({});
  });

  it('a single local model yields a primary and no fallback', () => {
    expect(resolveLocalClassifierChain(cacheWith(ollama('foo:3b')), cfg)).toEqual({ primary: 'foo:3b' });
  });

  it('skips a probed head that was marked no-schema after the probe ran', () => {
    const cache = cacheWith(ollama('foo:3b'), ollama('bar:9b'));
    cache.classifier_local_models = ['foo:3b', 'bar:9b'];
    cache.classifier_no_schema = { 'foo:3b': Date.now() };
    expect(resolveLocalClassifierChain(cache, cfg)).toEqual({ primary: 'bar:9b' });
  });
});
