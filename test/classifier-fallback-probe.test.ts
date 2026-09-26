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
  PROBE_CASES,
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

// --- Quality-probe mock helpers -------------------------------------------
// The probe validates the CLASSIFICATION task (not just reachability), so
// test mocks must answer with valid classification JSON per probe case.

/** A successful completeSimple result carrying a valid classification. */
function okReply(category: string) {
  return {
    errorMessage: undefined,
    stopReason: 'stop',
    content: [{ type: 'text', text: JSON.stringify({ category, reason: 'probe reply', confidence: 0.9 }) }],
  };
}

/**
 * Case-aware mock that answers EVERY probe case with an accepted category.
 * Matches on the case prompts' stable marker substrings.
 */
function goodClassifierMock() {
  return vi.fn(async (_model: any, prompt: any) => {
    const content: string = prompt?.messages?.[0]?.content ?? '';
    if (content.includes('What is in this file?')) return okReply('trivial');
    if (content.includes('Fix the typo in line 3 of the parse function')) return okReply('code_simple');
    if (content.includes('Explain what a closure is briefly')) return okReply('simple');
    return okReply('standard');
  });
}

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
      completeSimple: vi.fn(async (model: any, prompt: any) => {
        if (model.id === 'broken-model') {
          return { errorMessage: '422', stopReason: 'error', content: [] };
        }
        const content: string = prompt?.messages?.[0]?.content ?? '';
        if (content.includes('What is in this file?')) return okReply('trivial');
        if (content.includes('Fix the typo')) return okReply('code_simple');
        if (content.includes('Explain what a closure is briefly')) return okReply('simple');
        return okReply('standard');
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
      completeSimple: goodClassifierMock(),
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
    const baseMock = goodClassifierMock();
    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: 'openrouter', id: ref.split('/')[1] }),
      completeSimple: vi.fn(async (model: any, prompt: any) => {
        callCount++;
        return baseMock(model, prompt);
      }),
    };
    const result = await probeAndCache(baseCfg, cache, pctx);
    expect(result.length).toBeLessThanOrEqual(8);
    // Each candidate now answers PROBE_CASES.length classification cases
    // (not one OK ping), so the early-stop bound scales with the case count.
    expect(callCount).toBeLessThanOrEqual(8 * PROBE_CASES.length);
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
      completeSimple: vi.fn(async (model: any, prompt: any) => {
        if (model.id === 'throwing-model') throw new Error('network error');
        const content: string = prompt?.messages?.[0]?.content ?? '';
        if (content.includes('What is in this file?')) return okReply('trivial');
        if (content.includes('Fix the typo')) return okReply('code_simple');
        if (content.includes('Explain what a closure is briefly')) return okReply('simple');
        return okReply('standard');
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
      completeSimple: vi.fn(async (model: any, prompt: any) => {
        if (model.id === 'broken') throw new Error('422');
        const content: string = prompt?.messages?.[0]?.content ?? '';
        if (content.includes('What is in this file?')) return okReply('trivial');
        if (content.includes('Fix the typo')) return okReply('code_simple');
        if (content.includes('Explain what a closure is briefly')) return okReply('simple');
        return okReply('standard');
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
      completeSimple: goodClassifierMock(),
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

// ---------------------------------------------------------------------------
// Quality probe: the probe validates the CLASSIFICATION task, not just
// reachability. Regression context: an audio model (voxtral-small) repeatedly
// passed the old "Reply with OK" reachability check but then copied
// "hint:group:tactical" out of the router narration context instead of
// classifying the actual request (2026-09-26). The probe cases therefore
// include a HINT-narration trap: a model that swallows the bait is rejected.
// ---------------------------------------------------------------------------
describe('probeAndCache — quality validation', () => {
  function makeCache(id = 'candidate'): Cache {
    return {
      available_models: [{ id, provider: 'openrouter', cost_per_m: 0 }],
      openrouter_pricing: { [`openrouter/${id}`]: { input: 0, output: 0 } },
    };
  }

  beforeEach(() => {
    seedMetrics(baseCfg, {});
  });
  afterEach(() => {
    metrics.setConfig({ model_groups: {}, model_metrics: {}, providers: {} });
    metrics.setCache({});
  });

  it('ACCEPTS a model that classifies every probe case with an accepted category', async () => {
    const cache = makeCache();
    seedMetrics(baseCfg, cache);
    const mock = goodClassifierMock();
    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: ref.split('/')[0], id: ref.split('/')[1] }),
      completeSimple: mock,
    };
    const result = await probeAndCache(baseCfg, cache, pctx);
    expect(result).toEqual(['openrouter/candidate']);
    // All cases must be answered — one call per probe case.
    expect(mock).toHaveBeenCalledTimes(PROBE_CASES.length);
  });

  it('REJECTS a model that copies the HINT narration from the context block (voxtral incident 2026-09-26)', async () => {
    // The trap case embeds router narration containing "HINT: use group ..."
    // in the context block. A model that echoes hint:* instead of classifying
    // the plain question would misroute production traffic into hint sticks.
    const cache = makeCache('voxtral');
    seedMetrics(baseCfg, cache);
    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: ref.split('/')[0], id: ref.split('/')[1] }),
      completeSimple: vi.fn(async (_m: any, prompt: any) => {
        const content: string = prompt?.messages?.[0]?.content ?? '';
        // Fails ONLY the trap case — passes the two plain cases first.
        if (content.includes('Explain what a closure is briefly')) {
          return okReply('hint:group:tactical');
        }
        if (content.includes('What is in this file?')) return okReply('trivial');
        if (content.includes('Fix the typo')) return okReply('code_simple');
        return okReply('standard');
      }),
    };
    const logs: string[] = [];
    const result = await probeAndCache(baseCfg, cache, pctx, (m) => logs.push(m));
    expect(result).not.toContain('openrouter/voxtral');
    expect(logs.some((l) => l.toLowerCase().includes('hint'))).toBe(true);
    // The quality failure must feed the health system (like any probe failure).
    expect(cache.model_health?.['openrouter/voxtral']).toBeDefined();
  });

  it('REJECTS prose replies (no classification JSON at all)', async () => {
    const cache = makeCache();
    seedMetrics(baseCfg, cache);
    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: ref.split('/')[0], id: ref.split('/')[1] }),
      completeSimple: vi.fn(async () => ({
        errorMessage: undefined,
        stopReason: 'stop',
        content: [{ type: 'text', text: 'This looks like a simple file question.' }],
      })),
    };
    const result = await probeAndCache(baseCfg, cache, pctx);
    expect(result).toEqual([]);
  });

  it('REJECTS a category outside the case accept list (misclassification)', async () => {
    // The read-file case accepts trivial|simple|standard — 'planning' shows the
    // model did not understand the classification task.
    const cache = makeCache();
    seedMetrics(baseCfg, cache);
    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: ref.split('/')[0], id: ref.split('/')[1] }),
      completeSimple: vi.fn(async () => okReply('planning')),
    };
    const result = await probeAndCache(baseCfg, cache, pctx);
    expect(result).toEqual([]);
  });

  it('REJECTS an invalid category name (not in VALID_CATEGORIES)', async () => {
    const cache = makeCache();
    seedMetrics(baseCfg, cache);
    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: ref.split('/')[0], id: ref.split('/')[1] }),
      completeSimple: vi.fn(async () => okReply('banana')),
    };
    const result = await probeAndCache(baseCfg, cache, pctx);
    expect(result).toEqual([]);
  });

  it('accepts ANY non-hint valid category in the trap case (breadth documented)', async () => {
    // The trap case's primary criterion is "does NOT echo hint:*". Which normal
    // category the model picks for "explain closures" is deliberately lenient
    // (simple/standard/... all acceptable) — we must not throw out usable
    // models over borderline category judgment calls.
    const cache = makeCache();
    seedMetrics(baseCfg, cache);
    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: ref.split('/')[0], id: ref.split('/')[1] }),
      completeSimple: vi.fn(async (_m: any, prompt: any) => {
        const content: string = prompt?.messages?.[0]?.content ?? '';
        if (content.includes('What is in this file?')) return okReply('trivial');
        if (content.includes('Fix the typo')) return okReply('code_simple');
        if (content.includes('Explain what a closure is briefly')) return okReply('standard');
        return okReply('simple');
      }),
    };
    const result = await probeAndCache(baseCfg, cache, pctx);
    expect(result).toEqual(['openrouter/candidate']);
  });

  it('sends the production prompt surface: case prompt AND trap narration reach the model', async () => {
    // Verifies the probe uses the shared buildClassificationPrompt surface —
    // the same prompt the runtime classifier sends. A probe that validates a
    // different prompt validates a different task.
    const cache = makeCache();
    seedMetrics(baseCfg, cache);
    const seenPrompts: string[] = [];
    const pctx: ProbeContext = {
      findModel: (ref) => ({ provider: ref.split('/')[0], id: ref.split('/')[1] }),
      completeSimple: vi.fn(async (_m: any, prompt: any) => {
        seenPrompts.push(prompt?.messages?.[0]?.content ?? '');
        const content: string = prompt?.messages?.[0]?.content ?? '';
        if (content.includes('What is in this file?')) return okReply('trivial');
        if (content.includes('Fix the typo')) return okReply('code_simple');
        return okReply('simple');
      }),
    };
    await probeAndCache(baseCfg, cache, pctx);
    expect(seenPrompts.length).toBe(PROBE_CASES.length);
    // Every case carries its user prompt.
    for (const tc of PROBE_CASES) {
      expect(seenPrompts.some((p) => p.includes(tc.prompt))).toBe(true);
    }
    // The trap case additionally carries the HINT narration (the bait).
    const trap = PROBE_CASES.find((tc) => tc.contextBlock);
    expect(trap).toBeDefined();
    expect(seenPrompts.some((p) => p.includes('HINT: use group'))).toBe(true);
  });
});
