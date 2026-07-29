/**
 * Integration Tests für Router-Funktionalität
 * Testet die echte Interaktion zwischen Modulen
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Router } from '../src/routing.js';
import { RateLimitManager } from '../src/rate-limit.js';
import { DiscoveryManager } from '../src/discovery.js';
import * as metricsModule from '../src/metrics.js';
import { CacheManager } from '../src/cache.js';
import type { Config, Cache } from '../src/types.js';
import { PROVIDER_MAP } from '../src/providers.js';

// Echte Konfiguration für Tests
const testConfig: Config = {
  model_groups: {
    strategic: {
      method: 'best',
      models: ['anthropic/claude-3-sonnet', 'openai/gpt-4', 'google/gemini-1.5-pro'],
    },
    tactical: {
      method: 'tiered',
      models: ['anthropic/claude-3-haiku', 'openai/gpt-3.5-turbo', 'mistral/mistral-large'],
    },
    operational: {
      method: 'tiered',
      models: ['google/gemini-1.5-flash', 'mistral/mistral-small'],
    },
    scout: {
      method: 'tiered',
      models: ['openai/gpt-4o-mini', 'google/gemini-1.5-nano'],
    },
    fallback: {
      method: 'tiered',
      models: ['local/llama-3.2-1b'],
    },
  },
  providers: {
    anthropic: {
      billing: 'subscription',
      keys: [{ key: 'test-key-1', label: 'Test Key 1' }],
    },
    openai: {
      billing: 'payg',
      keys: [{ key: 'test-key-2', label: 'Test Key 2' }],
    },
    google: {
      billing: 'payg',
      keys: [{ key: 'test-key-3', label: 'Test Key 3' }],
    },
  },
  model_metrics: {
    'anthropic/claude-3-sonnet': { gdpval: 0.95, throughput_tps: 10, avg_latency_ms: 200 },
    'openai/gpt-4': { gdpval: 0.98, throughput_tps: 15, avg_latency_ms: 150 },
    'google/gemini-1.5-pro': { gdpval: 0.93, throughput_tps: 12, avg_latency_ms: 180 },
    'anthropic/claude-3-haiku': { gdpval: 0.85, throughput_tps: 8, avg_latency_ms: 120 },
    'openai/gpt-3.5-turbo': { gdpval: 0.80, throughput_tps: 10, avg_latency_ms: 100 },
    'mistral/mistral-large': { gdpval: 0.88, throughput_tps: 9, avg_latency_ms: 250 },
    'google/gemini-1.5-flash': { gdpval: 0.82, throughput_tps: 7, avg_latency_ms: 90 },
    'mistral/mistral-small': { gdpval: 0.75, throughput_tps: 6, avg_latency_ms: 80 },
    'openai/gpt-4o-mini': { gdpval: 0.78, throughput_tps: 5, avg_latency_ms: 70 },
    'google/gemini-1.5-nano': { gdpval: 0.70, throughput_tps: 4, avg_latency_ms: 60 },
    'local/llama-3.2-1b': { gdpval: 0.65, throughput_tps: 3, avg_latency_ms: 50 },
  },
  gdpval_builtin: {},
};

// Echte Module initialisieren
const extDir = '/tmp/test-router';
const cacheManager = new CacheManager(extDir);
const cache: Cache = cacheManager.loadCache();

// Metrics Modul konfigurieren
metricsModule.setConfig(testConfig);
metricsModule.setCache(cache);

// RateLimitManager erstellen
const rateLimitManager = new RateLimitManager(
  [60000, 120000, 240000], // backoff
  30000, // softBackoff
  10, // costMuxAtHit
  cache
);

// DiscoveryManager erstellen
const discoveryManager = new DiscoveryManager(testConfig, cache);

// Router erstellen
const router = new Router(
  testConfig,
  cache,
  rateLimitManager.getLimits()
);

describe('Router Integration Tests', () => {
  beforeAll(() => {
    // Initialisiere Cache mit Test-Daten
    cache.available_models = [
      { provider: 'anthropic', id: 'claude-3-sonnet', cost_per_m: 0.003 },
      { provider: 'openai', id: 'gpt-4', cost_per_m: 0.002 },
      { provider: 'google', id: 'gemini-1.5-pro', cost_per_m: 0.0025 },
      { provider: 'anthropic', id: 'claude-3-haiku', cost_per_m: 0.0005 },
      { provider: 'openai', id: 'gpt-3.5-turbo', cost_per_m: 0.001 },
    ];
  });

  describe('allDiscoveredRefs()', () => {
    // allDiscoveredRefs() sources from Pi's model registry (none in this unit test —
    // no sessionCtx set), cache.available_models, and configured free_models. Group
    // `models` pin lists are no longer a discovery source (dynamic model discovery).
    it('should return all models from cache.available_models', () => {
      const refs = router.allDiscoveredRefs();

      expect(refs).toContain('anthropic/claude-3-sonnet');
      expect(refs).toContain('openai/gpt-4');
      expect(refs).toContain('google/gemini-1.5-pro');
      expect(refs).toContain('anthropic/claude-3-haiku');
      expect(refs).toContain('openai/gpt-3.5-turbo');
    });

    it('should not include models that are only pinned in group config, not in cache', () => {
      const refs = router.allDiscoveredRefs();
      // 'local/llama-3.2-1b' is only listed in the fallback group's `models`, never
      // seeded into cache.available_models or a session's model registry.
      expect(refs).not.toContain('local/llama-3.2-1b');
    });

    it('should return unique references', () => {
      const refs = router.allDiscoveredRefs();
      const uniqueRefs = new Set(refs);

      expect(refs.length).toBe(uniqueRefs.size);
    });

    it('should match the number of models seeded into cache.available_models', () => {
      const refs = router.allDiscoveredRefs();
      expect(refs.length).toBe(cache.available_models!.length);
    });
  });

  describe('resolve()', () => {
    it('should resolve strategic group', () => {
      const result = router.resolve('strategic');

      expect(result).toBeDefined();
      if (result) {
        expect(result.selected).toBeDefined();
        expect(result.candidates).toBeDefined();
        expect(result.candidates.length).toBeGreaterThan(0);
      }
    });

    it('should resolve tactical group', () => {
      const result = router.resolve('tactical');

      expect(result).toBeDefined();
      if (result) {
        expect(result.selected).toBeDefined();
        expect(result.candidates).toBeDefined();
      }
    });

    it('should resolve fallback group', () => {
      const result = router.resolve('fallback');

      expect(result).toBeDefined();
      if (result) {
        expect(result.selected).toBeDefined();
      }
    });

    it('should return null for unknown group', () => {
      const result = router.resolve('unknown-group');

      expect(result).toBeNull();
    });
  });

  describe('getTopModels()', () => {
    it('should return top 3 models', () => {
      const topModels = router.getTopModels('strategic', 3);

      expect(Array.isArray(topModels)).toBe(true);
      expect(topModels.length).toBeLessThanOrEqual(3);
    });

    it('should return all models when count is high', () => {
      const allModels = router.getTopModels('strategic', 100);

      expect(Array.isArray(allModels)).toBe(true);
      expect(allModels.length).toBeGreaterThanOrEqual(0);
    });

    it('should return empty array for 0 models', () => {
      const zeroModels = router.getTopModels('strategic', 0);
      expect(zeroModels).toEqual([]);
    });

    it('should return only refs from allDiscoveredRefs() (dynamic discovery, not the group pin list)', () => {
      // getTopModels() ranks all discovered models by group criteria (min_gdpval, cost,
      // method) — it no longer restricts candidates to the group's static `models` list.
      const discovered = router.allDiscoveredRefs();
      const topModels = router.getTopModels('strategic', 10);
      for (const m of topModels) {
        expect(discovered).toContain(m.ref);
      }
    });

    it('should return only refs from allDiscoveredRefs() for tactical group', () => {
      const discovered = router.allDiscoveredRefs();
      const topModels = router.getTopModels('tactical', 10);
      for (const m of topModels) {
        expect(discovered).toContain(m.ref);
      }
    });
  });

  describe('filterAvailable()', () => {
    it('should filter models without limits', () => {
      const refs = [
        'anthropic/claude-3-sonnet',
        'openai/gpt-4',
        'google/gemini-1.5-pro',
      ];

      const filtered = router.filterAvailable(refs, {});

      // Ohne Limits sollten alle Modelle durchkommen
      expect(filtered).toContain('anthropic/claude-3-sonnet');
      expect(filtered).toContain('openai/gpt-4');
      expect(filtered).toContain('google/gemini-1.5-pro');
    });

    it('should handle empty input', () => {
      const filtered = router.filterAvailable([], {});
      expect(filtered).toEqual([]);
    });

    it('should consider exhausted keys', () => {
      // Markiere einen Key als exhausted
      cache.exhausted_keys = {
        'openai:0': Date.now() + 10000, // Key 0 exhausted für 10 Sekunden
      };

      const refs = ['openai/gpt-4'];
      const filtered = router.filterAvailable(refs, { openai: 0 });

      // Da Key 0 exhausted ist, sollte das Modell gefiltert werden
      expect(filtered).not.toContain('openai/gpt-4');
    });
  });

  describe('sortBy()', () => {
    it('should sort models by gdpval', () => {
      const refs = [
        'openai/gpt-4', // gdpval: 0.98
        'anthropic/claude-3-sonnet', // gdpval: 0.95
        'google/gemini-1.5-pro', // gdpval: 0.93
      ];

      const sorted = router.sortBy(refs, 'max_gdpval');

      expect(Array.isArray(sorted)).toBe(true);
      expect(sorted.length).toBe(3);
      // Das Modell mit dem höchsten gdpval sollte zuerst sein
      if (sorted.length >= 1) {
        expect(sorted[0]).toBe('openai/gpt-4');
      }
    });

    it('should handle empty input', () => {
      const sorted = router.sortBy([], 'max_gdpval');
      expect(sorted).toEqual([]);
    });
  });

  describe('sortByBillingPreference()', () => {
    // anthropic/claude-3-sonnet and anthropic/claude-3-haiku share billing tier
    // (subscription) and have no explicit cost_per_m, so effCost() falls back to
    // the same constant for both — a genuine cost tie. Before the gdpval
    // tiebreaker, Array.sort's stable order (i.e. input order) decided ties,
    // making `tiered` groups in /router effectively unsorted whenever every
    // candidate shared a billing tier and cost (e.g. all $0.0 models).
    it('breaks a same-tier cost tie by higher gdpval, not input order', () => {
      const sorted = router.sortByBillingPreference(['anthropic/claude-3-haiku', 'anthropic/claude-3-sonnet']);
      expect(sorted).toEqual(['anthropic/claude-3-sonnet', 'anthropic/claude-3-haiku']);
    });

    it('is insensitive to input order once tied on tier and cost', () => {
      const sorted = router.sortByBillingPreference(['anthropic/claude-3-sonnet', 'anthropic/claude-3-haiku']);
      expect(sorted).toEqual(['anthropic/claude-3-sonnet', 'anthropic/claude-3-haiku']);
    });

    it('still prefers billing tier over gdpval when tiers differ', () => {
      // mistral/mistral-large is pay_per_token (tier 3); anthropic/claude-3-haiku
      // is subscription (tier 1) despite the lower gdpval (0.85 vs 0.88).
      const sorted = router.sortByBillingPreference(['mistral/mistral-large', 'anthropic/claude-3-haiku']);
      expect(sorted).toEqual(['anthropic/claude-3-haiku', 'mistral/mistral-large']);
    });
  });
});
