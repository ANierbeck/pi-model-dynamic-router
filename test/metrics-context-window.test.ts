import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { lookupContextWindow, setConfig, setCache } from '../src/metrics.js';
import type { Cache } from '../src/types.js';

describe('lookupContextWindow', () => {
  beforeAll(() => {
    setConfig({ model_groups: {}, model_metrics: {}, providers: {} });
    const cache: Cache = {
      available_models: [
        { id: 'glm-5-2', provider: 'mistral', cost_per_m: 0, capabilities: { contextWindow: 128_000 } },
        { id: 'gemma-4-31b-it:free', provider: 'openrouter', cost_per_m: 0, capabilities: { contextWindow: 262_144 } },
        // No capabilities → unknown context window.
        { id: 'unknown-ctx-model', provider: 'openrouter', cost_per_m: 0 },
      ],
    };
    setCache(cache);
  });

  afterAll(() => {
    setCache({});
  });

  test('returns the scanned contextWindow for a known mistral model', () => {
    expect(lookupContextWindow('mistral/glm-5-2')).toBe(128_000);
  });

  test('returns the scanned contextWindow for a known openrouter model', () => {
    expect(lookupContextWindow('openrouter/gemma-4-31b-it:free')).toBe(262_144);
  });

  test('returns null when the model has no scanned capabilities', () => {
    expect(lookupContextWindow('openrouter/unknown-ctx-model')).toBeNull();
  });

  test('returns null when the model ref is not in available_models at all', () => {
    expect(lookupContextWindow('openrouter/never-scanned')).toBeNull();
  });
});
