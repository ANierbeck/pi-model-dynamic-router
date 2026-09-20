/**
 * Dedup identity for -latest aliases and dated snapshots (design:
 * docs/plans/2026-09-20-latest-alias-slug-matching-design.md).
 *
 * With the slug-matcher fix, mistral-medium-latest, mistral-medium-2604 and
 * mistral-medium-3.5 all resolve to the same GDPval slug — but that only
 * helps if every path that CLUSTERS models by identity actually uses the
 * matched slug, and prefers the canonical (versioned, real) ref as the
 * representative:
 *
 * - Live path (routing.ts): the inline representative loop collapses by
 *   getMatchedSlug but picks "first by rank" — an alias form could
 *   represent the cluster. Extracted into pickSlugClusterRepresentatives
 *   with preference: (1) not rate-limited, (2) canonical (ref ≡ slug),
 *   (3) first by rank.
 * - Persist path (dynamic-config.ts collectGroupModels): deduplicated by
 *   token signature only — mistral-medium-3.5 and mistral-medium-latest
 *   have different token sets and BOTH survived into generated groups.
 *   Now dedups by getMatchedSlug ?? token signature, canonical replacing
 *   alias forms within the same slug key.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as metricsModule from '../src/metrics.ts';
import { pickSlugClusterRepresentatives } from '../src/routing.ts';
import { collectGroupModels, ModelWithMetadata } from '../src/dynamic-config.ts';

const GDPVAL_SCORES: Record<string, number> = {
  'mistral-medium-3-5': 933,
  'mistral-small-3-1': 421,
  'mistral-small-3-2': 478,
  'zai-glm-5-2': 1497,
  'zai-glm-5-3': 1645,
  devstral: 585,
};

function withMeta(ref: string, gdpval: number): ModelWithMetadata {
  return {
    ref,
    gdpval,
    cost: 0.4,
    price: { input: 0.4, output: 1.2 },
    isFreeModel: false,
    contextWindow: 128_000,
  };
}

describe('pickSlugClusterRepresentatives (live-path dedup)', () => {
  beforeEach(() => {
    metricsModule.setConfig({ model_groups: {}, model_metrics: {}, providers: {} } as any);
    metricsModule.setCache({ gdpval_scores: GDPVAL_SCORES, available_models: [] } as any);
    metricsModule.setGdpval({});
  });

  it('collapses -latest, dated snapshot and canonical form to the CANONICAL representative', () => {
    // Rank order (input) deliberately puts the alias first — the cluster
    // representative must still be the canonical versioned ref.
    const reps = pickSlugClusterRepresentatives(
      ['mistral/mistral-medium-latest', 'mistral/mistral-medium-3.5', 'mistral/mistral-medium-2604'],
      () => false
    );
    expect(reps).toEqual(['mistral/mistral-medium-3.5']);
  });

  it('prefers a non-limited alias over a rate-limited canonical ref (usability beats labeling)', () => {
    const limited = new Set(['mistral/mistral-medium-3.5']);
    const reps = pickSlugClusterRepresentatives(
      ['mistral/mistral-medium-3.5', 'mistral/mistral-medium-2604'],
      (ref) => limited.has(ref)
    );
    expect(reps).toEqual(['mistral/mistral-medium-2604']);
  });

  it('keeps first-occurrence order across different clusters', () => {
    const reps = pickSlugClusterRepresentatives(
      ['mistral/mistral-small-latest', 'mistral/zai-glm-5-3', 'mistral/mistral-small-3-2'],
      () => false
    );
    // small-latest and small-3-2 are the same slug (mistral-small-3-2);
    // zai-glm-5-3 is its own cluster.
    expect(reps).toEqual(['mistral/mistral-small-3-2', 'mistral/zai-glm-5-3']);
  });

  it('falls back to ref-as-identity for refs with no matched slug', () => {
    const reps = pickSlugClusterRepresentatives(
      ['ollama/custom-finetune', 'ollama/custom-finetune'],
      () => false
    );
    expect(reps).toEqual(['ollama/custom-finetune']);
  });

  it('keeps separate models separate (mistral-small-3-1 vs mistral-small-3-2 clusters)', () => {
    const reps = pickSlugClusterRepresentatives(
      ['mistral/mistral-small-3-1', 'mistral/mistral-small-3-2'],
      () => false
    );
    expect(reps.sort()).toEqual(['mistral/mistral-small-3-1', 'mistral/mistral-small-3-2'].sort());
  });
});

describe('collectGroupModels (persist-path dedup by slug)', () => {
  beforeEach(() => {
    metricsModule.setConfig({ model_groups: {}, model_metrics: {}, providers: {} } as any);
    metricsModule.setCache({ gdpval_scores: GDPVAL_SCORES, available_models: [] } as any);
    metricsModule.setGdpval({});
  });

  afterEach(() => {
    metricsModule.setCache({ gdpval_scores: {}, available_models: [] } as any);
  });

  it('collapses alias, snapshot and canonical form to ONE canonical entry', () => {
    const sorted = [
      withMeta('mistral/mistral-medium-3.5', 933),
      withMeta('mistral/mistral-medium-latest', 933),
      withMeta('mistral/mistral-medium-2604', 933),
    ];
    const result = collectGroupModels(
      { min_gdpval: 0, fallback_groups: [] },
      [],
      sorted,
      { model_groups: {}, model_metrics: {}, providers: {} } as any,
      new Set()
    );
    expect(result).toEqual(['mistral/mistral-medium-3.5']);
  });

  it('keeps different models separate and preserves priority order', () => {
    const sorted = [
      withMeta('mistral/zai-glm-5-3', 1645),
      withMeta('mistral/mistral-medium-3.5', 933),
    ];
    const result = collectGroupModels(
      { min_gdpval: 0, fallback_groups: [] },
      [],
      sorted,
      { model_groups: {}, model_metrics: {}, providers: {} } as any,
      new Set()
    );
    expect(result).toEqual(['mistral/zai-glm-5-3', 'mistral/mistral-medium-3.5']);
  });

  it('replaces a first-seen alias with the canonical ref when both are in the pool', () => {
    // Sorted order deliberately puts the alias first (e.g. cost tie-break).
    const sorted = [
      withMeta('mistral/mistral-small-latest', 478),
      withMeta('mistral/mistral-small-3-2', 478),
    ];
    const result = collectGroupModels(
      { min_gdpval: 0, fallback_groups: [] },
      [],
      sorted,
      { model_groups: {}, model_metrics: {}, providers: {} } as any,
      new Set()
    );
    expect(result).toEqual(['mistral/mistral-small-3-2']);
  });

  it('does not let a static curated alias entry duplicate its dynamic canonical sibling', () => {
    const sorted = [withMeta('mistral/mistral-medium-3.5', 933)];
    const result = collectGroupModels(
      { min_gdpval: 0, models: ['mistral/mistral-medium-latest'], fallback_groups: [] },
      [],
      sorted,
      { model_groups: {}, model_metrics: {}, providers: {} } as any,
      new Set()
    );
    expect(result).toEqual(['mistral/mistral-medium-latest']);
    // The static curated entry wins (hand-curated allow-list is explicit
    // user intent) — but the dynamic canonical sibling must NOT add a
    // second entry for the same model.
    const resultBoth = collectGroupModels(
      { min_gdpval: 0, models: ['mistral/mistral-medium-latest'], fallback_groups: [] },
      [],
      [withMeta('mistral/mistral-medium-3.5', 933)],
      { model_groups: {}, model_metrics: {}, providers: {} } as any,
      new Set()
    );
    expect(resultBoth).toHaveLength(1);
  });
});
