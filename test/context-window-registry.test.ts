/**
 * Regression tests for the Sourcery findings on PR #1 (2026-09-20): the
 * `min_context_length` gate consulted ONLY the scan cache
 * (`cache.available_models[].capabilities.contextWindow`) for a model's
 * context window. Models that live only in Pi's model registry — or static
 * free_models that are deliberately never scanned — always got `null` and
 * were unconditionally dropped from every positive min_context_length group
 * (bulk_reader / code_writer), despite having a perfectly usable registered
 * context window. Same class of bug as the price incident (2026-09-05):
 * scan-cache-only lookup where the registry is the source of truth.
 *
 * Fix under test: lookupContextWindow() is registry-first (Step 0 =
 * findRegistryModel(ref).contextWindow, mirroring lookupPrice), with the
 * scan-cache capabilities as fallback. Null (unverified) still fails strict
 * gates — that semantic is intentional and must NOT change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  lookupContextWindow,
  setModelRegistry,
  getModelRegistry,
  setCache,
} from '../src/metrics.ts';

const REGISTRY_MODEL = {
  provider: 'mistral',
  id: 'mistral-medium-3.5',
  api: 'openai-completions',
  contextWindow: 128_000,
  cost: { input: 0.4, output: 1.2, cacheRead: 0.04, cacheWrite: 0 },
};

function registryWith(models: Array<Record<string, unknown>>) {
  return {
    find: (provider: string, modelId: string) =>
      models.find((m: any) => m.provider === provider && m.id === modelId) ?? null,
    getAvailable: () => models,
  };
}

describe('lookupContextWindow: registry-first (PR #1 Sourcery findings 1–4)', () => {
  let previousRegistry: any;

  beforeEach(() => {
    previousRegistry = getModelRegistry();
    setCache({
      available_models: [],
      gdpval_scores: {},
    });
  });

  afterEach(() => {
    setModelRegistry(previousRegistry);
    setCache({ available_models: [], gdpval_scores: {} });
  });

  it('returns the registry contextWindow for a model the scan cache has never seen', () => {
    setModelRegistry(registryWith([REGISTRY_MODEL]));
    expect(lookupContextWindow('mistral/mistral-medium-3.5')).toBe(128_000);
  });

  it('prefers the registry over a stale scan-cache entry (registry is the source of truth)', () => {
    setModelRegistry(registryWith([REGISTRY_MODEL]));
    setCache({
      available_models: [
        {
          provider: 'mistral',
          id: 'mistral-medium-3.5',
          capabilities: { contextWindow: 4_096 }, // stale/wrong cached value
        },
      ],
      gdpval_scores: {},
    });
    expect(lookupContextWindow('mistral/mistral-medium-3.5')).toBe(128_000);
  });

  it('falls back to the scan cache when the model is not in the registry', () => {
    setModelRegistry(registryWith([]));
    setCache({
      available_models: [
        {
          provider: 'scanned-provider',
          id: 'scanned-model',
          capabilities: { contextWindow: 65_536 },
        },
      ],
      gdpval_scores: {},
    });
    expect(lookupContextWindow('scanned-provider/scanned-model')).toBe(65_536);
  });

  it('resolves :free refs through the registry (free_models are registry-registered, not scanned)', () => {
    setModelRegistry(
      registryWith([
        {
          provider: 'openrouter',
          id: 'z-ai/glm-5.2', // registry stores the base id WITHOUT :free
          api: 'openai-completions',
          contextWindow: 200_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ])
    );
    setCache({
      available_models: [], // static free models are deliberately never scanned
      gdpval_scores: {},
    });
    expect(lookupContextWindow('openrouter/z-ai/glm-5.2:free')).toBe(200_000);
  });

  it('returns null when neither registry nor cache knows the context window (strict gate semantic preserved)', () => {
    setModelRegistry(registryWith([]));
    expect(lookupContextWindow('unknown-provider/unknown-model')).toBe(null);
  });

  it('falls back to the scan cache when the registry entry has no usable contextWindow', () => {
    setModelRegistry(
      registryWith([
        { provider: 'odd', id: 'odd-model', contextWindow: 0 }, // invalid registry value
      ])
    );
    setCache({
      available_models: [
        { provider: 'odd', id: 'odd-model', capabilities: { contextWindow: 32_768 } },
      ],
      gdpval_scores: {},
    });
    expect(lookupContextWindow('odd/odd-model')).toBe(32_768);
  });
});
