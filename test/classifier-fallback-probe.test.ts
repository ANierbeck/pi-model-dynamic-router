// test/classifier-fallback-probe.test.ts
// Tests for the dynamic, probe-based classifier fallback discovery.
//
// Replaces the old hardcoded CURATED_FREE_MODELS tests. The probe module
// discovers cheap + low-gdpval candidates from the scan cache, probes each
// at scan time, and caches the verified-working ones — works for ANY user's
// provider setup, not just one user with mistral-zai/mistral-small-latest.

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import {
  selectClassifierCandidates,
  getCachedFallbackModels,
  probeAndCache,
  hasProbedFallback,
  type ProbeContext,
} from '../src/classifier-fallback-probe.js';
import * as metrics from '../src/metrics.js';
import type { Config, Cache } from '../src/types.ts';

function seedMetrics(cfg: Config, cache: Cache) {
  metrics.setConfig(cfg);
  metrics.setCache(cache);
}

const baseCfg: Config = {
  providers: {
    openrouter: { keys: [{ key: 'test-key' }] },
    mistral: { keys: [{ key: 'test-key' }] },
    'mistral-zai': { keys: [{ key: 'test-key' }] },
  },
  model_groups: {},
  model_metrics: {},
};

describe('selectClassifierCandidates', () => {
  beforeEach(() => {
    seedMetrics(baseCfg, {});
  });
  afterEach(() => {
    metrics.setConfig({ model_groups: {}, model_metrics: {}, providers: {} });
    metrics.setCache({});
  });

  it('excludes local providers (ollama, lm-studio) — they are the primary path, not fallback', () => {
    const cache: Cache = {
      available_models: [
        { id: 'gemma2:2b', provider: 'ollama', cost_per_m: 0 },
        { id: 'qwen:7b', provider: 'lm-studio', cost_per_m: 0 },
        // One cloud model with real pricing
        { id: 'glm-5.2:free', provider: 'openrouter', cost_per_m: 0 },
      ],
      openrouter_pricing: { 'openrouter/glm-5.2:free': { input: 0, output: 0 } },
    };
    seedMetrics(baseCfg, cache);
    const result = selectClassifierCandidates(baseCfg, cache);
    expect(result).not.toContain('ollama/gemma2:2b');
    expect(result).not.toContain('lm-studio/qwen:7b');
    expect(result).toContain('openrouter/glm-5.2:free');
  });

  it('tiers: cheap+known-low-gdpval (Tier A) comes before cheap+unknown-gdpval (Tier B)', () => {
    const cache: Cache = {
      available_models: [
        // Tier B: real price, no gdpval
        { id: 'cheap-unknown', provider: 'openrouter', cost_per_m: 0 },
        // Tier A: real price + low gdpval (via model_score_cache → gdpval_scores)
        { id: 'cheap-scored', provider: 'openrouter', cost_per_m: 0 },
      ],
      openrouter_pricing: {
        'openrouter/cheap-unknown': { input: 0, output: 0.05 },
        'openrouter/cheap-scored': { input: 0, output: 0.10 },
      },
      // Map cheap-scored to a gdpval slug with a low score
      model_score_cache: { 'openrouter/cheap-scored': 'cheap-scored-slug' },
      gdpval_scores: { 'cheap-scored-slug': 400 },
    };
    seedMetrics(baseCfg, cache);
    const result = selectClassifierCandidates(baseCfg, cache);
    // Tier A (cheap-scored) comes first despite being more expensive — low gdpval
    // means it is "low-level but not too low-level", the ideal classification model.
    expect(result[0]).toBe('openrouter/cheap-scored');
    expect(result[1]).toBe('openrouter/cheap-unknown');
  });

  it('tiering degrades gracefully when NO models have gdpval (Tier B + C only)', () => {
    // Regression: a strict "cheap AND low-gdpval" filter yields ZERO candidates
    // for most users (gdpval is sparse — ~27/121 models scored in a typical
    // scan). The tiered approach still returns candidates via Tier B/C.
    const cache: Cache = {
      available_models: [
        // No gdpval anywhere. Tier B (cheap) and Tier C (placeholder $0) fill in.
        { id: 'free-model', provider: 'openrouter', cost_per_m: 0 },
        { id: 'mistral-model', provider: 'mistral-zai', cost_per_m: 0 },
      ],
      openrouter_pricing: { 'openrouter/free-model': { input: 0, output: 0 } },
    };
    seedMetrics(baseCfg, cache);
    const result = selectClassifierCandidates(baseCfg, cache);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('openrouter/free-model');
    expect(result).toContain('mistral-zai/mistral-model');
  });

  it('excludes models currently marked unhealthy (failed >=2x recently)', () => {
    const cache: Cache = {
      available_models: [
        { id: 'healthy-model', provider: 'openrouter', cost_per_m: 0 },
        { id: 'broken-model', provider: 'openrouter', cost_per_m: 0 },
      ],
      openrouter_pricing: {
        'openrouter/healthy-model': { input: 0, output: 0 },
        'openrouter/broken-model': { input: 0, output: 0 },
      },
      // broken-model failed 3x recently (UNHEALTHY_AT=2)
      model_health: {
        'openrouter/broken-model': { fails: 3, last_fail: Date.now() },
      },
    };
    seedMetrics(baseCfg, cache);
    const result = selectClassifierCandidates(baseCfg, cache);
    expect(result).toContain('openrouter/healthy-model');
    expect(result).not.toContain('openrouter/broken-model');
  });

  it('respects maxCandidates (bounds probe latency)', () => {
    // Generate 30 cheap models — should cap at maxCandidates
    const models = Array.from({ length: 30 }, (_, i) => ({
      id: `model-${i}`,
      provider: 'openrouter',
      cost_per_m: 0,
    }));
    const pricing: Cache['openrouter_pricing'] = {};
    for (const m of models) pricing[`openrouter/${m.id}`] = { input: 0, output: 0 };
    const cache: Cache = { available_models: models, openrouter_pricing: pricing };
    seedMetrics(baseCfg, cache);
    const result = selectClassifierCandidates(baseCfg, cache, { maxCandidates: 5 });
    expect(result.length).toBe(5);
  });

  it('interleaves providers round-robin so one provider cannot monopolize the list', () => {
    // Regression (2026-09-02): OpenRouter free-tier daily limit was exhausted
    // (429 on all :free models) + guardrails blocked others (404). With a
    // strict tier-then-provider order, the 12 Tier-B OpenRouter candidates
    // filled every slot, so Tier-C Mistral models (with a working key) were
    // never probed → 0 working models → classifier fell through to a heavy
    // fallback model for every prompt. Round-robin by provider prevents this.
    const cache: Cache = {
      available_models: [
        // 5 cheap OpenRouter models (Tier B — real price, no gdpval)
        ...Array.from({ length: 5 }, (_, i) => ({ id: `or-${i}`, provider: 'openrouter', cost_per_m: 0 })),
        // 5 placeholder-$0 Mistral models (Tier C — no real pricing)
        ...Array.from({ length: 5 }, (_, i) => ({ id: `mistral-${i}`, provider: 'mistral', cost_per_m: 0 })),
      ],
      openrouter_pricing: Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`openrouter/or-${i}`, { input: 0, output: 0 }])
      ),
    };
    seedMetrics(baseCfg, cache);
    const result = selectClassifierCandidates(baseCfg, cache, { maxCandidates: 8 });
    // Round-robin: first half should be a mix of openrouter + mistral, not
    // 5 openrouter followed by 3 mistral.
    const firstFourProviders = result.slice(0, 4).map((r) => r.split('/')[0]);
    const orCount = firstFourProviders.filter((p) => p === 'openrouter').length;
    const mistralCount = firstFourProviders.filter((p) => p === 'mistral').length;
    expect(orCount).toBe(2);
    expect(mistralCount).toBe(2);
    expect(result.length).toBe(8);
  });

  it('excludes models with real price ABOVE the threshold (too expensive for classification)', () => {
    const cache: Cache = {
      available_models: [
        { id: 'cheap', provider: 'openrouter', cost_per_m: 0 },
        { id: 'expensive', provider: 'openrouter', cost_per_m: 10 },
      ],
      openrouter_pricing: {
        'openrouter/cheap': { input: 0, output: 0.05 },
        'openrouter/expensive': { input: 5, output: 15 },
      },
    };
    seedMetrics(baseCfg, cache);
    const result = selectClassifierCandidates(baseCfg, cache, { maxPrice: 5 });
    expect(result).toContain('openrouter/cheap');
    expect(result).not.toContain('openrouter/expensive');
  });
});

