// test/unified-slug-resolution.test.ts
// Regression guard for the "two slug resolution paths" bug.
//
// BACKGROUND: lookupGdp() (scoring) consulted model-map.yaml as Stage 0,
// but getMatchedSlug() (dedup) did NOT — it only checked the LLM-match
// cache and the fuzzy slug-matcher. So mistral-medium-2604 / -3.5 / -latest
// all scored the same (933, via model-map) but were NOT deduped (dedup's
// weaker matcher didn't resolve them to the same slug). Three identical
// models appeared in every group.
//
// FIX: both now go through the unified resolveSlug() pipeline
// (model-map.yaml → LLM-match → fuzzy matcher). This test pins that
// dedup and scoring can never disagree on model identity.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  lookupGdp,
  getMatchedSlug,
  resolveSlug,
  setConfig,
  setCache,
  setGdpval,
  setModelMap,
  setLlmMatches,
} from '../src/metrics.js';
import type { Config, Cache } from '../src/types.js';

beforeEach(() => {
  setConfig({ model_groups: {}, model_metrics: {}, gdpval_builtin: {} });
  setGdpval({});
  setCache({});
  setLlmMatches({});
});

describe('unified slug resolution — dedup & scoring use the SAME path', () => {
  it('model-map entries resolve to the same slug for getMatchedSlug AND lookupGdp', () => {
    // model-map.yaml explicitly maps all three Mistral-Medium variants to
    // the same slug. Both resolvers must agree.
    setModelMap(
      {
        'mistral-medium-2604': 'mistral-medium-3-5',
        'mistral-medium-3.5': 'mistral-medium-3-5',
        'mistral-medium-latest': 'mistral-medium-3-5',
      },
      []
    );
    setGdpval({ 'mistral-medium-3-5': 933 });

    const refs = [
      'mistral/mistral-medium-2604',
      'mistral/mistral-medium-3.5',
      'mistral/mistral-medium-latest',
    ];

    // All three resolve to the same slug via the unified pipeline.
    const slugs = refs.map((r) => resolveSlug(r));
    expect(slugs[0]).toBe('mistral-medium-3-5');
    expect(slugs[1]).toBe('mistral-medium-3-5');
    expect(slugs[2]).toBe('mistral-medium-3-5');

    // getMatchedSlug returns the same slug for all three → dedup will collapse them.
    expect(getMatchedSlug('mistral/mistral-medium-2604')).toBe('mistral-medium-3-5');
    expect(getMatchedSlug('mistral/mistral-medium-latest')).toBe('mistral-medium-3-5');

    // lookupGdp returns the same score for all three → scoring is consistent.
    expect(lookupGdp('mistral/mistral-medium-2604')).toBe(933);
    expect(lookupGdp('mistral/mistral-medium-latest')).toBe(933);
  });

  it('explicit null in model-map excludes the model for BOTH resolvers', () => {
    setModelMap({ 'mistral-medium-turbo': null }, []);
    setGdpval({ 'mistral-medium-3-5': 933 });

    expect(resolveSlug('mistral/mistral-medium-turbo')).toBeNull();
    expect(getMatchedSlug('mistral/mistral-medium-turbo')).toBeNull();
    expect(lookupGdp('mistral/mistral-medium-turbo')).toBeNull();
  });

  it('when model-map has no entry, falls back to LLM-match then fuzzy (same for both)', () => {
    setModelMap({}, []);
    setLlmMatches({ 'mistral/llm-matched-model': 'some-slug' });
    setGdpval({ 'some-slug': 500 });

    expect(resolveSlug('mistral/llm-matched-model')).toBe('some-slug');
    expect(getMatchedSlug('mistral/llm-matched-model')).toBe('some-slug');
    expect(lookupGdp('mistral/llm-matched-model')).toBe(500);
  });

  it('dedup collapses three model-map-aliased variants to one (integration)', () => {
    // Reproduces the user-reported bug: three identical Mistral-Medium
    // variants all appeared in the /router table. With unified resolution,
    // dedupByModelIdentity (which calls getMatchedSlug) must collapse them.
    setModelMap(
      {
        'mistral-medium-2604': 'mistral-medium-3-5',
        'mistral-medium-3.5': 'mistral-medium-3-5',
        'mistral-medium-latest': 'mistral-medium-3-5',
      },
      []
    );
    setGdpval({ 'mistral-medium-3-5': 933 });

    // Simulate dedupByModelIdentity's key step: group by provider:slug.
    const refs = [
      'mistral/mistral-medium-2604',
      'mistral/mistral-medium-3.5',
      'mistral/mistral-medium-latest',
    ];
    const byKey = new Map<string, string>();
    for (const ref of refs) {
      const slug = getMatchedSlug(ref);
      expect(slug).not.toBeNull();
      const key = `mistral:${slug}`;
      if (!byKey.has(key)) byKey.set(key, ref);
    }
    // Only one provider:slug bucket → only one model survives dedup.
    expect(byKey.size).toBe(1);
  });
});
