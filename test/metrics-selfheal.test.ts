// test/metrics-selfheal.test.ts
// Regression guard for the "two lookupGdp implementations" bug.
//
// BACKGROUND: metrics.ts exports lookupGdp() used by routing.ts (the live
// /router table). index.ts has a SEPARATE closure lookupGdp() used by
// generateDynamicConfig (writes the dynamic config file). These drifted:
// the closure got self-healing + LLM tier; metrics.ts did NOT. So after a
// load() (which can empty gdpval during a scan), the live /router table
// lost GLM-5-2 even though the dynamic config file had it.
//
// These tests pin metrics.ts lookupGdp to be self-healing: it must restore
// gdpval from cache.gdpval_scores when gdpval is empty.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  lookupGdp,
  setConfig,
  setCache,
  setGdpval,
  setModelMap,
} from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

beforeEach(() => {
  // Reset to a clean state before each test.
  setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
  setGdpval({});
  setCache({});
});

describe('metrics.lookupGdp — self-healing from cache.gdpval_scores', () => {
  it('returns null when gdpval AND cache.gdpval_scores are both empty', () => {
    setModelMap({}, []);
    expect(lookupGdp('glm-5-2')).toBeNull();
  });

  it('self-heals: loads gdpval_scores from cache when gdpval is empty', () => {
    // Simulate the race condition: gdpval was emptied (e.g. by load() during
    // scan()), but the cache still has the scraped scores.
    setGdpval({}); // emptied
    const cache: Cache = {
      gdpval_scores: { 'glm-5-2': 1506.11, 'glm-4': 400 },
    };
    setCache(cache);

    // lookupGdp must restore from cache, not stay empty.
    expect(lookupGdp('glm-5-2')).toBe(1506.11);
    expect(lookupGdp('glm-4')).toBe(400);
  });

  it('self-heals + model-map: zai-glm-5-2 → glm-5-2 → 1506 (the GLM bug)', () => {
    // This is the exact scenario that failed: the model-map entry
    // zai-glm-5-2 → glm-5-2 was loaded, but gdpval was empty so the slug
    // score could not be found. Self-healing must fix this.
    setModelMap({ 'zai-glm-5-2': 'glm-5-2', 'glm-5-2': 'glm-5-2' }, []);
    setGdpval({}); // emptied by race condition
    const cache: Cache = {
      gdpval_scores: { 'glm-5-2': 1506.11 },
    };
    setCache(cache);

    expect(lookupGdp('zai-glm-5-2')).toBe(1506.11);
    expect(lookupGdp('glm-5-2')).toBe(1506.11);
  });

  it('gdpval_builtin overrides take precedence over cache scores (builtin wins)', () => {
    // If a builtin explicitly sets a score for a slug, it must win over the
    // scraped score (builtins are authoritative manual overrides).
    setConfig({
      model_groups: {},
      model_metrics: {},
      gdpval_builtin: { 'glm-4': 999 }, // manual override
    });
    setGdpval({});
    const cache: Cache = {
      gdpval_scores: { 'glm-4': 400 }, // scraped score
    };
    setCache(cache);

    expect(lookupGdp('glm-4')).toBe(999);
  });

  it('does NOT clobber a populated gdpval (idempotent when scores present)', () => {
    // If gdpval already has scores (e.g. scan() just scraped), lookupGdp must
    // not wipe them. The self-heal only triggers when gdpval is EMPTY.
    // Setup: give cache scores, then set gdpval to a DIFFERENT (newer) value
    // by calling setGdpval AFTER setCache.
    const cache: Cache = { gdpval_scores: { 'glm-5-2': 999 } }; // older
    setCache(cache);
    // Now simulate scan() scraping fresh scores into gdpval directly.
    setGdpval({ 'glm-5-2': 1506.11 });
    // lookupGdp must use the in-memory 1506.11, not reload the stale 999.
    expect(lookupGdp('glm-5-2')).toBe(1506.11);
  });
});