describe('probeAndCache', () => {
  beforeEach(() => {
    seedMetrics(baseCfg, {});
  });
  afterEach(() => {
    metrics.setConfig({ model_groups: {}, model_metrics: {}, providers: {} });
    metrics.setCache({});
  });

  it('probes candidates and caches only the ones that respond successfully', async () => {
    const cache: Cache = {
      available_models: [
        { id: 'working-model', provider: 'openrouter', cost_per_m: 0 },
        { id: 'broken-model', provider: 'openrouter', cost_per_m: 0 },
      ],
      openrouter_pricing: {
        'openrouter/working-model': { input: 0, output: 0 },
        'openrouter/broken-model': { input: 0, output: 0 },
      },
    };
    seedMetrics(baseCfg, cache);

    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: ref.split('/')[0], id: ref.split('/')[1] }),
      completeSimple: vi.fn(async (model: any) => {
        if (model.id === 'broken-model') {
          return { errorMessage: '422', stopReason: 'error', content: [] };
        }
        return { errorMessage: undefined, stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] };
      }),
    };
    const logs: string[] = [];
    const result = await probeAndCache(baseCfg, cache, pctx, (m) => logs.push(m));
    expect(result).toContain('openrouter/working-model');
    expect(result).not.toContain('openrouter/broken-model');
    expect(cache.classifier_fallback_models).toEqual(result);
    expect(logs.some((l) => l.includes('working-model OK'))).toBe(true);
    expect(logs.some((l) => l.includes('broken-model failed'))).toBe(true);
  });

  it('skips candidates not in pi registry (findModel returns undefined)', async () => {
    const cache: Cache = {
      available_models: [
        { id: 'registered', provider: 'openrouter', cost_per_m: 0 },
        { id: 'unregistered', provider: 'openrouter', cost_per_m: 0 },
      ],
      openrouter_pricing: {
        'openrouter/registered': { input: 0, output: 0 },
        'openrouter/unregistered': { input: 0, output: 0 },
      },
    };
    seedMetrics(baseCfg, cache);

    const pctx: ProbeContext = {
      findModel: (ref) => (ref === 'openrouter/registered' ? { provider: 'openrouter', id: 'registered' } : undefined),
      completeSimple: vi.fn(async () => ({ errorMessage: undefined, stopReason: 'stop', content: [] })),
    };
    const result = await probeAndCache(baseCfg, cache, pctx);
    expect(result).toContain('openrouter/registered');
    expect(result).not.toContain('openrouter/unregistered');
  });

  it('stops early once MAX_WORKING_MODELS successes are found (bounds probe time)', async () => {
    // 20 cheap models, all working — should stop at MAX_WORKING_MODELS (8)
    const models = Array.from({ length: 20 }, (_, i) => ({
      id: `model-${i}`,
      provider: 'openrouter',
      cost_per_m: 0,
    }));
    const pricing: Cache['openrouter_pricing'] = {};
    for (const m of models) pricing[`openrouter/${m.id}`] = { input: 0, output: 0 };
    const cache: Cache = { available_models: models, openrouter_pricing: pricing };
    seedMetrics(baseCfg, cache);

    let callCount = 0;
    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: 'openrouter', id: ref.split('/')[1] }),
      completeSimple: vi.fn(async () => {
        callCount++;
        return { errorMessage: undefined, stopReason: 'stop', content: [] };
      }),
    };
    const result = await probeAndCache(baseCfg, cache, pctx);
    expect(result.length).toBeLessThanOrEqual(8);
    expect(callCount).toBeLessThanOrEqual(8);
  });

  it('handles probe errors gracefully (candidate skipped, not fatal)', async () => {
    const cache: Cache = {
      available_models: [
        { id: 'throwing-model', provider: 'openrouter', cost_per_m: 0 },
        { id: 'working-model', provider: 'openrouter', cost_per_m: 0 },
      ],
      openrouter_pricing: {
        'openrouter/throwing-model': { input: 0, output: 0 },
        'openrouter/working-model': { input: 0, output: 0 },
      },
    };
    seedMetrics(baseCfg, cache);

    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: ref.split('/')[0], id: ref.split('/')[1] }),
      completeSimple: vi.fn(async (model: any) => {
        if (model.id === 'throwing-model') throw new Error('network error');
        return { errorMessage: undefined, stopReason: 'stop', content: [] };
      }),
    };
    const result = await probeAndCache(baseCfg, cache, pctx, () => {});
    expect(result).toContain('openrouter/working-model');
    expect(result).not.toContain('openrouter/throwing-model');
  });

  // roborev job 445 MEDIUM: probe failures must be fed into the health system
  // so a consistently-broken candidate is excluded from the NEXT scan's
  // selectClassifierCandidates via isUnhealthy (>=2 recent fails).
  it('records probe failures into the health system (so broken candidates are excluded next scan)', async () => {
    const cache: Cache = {
      available_models: [
        { id: 'broken', provider: 'openrouter', cost_per_m: 0 },
        { id: 'ok', provider: 'openrouter', cost_per_m: 0 },
      ],
      openrouter_pricing: {
        'openrouter/broken': { input: 0, output: 0 },
        'openrouter/ok': { input: 0, output: 0 },
      },
    };
    seedMetrics(baseCfg, cache);

    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: ref.split('/')[0], id: ref.split('/')[1] }),
      completeSimple: vi.fn(async (model: any) => {
        if (model.id === 'broken') throw new Error('422');
        return { errorMessage: undefined, stopReason: 'stop', content: [] };
      }),
    };
    await probeAndCache(baseCfg, cache, pctx, () => {});

    // The broken model should now have a recorded failure in the health store.
    const { isUnhealthy } = await import('../src/model-health.js');
    expect(isUnhealthy(cache, 'openrouter/broken')).toBe(false); // only 1 fail so far

    // Probe again — a second failure should push it to unhealthy (>=2 fails).
    await probeAndCache(baseCfg, cache, pctx, () => {});
    expect(isUnhealthy(cache, 'openrouter/broken')).toBe(true);
  });

  it('writes the working list to cache.classifier_fallback_models', async () => {
    const cache: Cache = {
      available_models: [{ id: 'ok', provider: 'openrouter', cost_per_m: 0 }],
      openrouter_pricing: { 'openrouter/ok': { input: 0, output: 0 } },
    };
    seedMetrics(baseCfg, cache);
    expect(cache.classifier_fallback_models).toBeUndefined();
    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: 'openrouter', id: 'ok' }),
      completeSimple: vi.fn(async () => ({ errorMessage: undefined, stopReason: 'stop', content: [] })),
    };
    await probeAndCache(baseCfg, cache, pctx);
    expect(cache.classifier_fallback_models).toEqual(['openrouter/ok']);
  });
});

describe('getCachedFallbackModels + hasProbedFallback', () => {
  it('returns empty array when probe has not run', () => {
    const cache: Cache = {};
    expect(getCachedFallbackModels(cache)).toEqual([]);
    expect(hasProbedFallback(cache)).toBe(false);
  });

  it('returns the cached list when probe has run (even if empty)', () => {
    const cache: Cache = { classifier_fallback_models: ['openrouter/model-a'] };
    expect(getCachedFallbackModels(cache)).toEqual(['openrouter/model-a']);
    expect(hasProbedFallback(cache)).toBe(true);
  });

  it('hasProbedFallback is true even when the probe found nothing (empty array = probe ran)', () => {
    // An empty array is a valid result — means the probe ran but all failed.
    // The classifier should then fall back to selectClassifierCandidates.
    const cache: Cache = { classifier_fallback_models: [] };
    expect(getCachedFallbackModels(cache)).toEqual([]);
    expect(hasProbedFallback(cache)).toBe(true);
  });
});
