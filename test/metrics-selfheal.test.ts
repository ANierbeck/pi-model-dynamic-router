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
