import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyGroupFilters } from '../src/routing.js';
import * as metricsModule from '../src/metrics.js';
import type { Cache, Group, Config } from '../src/types.js';

// Prime the metrics module's cache so lookupContextWindow(ref) resolves
// from cache.available_models[].capabilities.contextWindow exactly as it
// does in production.
const CACHE: Cache = {
  available_models: [
    { id: 'small-ctx', provider: 'mistral', cost_per_m: 0, capabilities: { contextWindow: 8_000 } },
    { id: 'big-ctx', provider: 'mistral', cost_per_m: 0, capabilities: { contextWindow: 256_000 } },
    { id: 'no-ctx', provider: 'mistral', cost_per_m: 0 }, // unknown context
  ],
};

const CFG: Config = { model_groups: {}, model_metrics: {}, providers: {} };

const REFS = ['mistral/small-ctx', 'mistral/big-ctx', 'mistral/no-ctx'];

describe('applyGroupFilters — min_context_length', () => {
  beforeAll(() => {
    metricsModule.setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
    metricsModule.setCache(CACHE);
  });
  afterAll(() => {
    metricsModule.setCache({});
  });

  it('is a no-op when min_context_length is absent (regression guard)', () => {
    const g: Group = { method: 'best' };
    expect(applyGroupFilters(REFS, g, CFG)).toEqual(REFS);
  });

  it('is a no-op when min_context_length is 0', () => {
    const g: Group = { method: 'best', min_context_length: 0 };
    expect(applyGroupFilters(REFS, g, CFG)).toEqual(REFS);
  });

  it('drops models below the threshold', () => {
    const g: Group = { method: 'best', min_context_length: 100_000 };
    expect(applyGroupFilters(REFS, g, CFG)).toEqual(['mistral/big-ctx']);
  });

  it('drops models with unknown context window (strict, like min_gdpval)', () => {
    const g: Group = { method: 'best', min_context_length: 5_000 };
    // small-ctx (8k) passes; big-ctx (256k) passes; no-ctx (unknown) is dropped.
    expect(applyGroupFilters(REFS, g, CFG)).toEqual([
      'mistral/small-ctx',
      'mistral/big-ctx',
    ]);
  });

  it('drops everything when no model meets the threshold', () => {
    const g: Group = { method: 'best', min_context_length: 1_000_000 };
    expect(applyGroupFilters(REFS, g, CFG)).toEqual([]);
  });
});
