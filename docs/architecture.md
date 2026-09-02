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

### `src/stream-orchestrator.ts` — Stream orchestration (extracted from index.ts)

`groupStream` (~430 lines) and `driveStream` (~950 lines) were moved out of
`index.ts` into this module. The orchestrator is constructed via
`buildOrchestratorContext()`, a factory that exposes **live getters** for
`router`, `rateLimitManager`, and `cacheManager` — not plain properties.

- **Why live getters (not plain properties):** `load()` reassigns all three
  on every `session_start` and tool invocation (6 call sites). A plain
  property captured at `StreamOrchestrator` construction time would be
  orphaned after the first `load()` — `ctx.isLimited()` (live closure) would
  correctly report models as rate-limited, but `ctx.router.limitSecs()`
  would read a stale disconnected Map and always return 0, producing the
  self-contradictory "still in cooldown (0s remaining)" log and breaking the
  total-cooldown-collapse force-retry logic (couldn't rank candidates by
  real cooldown → re-trying genuinely-limited models in a loop). This was
  a live bug (2026-09-02, "running in circles"); fixed by converting to
  live getters matching the existing `cfg`/`cache`/`activeGroup` pattern.
- **Per-provider error isolation in `registerGroupModels`:** the whole
  per-provider body (the `find()` loop, `existingModels` construction, and
  `registerProvider` call) is wrapped in one try/catch so a throw for any
  single provider only skips that provider, not the whole `PROVIDER_MAP`
  iteration. The Ü1 guard checks models individually: if pi knows ALL →
  skip; if pi knows SOME → register only the new ones, round-tripping pi's
  existing entries (compat flags included) so `registerProvider`'s
  replace-semantics don't delete them. See ADR 0005.

### `src/detection.ts` — Error event detection (single source of truth)

Exports the unified text-pattern detection for stream error events:

- `isRateLimitText(text)` — rate-limit detection for `consumeWithDetection`
- `isOverflowErrorText(text)` / `isOverflowDeltaText(text)` — context-
  window overflow (broad for error events, narrow for assistant prose)
- `isRateLimitLikeReason(reason)` — structured-reason gate for the paid-
  cloud escalation path. `provider_error` is intentionally NOT in this set
  (it's too generic — covers cascade aborts, network errors, AND real rate
  limits). Only `empty_response`, `empty_timeout`, `stall_timeout` remain
  as rate-limit-shaped.
- `isAbortLikeText(text)` — catches free-text abort signals ("This
  operation was aborted") inside generic error events without structured
  `reason:'aborted'`, routing them through the non-escalating abort path
  instead of a 2-hour hard cooldown. This was the root cause of
  `pi-claude/claude-sonnet-5` being locked out after a cascade abort
  (roborev finding F10, 2026-09-02): the abort text was misclassified as a
  paid-cloud rate-limit failure.
- `parseResetAtMs(text)` — parses "resets ..." wall-clock reset times.

Previously `index.ts` had `isRateLimitText` (15 patterns) AND
`isRateLimitError` (7 patterns, dead code) — divergent. Consolidated here;
`index.ts` imports the unified functions.

### `src/discovery.ts` — `getCheapestCloudModels()`

`getCheapestCloudModels()` dynamically discovers the cheapest cloud models
for the classifier's cloud fallback (when `classifier_cloud_fallback: true`
is set on the `dynamic` group). It filters by `lookupPrice(ref)` and requires
`price.output <= $5/M`. **Known limitation (finding F3, 2026-09-02):**
subscription models (`mistral-zai/*`, including the user's free-to-them
GLM-5.2) have no pricing data in the OpenRouter pricing cache → `lookupPrice`
returns `null` → they are filtered out. The classifier's cloud fallback
therefore never tries `mistral-zai/glm-5-2`, only free OpenRouter models. A
correct fix needs real per-token pricing data, not a bigger scope; documented
inline in `src/discovery.ts`.

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
- **2026-09-02**: `groupStream` (~430 lines) and `driveStream` (~950 lines)
  extracted from `index.ts` into `src/stream-orchestrator.ts`, accessed via
  `buildOrchestratorContext()` (live getters for `router`/
  `rateLimitManager`/`cacheManager`). `isRateLimitText`/`isRateLimitError`
  (divergent, the latter dead code) in `index.ts` consolidated into
  `src/detection.ts` (`isRateLimitText`, `isRateLimitLikeReason`,
  `isAbortLikeText`, `parseResetAtMs`). Custom HTTP client `src/cloud-client.ts`
  deleted; classifier cloud fallback now uses pi's `modelRegistry.completeSimple`
  (see ADR 0004).

## Testing

- `test/refactor-golden-master.test.ts` — pins behaviour across refactors (includes the GLM-5-2 end-to-end regression block)
- `test/metrics-selfheal.test.ts` — self-healing + model-map precedence
- `test/model-matcher-plausibility.test.ts` — cross-family hallucination guard
- `test/routing-exclude.test.ts` — exclude rules in live table
