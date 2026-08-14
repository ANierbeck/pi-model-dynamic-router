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

## Testing

- `test/refactor-golden-master.test.ts` — pins behaviour across refactors
- `test/metrics-selfheal.test.ts` — self-healing + model-map precedence
- `test/model-matcher-plausibility.test.ts` — cross-family hallucination guard
- `test/routing-exclude.test.ts` — exclude rules in live table
- `test/glm-live-debug.test.ts` — GLM-5-2 end-to-end regression
