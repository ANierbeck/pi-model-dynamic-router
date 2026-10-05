// test/slug-resolution.test.ts — Batch 3 of the mutation-survivor triage
// (docs/plans/2026-10-04-mutation-survivor-triage.md, Task 4; ledger:
// metrics.ts:100-350). Closes the REAL-GAP survivors in the slug/model-map
// machinery:
//
//   mapLookup (exact vs wildcard), buildModelMapAliasIndex / aliasesFor
//   (alias groups, version-staleness rebuild, slash-key exclusion),
//   buildGdpvalIndex (token-set fallback key, max-score selection),
//   splatVersionRuns / getSlugCanon (duplicate-spelling canonicalization:
//   same-score twins collapse, different-score twins stay distinct),
//   resolveSlug stages (model-map exclusion wins over the matcher,
//   partial builtin self-heal, cached LLM matches are canonicalized and
//   type-checked).
//
// The alias-index tests observe the PRIVATE aliasesFor() through the public
// registryCost alias retry (lookupPrice) — the only production path that
// consumes aliases.

import { describe, it, expect, beforeAll } from 'vitest';
import * as metricsModule from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

// Registry fixtures for the alias-retry observations. NOTE: the mock
// deliberately answers a SLASH-CONTAINING id ('deepx/deep-model') — registry
// ids like 'deepseek-ai/DeepSeek-V3' really exist, and the alias index must
// never offer provider-prefixed model-map keys as lookup ids.
const registry = {
  find: (provider: string, id: string) => {
    if (provider === 'mistral' && id === 'zai-glm-5-2') {
      return { id, provider, cost: { input: 2, output: 4 } };
    }
    if (provider === 'mistral' && id === 'alt-glm') {
      return { id, provider, cost: { input: 6, output: 8 } };
    }
    if (provider === 'mistral' && id === 'a-y') {
      return { id, provider, cost: { input: 3, output: 6 } };
    }
    if (provider === 'mistral' && id === 'deepx/deep-model') {
      return { id, provider, cost: { input: 5, output: 5 } };
    }
    return undefined;
  },
};

const testConfig: Config = {
  model_groups: {},
  model_metrics: {},
  providers: {},
  gdpval_builtin: {},
} as any;

beforeAll(() => {
  metricsModule.setConfig(testConfig);
  metricsModule.setCache({} as any);
  metricsModule.setModelRegistry(registry as any);
});

// ── mapLookup: exact + wildcard ────────────────────────────────────────────

describe('mapLookup — exact match beats wildcard; wildcard beats no-match', () => {
  beforeAll(() => {
    // Wildcards match the PROVIDER-STRIPPED model id ('medium-2504'
    // after stripping 'mistral/'), so the prefix is 'medium'.
    metricsModule.setModelMap(
      { 'glm-5-2': 'glm-5-2', 'medium-2504': 'mistral-medium-2504' },
      [['medium', 'mistral-medium-3-5']],
    );
  });

  it('exact model-map entry returns its slug', () => {
    expect(metricsModule.mapLookup('mistral/glm-5-2')).toBe('glm-5-2');
  });

  it('an unmapped id falls through to the LONGEST-PREFIX wildcard', () => {
    expect(metricsModule.mapLookup('mistral/medium-2604')).toBe('mistral-medium-3-5');
  });

  it('no exact and no wildcard → undefined (not null — null means excluded)', () => {
    expect(metricsModule.mapLookup('mistral/entirely-unknown')).toBeUndefined();
  });
});

// ── alias index (observed via lookupPrice's registryCost alias retry) ─────

describe('buildModelMapAliasIndex / aliasesFor — alias groups for the registry retry', () => {
  it('siblings sharing a GDPval slug are retried when the primary id misses', () => {
    // Pi's catalog indexes the model as zai-glm-5-2 while the provider's own
    // API calls it glm-5-2 — the alias retry must find the sibling's price.
    metricsModule.setModelMap(
      {
        'glm-5-2': 'glm-slug',
        'zai-glm-5-2': 'glm-slug',
        'mistral/zai-glm-5-2': 'glm-slug', // provider-prefixed: NOT a lookup id
      },
      [],
    );
    expect(metricsModule.lookupPrice('mistral/glm-5-2')).toEqual({ input: 2, output: 4 });
  });

  it('the alias index is rebuilt when the model map changes', () => {
    metricsModule.setModelMap({ 'glm-5-2': 'glm-slug', 'alt-glm': 'glm-slug' }, []);
    expect(metricsModule.lookupPrice('mistral/glm-5-2')).toEqual({ input: 6, output: 8 });
  });

  it('a THREE-key group: every sibling is retried, not just the last one', () => {
    // Discriminator for the alias-index accumulation: with only two keys,
    // "last set wins" coincidentally keeps the right sibling (the queried
    // model is filtered out anyway). Three keys expose it.
    metricsModule.setModelMap(
      { 'a-x': 'gs3', 'a-y': 'gs3', 'a-z': 'gs3' },
      [],
    );
    // Registry prices ONLY the middle sibling — a last-key-only index
    // would miss it.
    expect(metricsModule.lookupPrice('mistral/a-x')).toEqual({ input: 3, output: 6 });
  });

  it('provider-prefixed model-map keys are NEVER offered as alias lookup ids', () => {
    // Even when the registry would answer a slash-containing id, the alias
    // index must not leak 'deepx/deep-model' as a lookup for glm-5-2.
    metricsModule.setModelMap({ 'glm-5-2': 'glm-slug', 'deepx/deep-model': 'glm-slug' }, []);
    expect(metricsModule.lookupPrice('mistral/glm-5-2')).toBeNull();
  });
});