describe('metrics.lookupGdp — model-map precedence (no regression)', () => {
  it('model-map exact match beats token-set fallback', () => {
    setModelMap({ 'zai-glm-5-2': 'glm-5-2' }, []);
    const cache: Cache = {
      gdpval_scores: { 'glm-5-2': 1506.11, 'glm-4': 400 },
    };
    setCache(cache);
    // zai-glm-5-2 tokens {zai,glm,5,2} would NOT match glm-4 {glm,4} or
    // glm-5-2 {glm,5,2} via token-set (the extra 'zai' breaks equality).
    // The model-map must win.
    expect(lookupGdp('zai-glm-5-2')).toBe(1506.11);
  });

  it('explicit null in model-map excludes the model (returns null)', () => {
    setModelMap({ 'zai-org/GLM-5-Turbo': null }, []);
    const cache: Cache = { gdpval_scores: { 'glm-5-2': 1506.11 } };
    setCache(cache);
    expect(lookupGdp('zai-org/GLM-5-Turbo')).toBeNull();
  });

  it('provider prefix is stripped before model-map lookup', () => {
    // "mistral-zai/zai-glm-5-2" → stripped to "zai-glm-5-2" → map hit.
    setModelMap({ 'zai-glm-5-2': 'glm-5-2' }, []);
    const cache: Cache = { gdpval_scores: { 'glm-5-2': 1506.11 } };
    setCache(cache);
    expect(lookupGdp('mistral-zai/zai-glm-5-2')).toBe(1506.11);
    expect(lookupGdp('mistral/zai-glm-5-2')).toBe(1506.11);
  });
});

describe('metrics.resolveSlug/lookupGdp — self-healing from missing gdpval_builtin entries', () => {
  // BACKGROUND (2026-08-23): scan()'s AA scrape calls setGdpval(freshlyScrapedScores),
  // which REPLACES the entire gdpval map (`gdpval = {...scores}`). This wipes
  // whatever setConfig() had merged in earlier from gdpval_builtin — OUR OWN
  // curated overrides (e.g. mistral-medium-3-5:933) that Artificial Analysis's
  // scrape never contains. Nothing re-applies gdpval_builtin before
  // generateDynamicConfig runs, so every model that ONLY resolves through a
  // builtin silently loses its score. The old self-heal (empty-gdpval check)
  // doesn't catch this — gdpval isn't EMPTY after the scrape, just incomplete.
  // This caused a real scoring collapse (13/148 scored, caught by
  // scan-sanity.ts) on a live /router scan.

  it('reproduces the exact bug: setGdpval() after setConfig() wipes builtins, breaking a builtin-only slug', () => {
    setConfig({
      model_groups: {},
      model_metrics: {},
      gdpval_builtin: { 'mistral-medium-3-5': 933 }, // OUR OWN curated score, AA never has this
    });
    setModelMap({ 'mistral-medium-latest': 'mistral-medium-3-5' }, []);
    // Before the scrape: builtin resolves fine.
    expect(lookupGdp('mistral/mistral-medium-latest')).toBe(933);

    // scan()'s AA scrape replaces gdpval with ONLY freshly-scraped slugs —
    // none of which include our builtin "mistral-medium-3-5".
    setGdpval({ 'glm-5-3': 1769 }); // simulates a real AA scrape result

    // Self-heal must restore the builtin so the model still scores.
    expect(lookupGdp('mistral/mistral-medium-latest')).toBe(933);
    // The freshly-scraped slug must ALSO still be usable (not wiped by the heal).
    setModelMap({ 'mistral-medium-latest': 'mistral-medium-3-5', 'some-glm': 'glm-5-3' }, []);
    expect(lookupGdp('some-glm')).toBe(1769);
  });

  it('self-heals even when gdpval_scores cache is ALSO wiped (the real failure mode)', () => {
    // In the real bug, scan() ALSO does `cache.gdpval_scores = getGdpval()`
    // immediately after setGdpval() — so cache.gdpval_scores is corrupted
    // (missing builtins) too. The heal must NOT rely on cache.gdpval_scores
    // for this case — it must use cfg.gdpval_builtin directly.
    setConfig({
      model_groups: {},
      model_metrics: {},
      gdpval_builtin: { 'qwen3-8-27b': 580 },
    });
    setModelMap({ 'qwen3.8:27b-mlx': 'qwen3-8-27b' }, []);

    // Simulate scan(): setGdpval(scraped) then cache.gdpval_scores mirrors the
    // now-wiped gdpval — i.e. the cache is ALSO missing the builtin.
    setGdpval({ 'some-ai-model': 1000 });
    setCache({ gdpval_scores: { 'some-ai-model': 1000 } }); // NOTE: no qwen3-8-27b here either

    // Must still resolve via cfg.gdpval_builtin, not cache.gdpval_scores.
    expect(lookupGdp('ollama/qwen3.8:27b-mlx')).toBe(580);
  });

  it('does not re-trigger the heal once builtins are already present (idempotent, no version churn)', () => {
    setConfig({
      model_groups: {},
      model_metrics: {},
      gdpval_builtin: { 'glm-4': 400 },
    });
    setModelMap({ 'glm-4': 'glm-4' }, []);
    expect(lookupGdp('glm-4')).toBe(400);
    // A second lookup after builtins are already merged must not need to heal
    // again — still returns the correct (builtin) value, not overwritten by
    // anything else.
    expect(lookupGdp('glm-4')).toBe(400);
  });

  it('a later, unrelated setGdpval() call still triggers healing again (not a one-shot fix)', () => {
    setConfig({
      model_groups: {},
      model_metrics: {},
      gdpval_builtin: { 'gemma4-27b': 520 },
    });
    setModelMap({ 'gemma4:latest': 'gemma4-27b' }, []);
    expect(lookupGdp('ollama/gemma4:latest')).toBe(520);

    // Simulate a SECOND scan cycle (e.g. /router scan run twice) that wipes
    // gdpval again.
    setGdpval({ 'unrelated-slug': 1 });
    expect(lookupGdp('ollama/gemma4:latest')).toBe(520);
  });
});

