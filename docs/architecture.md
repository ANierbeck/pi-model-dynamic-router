# Architecture

## Overview

The pi-model-router extension dynamically routes model groups (strategic,
tactical, operational, scout, etc.) to concrete models based on intelligence
scores (GDPval), cost, availability, and user preferences.

## Key modules

### `src/metrics.ts` — Single source of truth for GDPval lookup

The **only** implementation of `lookupGdp`, `mapLookup`, `loadModelMap`,
`buildGdpvalIndex`. Previously duplicated between `index.ts` (closure) and
`metrics.ts` (export), which caused bugs when the two drifted. Now `index.ts`
delegates to `metricsModule.*`.

- `lookupGdp(ref)` — 3-tier resolution: model-map → token-set → LLM matches
- `setConfig(cfg)` / `setCache(cache)` — additive merge of gdpval scores
  (builtins + scraped). Self-healing: loads `cache.gdpval_scores` if `gdpval`
  is empty (race-condition guard).
- `getM(ref)` — returns Metrics; `gdpval` is always recomputed (never cached)
- `setLlmMatches(matches)` — sets the LLM-derived model→slug matches (tier 3)

### `src/model-matcher.ts` — LLM-assisted model matching

When the deterministic tiers (model-map + token-set) can't resolve a model,
this module asks a local LLM to match it to a known GDPval slug.

- `buildMatchPrompt(modelIds, gdpvalEntries)` — builds the prompt with
  generic rules: vendor-family matching, version precision, size-tier
  matching (small models must not match large-tier slugs).
- `parseMatchResponse(raw, validSlugs)` — validates LLM output, rejects
  hallucinated slugs not in the known set.
- `matchModelsWithLLMBatched(input)` — batches large model lists (40/batch)
  + pre-filters to plausible candidates (token overlap with a slug).
- `isPlausibleMatch(modelId, slug)` — safety net: rejects cross-family
  hallucinations (e.g. mistral → claude).

### `src/local-llm.ts` — Provider-agnostic local LLM caller

- `resolveLocalProvider(deps)` — discovers the local provider (Ollama OR
  LM Studio) generically, ranks by speed/suitability (not hardcoded to
  Ollama). `gemma2:2b` is ranked last (too weak for matching).
- `callLocalLlm(prompt, deps)` — calls the local provider via OpenAI
  `/chat/completions`, falls back to free OpenRouter cloud models on failure.
  Used only for GDPval model-slug matching (matching a discovered model ID
  against known leaderboard slugs) -- the prompt sent here is built from
  model IDs/labels, never user conversation content. Unconditional (not
  gated by an opt-in flag) because no user data is involved; contrast with
  the content-classifier's `classifier_cloud_fallback`, which does carry raw
  user prompt text and is opt-in for that reason.

### `src/rate-limit.ts` — Single source of truth for cooldown checks

`isRefLimited(limits, ref)` / `refLimitSecs(limits, ref)` are the **only**
implementation of "is this ref still in cooldown". `RateLimitManager`
(the owner of the state) and `routing.ts`'s `Router` class (constructed with
a reference to the *same* `Map`, not a copy) both delegate to these instead
of each keeping its own copy of the cooldown check. Previously the two
classes had byte-identical `isLimited`/`limitSecs` methods operating on the
same Map — a fix to one would silently not apply to the other. Consolidated
2026-09-01; see also the now-removed dead `isModelLimited`/`limitSecs` pair
that had drifted into `utils.ts` as an unused third copy.

### `src/budget.ts` — Single source of truth for subscription budget

`hasBudget(ref, providers, budgetCache)` is the **only** implementation of
"does this model still have subscription budget?". Previously duplicated
between `hasModelBudget` (index.ts) and `filterByBudget` (routing.ts); both
now delegate here.

### `src/exclude.ts` — Personalized support/no-support list

- `isExcluded(ref, ctx)` — checks provider, model-pattern (glob), and
  `paid_models_from` rules. Applied in `generateDynamicConfig` (config
  generation) AND `routing.ts` `allDiscoveredRefs()` (live TUI table).

### `src/config-loader.ts` — Layered configuration

- `loadLayeredConfig(extDir, cwd)` — deep-merges 3 layers:
  1. Embedded defaults (`router-config.json`)
  2. Global user override (`~/.pi/agent/router-config.user.json`)
  3. Project-local override (`<cwd>/.pi/router-config.json`)
- Arrays replace (not merge); nested objects merge recursively.

### `src/routing.ts` — Router class

- `allDiscoveredRefs()` — returns all available model refs, filtered by
  global exclude rules + session scoping.
- `getTopModels(group, n)` — top N candidates for a group, used by the
  `/router` TUI table.

## Configuration

See `docs/config-override.md` for the layered config system and exclude rules.

## Duplication cleanup log

Recurring pattern in this codebase: a helper gets copy-pasted into a second
location instead of imported, the two copies drift (different behavior) or
one becomes dead code (unused but never deleted). Each pass below found and
fixed instances; new instances should be consolidated the same way — one
exported function in the module that owns the concern, everything else
delegates.

- **2026-08 (pre-1.5.0)**: `lookupGdp`/`mapLookup`/`buildGdpvalIndex` were
  duplicated between `index.ts` (closure) and `metrics.ts` (export) →
  consolidated into `metrics.ts` (see above). `hasModelBudget`/`filterByBudget`
  duplicated between `index.ts` and `routing.ts` → consolidated into
  `budget.ts`. `isFreeModel`/exclude-list "is this free" logic duplicated
  between `metrics.ts` and `exclude.ts` → consolidated into `isFreeModelRef`
  in `metrics.ts`.
- **2026-09-01**: `Router.isLimited`/`limitSecs` (routing.ts) reimplemented
  `RateLimitManager.isLimited`/`limitSecs` (rate-limit.ts) verbatim over the
  same shared `Map` → consolidated into `isRefLimited`/`refLimitSecs` in
  `rate-limit.ts`. Found in the process: `utils.ts` carried three pieces of
  dead code — a second `stripProvider` with *different* semantics than the
  one actually used in `metrics.ts` (unconditional strip vs. known-provider-
  only strip, never imported), and an orphaned `isModelLimited`/`limitSecs`
  pair (a third, unused copy of the same cooldown check). All removed.
  `index.ts`'s local `fmt`/`fmtTime` were full reimplementations of the
  `utils.ts` versions rather than delegates (unlike `getM`/`effCost`/
  `lookupPrice`/etc., which already delegated correctly) → now imported from
  `utils.ts` instead.

## Testing

- `test/refactor-golden-master.test.ts` — pins behaviour across refactors (includes the GLM-5-2 end-to-end regression block)
- `test/metrics-selfheal.test.ts` — self-healing + model-map precedence
- `test/model-matcher-plausibility.test.ts` — cross-family hallucination guard
- `test/routing-exclude.test.ts` — exclude rules in live table
