# ADR-0012: Model identity — slug resolution tiers and canonical cluster dedup

**Status**: Accepted (documented retroactively 2026-09-26). Decisions made
between 2026-08-23 and 2026-09-20. Sources: `src/metrics.ts`
(`resolveSlug`, `getSlugCanon`, `getMatchedSlug`, `lookupGdp`),
`src/slug-matcher.ts`, `src/model-matcher.ts`, `src/routing.ts`
(`pickSlugClusterRepresentatives`, `dedupByModelIdentity`),
`src/dynamic-config.ts` (`collapseSameSlugClusters`, `collectGroupModels`),
`model-map.yaml`, design doc
`docs/plans/2026-09-20-latest-alias-slug-matching-design.md`.

## Context

The router ranks models by GDPval scores scraped from artificialanalysis.ai.
Those scores are keyed by **slugs** (`glm-5-2`, `mistral-medium-3-5`).
Provider model ids look different and come in many spellings for one
model: `-latest` aliases, dated snapshots (`mistral-medium-2604`),
vendor prefixes (`zai-glm-5-2`), `:free` suffixes, dots vs dashes. The
scrape itself lists some models twice (`glm-53` next to `glm-5-3`).

Two problems follow from this:
1. **Scoring:** an id must map to the right slug. Wrong matches were real
   incidents: `zai-glm-5-2` scored as `glm-4` (400 instead of ~1500), and
   Turbo/Flash variants matched to their base model.
2. **Identity:** the same model must appear once per group, not three
   times (the 2026-09-20 `/router` panel listed `zai-glm-5`,
   `zai-glm-latest` and `zai-glm-5-3` as separate models). The dedup must
   keep the *honest* variant. Cost gates previously dropped the
   registry-priced twin first and kept a `$0` scan alias.

## Decision Drivers

- Scoring and dedup must agree on identity. Two resolvers drift.
- Explicit human knowledge beats heuristics (model-map.yaml).
- An LLM match can hallucinate across families, so it needs a guard.
- Gates (quality, cost) must act on the canonical model, never on an alias
  with a placeholder price.

## Options Considered

- **Pure fuzzy matching.** Cheap, but it cannot tell `glm-5-2` from
  `glm-5-3` or dated snapshots from versions. The GLM incidents came from
  this.
- **Pure LLM matching.** Understands versions, but hallucinates
  cross-family matches (guarded by `isPlausibleMatch`) and needs a local or
  cloud LLM at scan time.
- **Tiered pipeline with explicit override first (accepted).**

## Decision

1. **One resolver for scoring and dedup** (`resolveSlug`). `getMatchedSlug`
   is a thin wrapper, so dedup and `lookupGdp` cannot disagree.
2. **Tier order**:
   - Tier 0: `model-map.yaml`. An explicit slug is authoritative, and an
     explicit `null` excludes the model.
   - Tier 1: LLM match (in-memory, then `cache.model_score_cache`). It is
     batched, pre-filtered for plausibility (token overlap), and guarded
     against cross-family hallucination and non-existent slugs.
   - Tier 2: algorithmic `matchSlug`. `-latest` and dated snapshots resolve
     to the **newest** version of the family, and major-version checks
     keep `glm-4` away from `glm-5-2`.
   - Token-set fallback for score lookup.
3. **Canonicalization**: duplicate scrape spellings collapse to their
   dashed twin only when the twin exists **and** has the same score.
   Score-different twins stay distinct (`glm-52` is the non-reasoning
   variant).
4. **Self-healing**: `gdpval` is restored from `cache.gdpval_scores` when
   empty, and `gdpval_builtin` is re-applied when a fresh scrape wiped it
   (the 13/148 scoring collapse, 2026-08-23; guarded by `scan-sanity.ts`).
5. **Dedup before gates**: same-provider slug clusters collapse to their
   canonical representative *before* quality and cost gates, on both
   paths (`applyGroupFilters` live, `collapseSameSlugClusters` persist).
   Live representative choice: not rate-limited > canonical id > rank.
   Cross-provider same-slug variants stay separate as failover candidates,
   ordered consecutively. The display collapses them to one row.

## Consequences

- Adding a model family usually needs no code: model-map.yaml for
  exceptions, the matcher for the rest.
- A wrong slug silently mis-ranks a model. model-map.yaml is the fix, and
  `test/model-map-live.test.ts` pins critical entries (GLM).
- Two dedup implementations (live and persist) exist for the same rule, as
  with the filters in ADR-0010.

Tests pinning this: `slug-matcher`, `slug-matcher-latest-dates`,
`slug-canon-dedup`, `slug-dedup-canonical`, `unified-slug-resolution`,
`model-matcher*`, `metrics-selfheal`, `model-map-live`,
`get-top-models-dedup`, `scan-sanity`, `refactor-golden-master`.