describe('metrics.setCache — additive merge (A2: same-scan Ollama estimate visibility)', () => {
  // BACKGROUND (A2, 2026-08-24): scan() in index.ts estimates GDPval scores
  // for newly-discovered Ollama models and writes them directly into
  // cache.gdpval_scores (a plain object mutation), WITHOUT going through
  // metrics.ts. Because lookupGdp()/resolveSlug() only ever read the
  // in-memory `gdpval` map (populated by setConfig/setCache/setGdpval), a
  // model whose score was added to cache.gdpval_scores this way stayed
  // invisible to lookupGdp() until the NEXT setCache() call (i.e. the next
  // session_start) — so generateDynamicConfig(), which runs at the end of
  // the SAME scan(), would score the model as unscored (gdpval=0) and drop
  // it. Fixed by having index.ts call setCache(cache) again right after
  // mutating cache.gdpval_scores. This test locks the contract that fix
  // depends on: setCache() must ADDITIVELY merge gdpval_scores into the
  // existing in-memory gdpval map (Object.assign, not replace), so calling
  // it a second time with newly-added keys makes them immediately visible
  // without clobbering scores already resolved earlier in the same scan.

  it('a second setCache() call with new gdpval_scores keys makes them visible without clobbering existing scores', () => {
    setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
    setModelMap({ 'glm-5-3': 'glm-5-3', 'ornith:9b': 'ornith-9b' }, []);

    // First setCache: only the AA-scraped score is present.
    const cache: Cache = { gdpval_scores: { 'glm-5-3': 1769 } };
    setCache(cache);
    expect(lookupGdp('glm-5-3')).toBe(1769);
    expect(lookupGdp('ollama/ornith:9b')).toBeNull(); // not estimated yet

    // Simulate scan()'s Ollama-estimate merge: a NEW slug is added directly
    // to cache.gdpval_scores (mutating the SAME object, mirroring index.ts),
    // then setCache() is called again to sync it into metrics.ts.
    cache.gdpval_scores!['ornith-9b'] = 610;
    setCache(cache);

    // The new Ollama estimate must be visible immediately (same scan cycle)...
    expect(lookupGdp('ollama/ornith:9b')).toBe(610);
    // ...without wiping the score resolved before the second setCache() call.
    expect(lookupGdp('glm-5-3')).toBe(1769);
  });
});
