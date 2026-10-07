// test/scan-local-classifier-probe.test.ts
// ADR-0025 C1 wiring: a scan that finds Ollama models derives, probes and
// persists the local classifier chain (cache.classifier_local_models) right
// after the cloud probe — end to end through createScanRunner with a faked
// Ollama on global fetch. Made-up model names only.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createScanRunner } from '../src/scan-runner.ts';
import type { Cache, Config } from '../src/types.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeOllama(models: Record<string, { size: string; generate: (prompt: string) => Response }>) {
  return vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith('/api/tags')) {
      return jsonRes({ models: Object.entries(models).map(([name, m]) => ({ name, details: { parameter_size: m.size } })) });
    }
    if (url.endsWith('/api/show')) {
      const { name } = JSON.parse(init.body);
      return jsonRes({ capabilities: ['completion'], details: { parameter_size: models[name].size } });
    }
    if (url.endsWith('/api/generate')) {
      const { model, prompt } = JSON.parse(init.body);
      return models[model].generate(prompt);
    }
    throw new Error(`unexpected fetch ${url}`); // openrouter etc.: scan swallows per-provider failures
  });
}

const classifyReply = (prompt: string) => {
  const category = prompt.includes('What is in this file?') ? 'trivial' : prompt.includes('Fix the typo') ? 'code_simple' : 'simple';
  return jsonRes({ response: JSON.stringify({ category, reason: 'r', confidence: 0.9 }) });
};

function runner(cache: Cache) {
  return createScanRunner({
    cache,
    cacheManager: {} as any,
    cfg: { model_groups: {}, model_metrics: {} } as Config,
    GDPVAL_URL: 'http://127.0.0.1:9/never',
    generateDynamicConfig: async () => {},
    MODELS_TTL: 0,
    saveCache: () => {},
    scanning: false,
    sessionCtx: undefined,
  });
}

describe('scan() → local classifier probe (ADR-0025 C1)', () => {
  it('persists the probed local chain in size order after a scan that found Ollama models', async () => {
    globalThis.fetch = fakeOllama({
      'bar:9b': { size: '9B', generate: (p) => classifyReply(p) },
      'foo:3b': { size: '3B', generate: (p) => classifyReply(p) },
    }) as any;
    const cache = { gdpval_scraped: true } as Cache;
    await runner(cache).scan(true);
    expect(cache.classifier_local_models).toEqual(['foo:3b', 'bar:9b']);
  });

  it('marks a 501 model and leaves it out of the persisted chain', async () => {
    globalThis.fetch = fakeOllama({
      'foo:3b': { size: '3B', generate: () => new Response('{"error":"structured output is unavailable"}', { status: 501 }) },
      'bar:9b': { size: '9B', generate: (p) => classifyReply(p) },
    }) as any;
    const cache = { gdpval_scraped: true } as Cache;
    await runner(cache).scan(true);
    expect(cache.classifier_local_models).toEqual(['bar:9b']);
    expect(typeof cache.classifier_no_schema?.['foo:3b']).toBe('number');
  });
});