// ── buildGdpvalIndex: token-set fallback + max selection ───────────────────

describe('buildGdpvalIndex — token-set fallback picks the MAX score among synonyms', () => {
  it('a synonym slug resolves through the token-set index (higher score first in map order)', () => {
    metricsModule.setGdpval({ 'mistral-medium-3-5': 900, 'mistral-medium-3.5': 800 });
    // LLM matched slug 'mistral-medium-3 5' has no direct entry — the
    // token-set key {mistral, medium, 3, 5} must find the 900.
    metricsModule.setLlmMatches({ 'mistral/mmx': 'mistral-medium-3 5' });
    expect(metricsModule.lookupGdp('mistral/mmx')).toBe(900);
  });

  it('max wins regardless of insertion order (lower score first)', () => {
    metricsModule.setGdpval({ 'mistral-medium-3.5': 800, 'mistral-medium-3-5': 900 });
    metricsModule.setLlmMatches({ 'mistral/mmx2': 'mistral-medium-3 5' });
    expect(metricsModule.lookupGdp('mistral/mmx2')).toBe(900);
  });
});

// ── splatVersionRuns / getSlugCanon: duplicate-spelling canonicalization ──

describe('getSlugCanon — same-score digit-run twins collapse, different-score stay distinct', () => {
  beforeAll(() => {
    // Clear the model map: stage-0 overrides from the alias describes
    // would otherwise shadow the matcher under test here.
    metricsModule.setModelMap({}, []);
  });

  it("'glm-53' and 'glm-5-3' with EQUAL scores are ONE model (dedup identity)", () => {
    metricsModule.setGdpval({ 'glm-53': 1232, 'glm-5-3': 1232 });
    expect(metricsModule.getMatchedSlug('openrouter/glm-53')).toBe('glm-5-3');
    expect(metricsModule.getMatchedSlug('openrouter/glm-5-3')).toBe('glm-5-3');
  });

  it("'glm-52' and 'glm-5-2' with DIFFERENT scores stay DISTINCT models", () => {
    // glm-52 is GDPval's non-reasoning variant, not a duplicate of glm-5-2.
    metricsModule.setGdpval({ 'glm-52': 1232.78, 'glm-5-2': 1357.35 });
    expect(metricsModule.getMatchedSlug('openrouter/glm-52')).toBe('glm-52');
    expect(metricsModule.getMatchedSlug('openrouter/glm-5-2')).toBe('glm-5-2');
  });
});

// ── resolveSlug stages ─────────────────────────────────────────────────────

describe('resolveSlug — stage contracts', () => {
  it('a model-map EXCLUSION (explicit null) wins over the fuzzy matcher', () => {
    // Without the null check, glm-5-turbo would fuzzy-match to its base
    // model glm-5-2 — exactly the Turbo/Flash variant leak the exclusion
    // exists for.
    metricsModule.setGdpval({ 'glm-5-2': 100 });
    metricsModule.setModelMap({ 'glm-5-turbo': null }, []);
    expect(metricsModule.resolveSlug('openrouter/glm-5-turbo')).toBeNull();
  });

  it('a PARTIALLY wiped gdpval self-heals from gdpval_builtin', () => {
    // setGdpval() replaces wholesale — a scrape that keeps 'bb-one' but
    // drops 'bb-two' must re-add bb-two from cfg.gdpval_builtin on the
    // next resolveSlug call (the 13/148 scoring collapse class).
    metricsModule.setConfig({ ...testConfig, gdpval_builtin: { 'bb-one': 10, 'bb-two': 20 } });
    metricsModule.setGdpval({ 'bb-one': 10, 'scraped-x': 5 });
    metricsModule.resolveSlug('openrouter/scraped-x'); // triggers the heal
    const g = metricsModule.getGdpval();
    expect(g['bb-two']).toBe(20);
    expect(g['bb-one']).toBe(10);
  });

  it('cached LLM matches are CANONICALIZED like fresh matches', () => {
    metricsModule.setGdpval({ 'glm-53': 100, 'glm-5-3': 100 });
    metricsModule.setCache({
      model_score_cache: { 'mistral/cached-dup': 'glm-53', 'mistral/cached-num': 42 },
    } as any);
    // The cached duplicate spelling collapses to its canonical twin...
    expect(metricsModule.resolveSlug('mistral/cached-dup')).toBe('glm-5-3');
    // ...and a NON-STRING cache entry is ignored, not returned as a slug.
    expect(metricsModule.resolveSlug('mistral/cached-num')).toBeUndefined();
  });
});
