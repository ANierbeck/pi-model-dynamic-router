// A model listed in a provider's `free_models` reaches the pool of every group
// it can satisfy, even without a GDPval score.
//
// Live finding (2026-11-05): `openrouter/openrouter/free` is the owner's
// explicit free model for `simple` (cheaper than local Ollama, but not for the
// harder groups). After a config change the regenerated dynamic snapshot had no
// `simple` candidate for it: buildModelsWithMetadata kept a ref only when it
// was in the static `models` list or had a GDPval score, and this meta-router
// has none. The group's own filters (min_gdpval, exclude_models) are the place
// that decides which groups get it; the pool must not decide for them.
import { describe, it, expect } from 'vitest';
import { buildModelsWithMetadata, buildStaticFreeModelsLookup } from '../src/dynamic-config.ts';
import type { Config } from '../src/types.ts';

const cfg = (providers: Record<string, unknown>): Config =>
  ({ providers, model_groups: {} }) as unknown as Config;

describe('buildModelsWithMetadata — explicitly configured free models', () => {
  it('keeps a free_models entry that has no GDPval score', () => {
    const config = cfg({ openrouter: { billing: 'pay_per_token', free_models: ['openrouter/openrouter/free'] } });
    const { staticFreeModelsLookup } = buildStaticFreeModelsLookup(config);
    const out = buildModelsWithMetadata(['openrouter/openrouter/free'], config, staticFreeModelsLookup, new Set());
    expect(out.map((m) => m.ref)).toEqual(['openrouter/openrouter/free']);
    expect(out[0].isFreeModel).toBe(true);
  });

  it('still drops an unscored model that nobody configured (the collapse guard stays)', () => {
    const config = cfg({ openrouter: { billing: 'pay_per_token', free_models: ['openrouter/openrouter/free'] } });
    const { staticFreeModelsLookup } = buildStaticFreeModelsLookup(config);
    const out = buildModelsWithMetadata(['openrouter/some-unscored-model'], config, staticFreeModelsLookup, new Set());
    expect(out).toEqual([]);
  });
});
