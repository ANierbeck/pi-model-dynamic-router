# Changelog

## [Unreleased] — HINT cooldown-clearing fix

### Fixed
- **HINT resolution no longer clears cooldowns it shouldn't.** Two related
  bugs, both causing the same symptom — a model that had just hard-failed
  being retried again within seconds, over and over, looking like the whole
  session had hung:
  - Pi's client re-sends every message with a `HINT: <currently selected
    model/group>` prefix reflecting the model/group picked in the UI. When
    that resolves to a model-type hint, the router used to clear rate-limit
    cooldowns not just for the hinted model, but for its up-to-5
    auto-appended fallback candidates too — on every single turn. Those
    fallbacks were never a deliberate user choice, so wiping their cooldowns
    defeated the router's own backoff protection every turn. Fallback
    cooldowns are no longer cleared; only the literal HINT target's cooldown
    is (that one *is* a deliberate choice).
  - During compaction, `classifyPrompt()` hints back to `context.lastModel`
    for model continuity. If `lastModel` had just failed and was sitting in
    cooldown, this hint resolved through the same clear-cooldown path and
    retried the broken model immediately, every compaction turn. The
    classifier now receives `lastModelLimited` and skips the continuity hint
    (routing to `strategic` instead) when the last model is currently in
    cooldown. `HintClassificationResult` gained an `origin: 'user' | 'auto'`
    field so the router can tell a deliberate user/UI selection from a
    router-generated preference.
- **Context-window guard undercounted array-shaped message content.**
  `estimateContextTokens()` only summed `string` message content; messages
  whose content is an array of blocks (tool_result, tool_use, image — the
  shape Pi actually uses for tool turns) counted as 0 tokens. After a long
  session under a 1M-context model, switching to a smaller group massively
  undercounted the real token total, so the pre-flight context-window guard
  in `driveStream` never fired and every candidate was tried and hung for
  minutes instead of being skipped. Array content is now serialised
  block-by-block before estimating.
- **Runtime context-overflow detection.** Even with the token estimate
  fixed, a provider can still reject an oversized prompt at request time
  (Mistral: "too large for model with N maximum context length"). This used
  to surface as a generic `empty_response`/soft failure, so `driveStream`
  ground through the rest of the (equally oversized) candidate list instead
  of triggering compaction. `consumeWithDetection` now recognises overflow
  patterns in error/text content and reports `reason: 'context_overflow'`,
  which `driveStream` turns into the same native-style overflow signal used
  by the pre-flight guard — short-circuiting immediately instead of trying
  (and hanging on) further candidates.

## [1.4.0] — 2026-08-16 — Reliability: cycles, runaway retries, externalized deps, context-overflow, reasoning timeout

### Added
- **LLM-assisted model matching** (`src/model-matcher.ts`): when the
  deterministic model-map + token-set fallback can't resolve a model, a local
  LLM matches it to a known GDPval slug. Batched (40/batch) with plausibility
  pre-filtering. Results cached in `scan-cache.json`.
- **Provider-agnostic local LLM caller** (`src/local-llm.ts`): discovers the
  local provider (Ollama OR LM Studio) generically. Falls back to free
  OpenRouter cloud models on local failure. Model ranking prefers capable
  but fast models (gemma4:12b > qwen3.5 > gemma2:2b-last-resort).
- **Personalized exclude rules** (`src/exclude.ts`): `exclude.providers`,
  `exclude.models` (glob), `exclude.paid_models_from` in `router-config.json`.
  Applied to all groups before per-group filtering.
- **Layered configuration** (`src/config-loader.ts`): deep-merge embedded
  defaults → global user override (`~/.pi/agent/router-config.user.json`) →
  project-local override (`<cwd>/.pi/router-config.json`).
- **Cross-family hallucination guard** (`isPlausibleMatch`): rejects LLM
  matches across different vendors (mistral→claude, qwen→gpt).
- **TAB-completion** for `/router` sub-commands and group names.
- **Architecture docs** (`docs/architecture.md`, `docs/config-override.md`).

### Changed
- **Single source of truth for `lookupGdp`**: removed the duplicated closure
  implementation in `index.ts`. All GDPval lookup now goes through
  `metrics.ts`. This eliminates the "dynamic config has GLM but TUI table
  doesn't" class of bugs.
- **`getM(ref)` no longer caches `gdpval`**: always recomputed from current
  `lookupGdp` state. Prevents stale scores after config reloads.
- **`loadModelMap` logs parse errors loudly** (was silently swallowed, which
  hid duplicate-YAML-key bugs).
- **`/router` sub-commands simplified**: removed `reload`, `sync`, `reset`
  (overlapping with automatic session-start behaviour). Only `scan` remains.
- **Prompt is now generic** — vendor, version, and size-tier rules are
  conveyed to the LLM as principles, not hardcoded to specific model names.

### Fixed
- GLM-5-2 missing from router table (two `lookupGdp` implementations drifted)
- `mistral-medium-2604` matched to `claude-opus-5` (cross-family hallucination)
- `ministral-3b-latest` matched to `mistral-medium-3-5` (size-tier mismatch)
- `model-map.yaml` duplicate keys silently disabling all map overrides
- `gdpval` scores lost during `load()` race-condition (self-healing added)
- `metrics.ts` `modelMap` never loaded (only the closure version was)
- Exclude rules not applied to live TUI table (only to dynamic config)
- `/router reset` deleting GDPval scores (command removed)

### Added (this iteration)
- **Context-overflow → native compaction.** When switching from a
  large-context model (e.g. Gemini 2.5 Pro @ 1M) to a Dynamic group, the
  conversation can exceed every candidate's context window. Previously,
  `driveStream` skipped each candidate before the request ever reached a
  provider — so no provider returned an overflow error, so Pi's native
  compaction never fired, so the conversation never shrank, so the session
  froze in an infinite skip loop on every turn. Now, when ALL candidates fail
  ONLY because of context-window size, `driveStream` emits a native-style
  overflow error (the Anthropic "prompt is too long" pattern that
  `@earendil-works/pi-ai/utils/overflow` recognises). Pi detects it, runs its
  own compaction with an appropriate model, and retries.
- **Total cooldown collapse → force-retry shortest.** When every candidate
  across every group in the fallback cascade is in cooldown (no other error
  types), the router used to hard-fail with a generic "All N candidates
  failed" that surfaced as Pi's opaque "Unknown error" — the session froze
  until the longest cooldown expired. Now `driveStream` picks the candidate
  with the shortest remaining cooldown and retries it directly, bypassing the
  router-internal `isLimited()` guard (the cooldown is a heuristic, not a
  hard provider limit, so the request may well succeed). The collapse is
  logged for post-hoc analysis (`Total cooldown collapse — ...`).
- **Longer first-token timeout for reasoning models.** Reasoning/thinking
  models (those advertising a `reasoning` capability) think internally before
  emitting the first output token, so a 30s first-token timeout (fine for
  instant chat models) aborts them mid-thought when the provider is under
  load — producing a false "empty response" and a soft-failure cooldown. The
  router then re-picks the same model on the next turn (it's still the
  best-ranked) and the same timeout fires again: a silent infinite loop that
  looks like "model never succeeds" even though the model was just slow.
  Reasoning models now get 90s by default. Both timeouts are configurable in
  `router-config.json` (`empty_response_timeout_ms`,
  `reasoning_empty_response_timeout_ms`).

### Changed (this iteration)
- **`@earendil-works/pi-ai` is no longer bundled.** esbuild now marks it
  `--external`, and it stays in `peerDependencies` + `devDependencies` (types
  only). This was the root cause of `host pi-ai lacks createProvider; refusing
  to register` — the router shipped a stale bundled copy of pi-ai (pre-
  `createProvider`) that shadowed the host's newer one, breaking extensions
  like `@vanillagreen/pi-claude-bridge` that rely on `piAi.createProvider`.

### Fixed (this iteration)
- **Fallback-group recursion → `Maximum call stack size exceeded`.** The
  auto-generated `fallback_groups` form a full permutation of all groups, so
  e.g. `tactical`'s first fallback is `strategic` and `strategic`'s first
  fallback is `tactical`. `getFallbackGroup` always returned the first
  unfiltered entry, so when every candidate in both groups failed, `driveStream`
  bounced between them forever. `driveStream` now threads a `visitedGroups`
  set and `getFallbackGroup` accepts a `visited` set to skip already-tried
  groups — cycle-safe regardless of how `fallback_groups` is configured.
- **Skip path (null return from `tryStream`) never accrued a malus.** When
  `tryStream` returned `null` instead of throwing — "not registered in Pi's
  model registry", "no API key", "provider is a group" — `driveStream` recorded
  the reason for the error message but never called `recordSoftFailure()`. A
  structurally-broken candidate (one that can't become usable mid-session) was
  therefore re-attempted from scratch on **every single request**, with no
  cooldown and no model-health demotion. In one long subagent session this
  produced 1.3M+ identical "not registered" log lines over ~17h. The skip
  branch now calls `recordSoftFailure(ref)`, so these candidates enter the
  normal soft-backoff ladder (30s → 60s → 2min → 5min) and get demoted by
  `model-health.ts`'s `failureStreak` scoring — exactly the persistent malus
  that already existed for thrown errors.
- **Exclude rules lost in dynamic config.** `generateDynamicConfig()` used the
  previously-generated dynamic config as its base (`...cfg`) instead of the
  layered static config (`staticCfg`), so stale `exclude.models` (e.g. missing
  `*opus*`) silently persisted. Both the generation path and the load path now
  force `exclude = staticCfg.exclude` — `staticCfg` is the single authority.
