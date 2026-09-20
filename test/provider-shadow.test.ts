/**
 * Regression tests for the mistral-zai ghost-model incident (2026-09-20).
 *
 * Root cause chain: an alias provider (`mistral-zai`, same upstream account
 * as `mistral` via `pricingAlias: 'mistral'`) whose scan entries landed in
 * the scan cache back when it had config keys. After the keys were removed
 * the scan loop stopped scanning it, but the scan-cache merge kept the
 * stale entries forever ("keep existing entries for providers not scanned").
 * registerGroupModels then re-registered those stale entries into Pi's
 * registry EVERY session start — with `cost_per_m: 0` scan placeholders
 * baked in as real prices — so `registryCost()` Step 0 returned $0.0 and
 * the ghost (best GDPval in the pool) won every cost-sorted group.
 *
 * The generic fix (Leitplanke 1 — no hardcoded provider names): a provider
 * whose `pricingAlias` target is known to Pi is REDUNDANT — its catalog
 * duplicates a pi-known provider's catalog under a router-internal key, and
 * Pi's catalog is the only source of truth (real costs, compat flags).
 * Such a provider must not be scanned, must not be registered, and its
 * stale cache entries must be pruned.
 */
import { describe, it, expect } from 'vitest';
import {
  redundantAliasProviders,
  pruneRedundantCacheEntries,
} from '../src/provider-shadow.ts';

const PROVIDER_MAP = {
  mistral: { baseUrl: 'https://api.mistral.ai/v1', api: 'openai-completions' },
  'mistral-zai': {
    baseUrl: 'https://api.mistral.ai/v1',
    api: 'openai-completions',
    pricingAlias: 'mistral',
  },
  groq: { baseUrl: 'https://api.groq.com', api: 'openai-completions' },
  chutes: { baseUrl: 'https://chutes.ai', api: 'openai-completions' },
} as Record<string, any>;

describe('redundantAliasProviders', () => {
  it('marks an alias provider whose target pi knows as redundant (mistral-zai → mistral)', () => {
    const piKnown = new Set(['mistral', 'openrouter']);
    const redundant = redundantAliasProviders(PROVIDER_MAP, piKnown);
    expect(redundant.has('mistral-zai')).toBe(true);
  });

  it('does NOT mark non-alias providers', () => {
    const piKnown = new Set(['mistral']);
    const redundant = redundantAliasProviders(PROVIDER_MAP, piKnown);
    expect(redundant.has('groq')).toBe(false);
    expect(redundant.has('chutes')).toBe(false);
    expect(redundant.has('mistral')).toBe(false);
  });

  it('does NOT mark an alias provider whose target pi does not know', () => {
    // If pi has no `mistral` auth/catalog, mistral-zai (with its own key)
    // is the only way to reach those models — not redundant.
    const piKnown = new Set(['openrouter']);
    const redundant = redundantAliasProviders(PROVIDER_MAP, piKnown);
    expect(redundant.has('mistral-zai')).toBe(false);
  });

  it('handles an empty piKnown set (nothing is redundant)', () => {
    const redundant = redundantAliasProviders(PROVIDER_MAP, new Set());
    expect(redundant.size).toBe(0);
  });
});

describe('pruneRedundantCacheEntries', () => {
  it('drops stale entries of redundant providers but keeps everything else', () => {
    const available = [
      { id: 'zai-glm-5-3', provider: 'mistral-zai', cost_per_m: 0 },
      { id: 'zai-glm-5-2', provider: 'mistral-zai', cost_per_m: 0 },
      { id: 'zai-glm-5-3', provider: 'mistral', cost_per_m: 0 },
      { id: 'mistral-medium-3.5', provider: 'mistral', cost_per_m: 0 },
      { id: 'llama-x', provider: 'groq', cost_per_m: 0 },
    ];
    const kept = pruneRedundantCacheEntries(available, new Set(['mistral-zai']));
    expect(kept.map((m) => `${m.provider}/${m.id}`)).toEqual([
      'mistral/zai-glm-5-3',
      'mistral/mistral-medium-3.5',
      'groq/llama-x',
    ]);
  });

  it('keeps the array untouched when the redundant set is empty', () => {
    const available = [
      { id: 'zai-glm-5-3', provider: 'mistral-zai', cost_per_m: 0 },
    ];
    const kept = pruneRedundantCacheEntries(available, new Set());
    expect(kept).toEqual(available);
  });
});
