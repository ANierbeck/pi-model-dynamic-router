# Changelog

## [1.4.1] — 2026-08-27 — Internal cleanup, Ollama scoring fix, doc consistency

### Fixed
- **Runtime context-overflow detection could false-positive on legitimate
  assistant prose.** Several `OVERFLOW_PATTERNS` entries (`'context window'`,
  `'maximum context'`, `'context length is'`) are generic English phrases,
  not provider error signatures, and were matched against the model's own
  streamed *answer* text, not just error content. Since this router's own
  domain is context-window/compaction, a legitimate response discussing "the
  context window guard" or "maximum context length" could trip detection,
  truncating a valid response and triggering unwanted compaction. Overflow
  detection on `text_delta` content now uses a narrow set of highly-specific
  provider rejection phrasings (`'too large for model with'`, `'prompt is too
  long'`, `'exceeds the maximum context length'`, `'exceeds the context
  window'`); the broad pattern list is still used for `error` events, which
  come from provider/transport infrastructure and can't contain assistant
  prose. (roborev job 203)
- **Runtime overflow error message now surfaces the provider's own reported
  numbers** (e.g. Mistral's "300000 tokens ... 262144 maximum") instead of
  only the router's own token estimate, which can be inaccurate. (roborev job
  203)

### Tests
- `test/runtime-overflow-detection.test.ts` — added a regression test for
  the false-positive scenario: a legitimate assistant response containing
  "context window"/"maximum context length" phrasing must pass through
  untouched.

### Removed
- **Dead `buildMatchPrompt()` / `matchModelsWithLLM()` code path.** Never
  called from `index.ts` — only `matchModelsWithLLMBatched()` (via
  `buildMatchPromptWithCandidates()`) is wired into the LLM model-matching
  pipeline. Before removal, the still-useful parts of the retired prompt
  (an explicit vendor/family rule, and a generalized instruction for
  date-suffix → named-version reasoning) were ported into
  `buildMatchPromptWithCandidates()` as defense-in-depth on top of the
  existing structural enforcement (`candidateSlugs()` pre-filtering +
  `isPlausibleMatch()`). Also removed the test file that exclusively
  exercised the dead function; equivalent coverage already exists in
  `test/model-matcher-batched.test.ts` for the live path.

### Fixed (roborev, post-refactor pass)
- **Ollama GDPval family-score matching silently returned the wrong
  (lower, generic) score for every versioned model family.**
  `estimateOllamaGdpval()` iterated `MODEL_FAMILY_SCORES` in object
  insertion order and matched via `normalizedName.includes(family)` with a
  first-match break. Generic keys (`'qwen'`, `'gemma'`, `'llama3'`,
  `'mistral'`) are inserted before their more specific variants
  (`'qwen3.8'`, `'gemma4'`, `'llama3.2'`, `'mistral-large'`) and are
  substrings of them, so the generic entry always won — every specific
  score was unreachable dead code. `qwen3.8:27b-mlx` silently scored via
  the generic `'qwen'` entry (450) instead of the intended `'qwen3.8'`
  entry (580), even though the existing test asserted the
  coincidentally-plausible generic result with a comment claiming it was
  the specific one. Fixed by matching against family keys sorted
  longest-first. Fixing this surfaced a second, independent bug: name
  normalization stripped hyphens, so hyphenated family keys
  (`'mistral-small/-medium/-large'`, `'deepseek-coder'`) could never match
  regardless of iteration order, since the hyphen in the key no longer
  existed in the string being searched. Hyphens are now preserved during
  normalization.
- **`isExpectedTransientError()` reintroduced a duplicate, narrower
  rate-limit pattern list** instead of delegating to the unified
  `isRateLimitText()` table added earlier in this cycle specifically to
  stop two pattern lists from drifting apart. Now delegates directly,
  keeping only the unrelated `'no api provider registered'` check as its
  own condition.
- **Remaining German user-facing router-info messages translated to
  English.** Six occurrences across the empty-response/timeout/rate-limit/
  repetition-loop error paths (e.g. "Rate-Limit/Spend-Limit erreicht",
  "leere Antwort vom Modell", "wiederholt sich in einer Schleife") had been
  missed by the earlier German→English comment-translation pass, which
  covered code comments but not these live session-visible strings.

### Refactored
- **A1 — Extracted shared group-candidate filtering** (`applyGroupFilters`
  in `src/routing.ts`) out of duplicated logic in `resolveGroup()` and
  `getTopModels()`.
- **D2 — Added a shared file-based logger** (`src/logger.ts`) for modules
  that don't have access to Pi's `ctx` logging and previously had no way to
  emit diagnostics without touching stdout/stderr.
- **F1 — Removed dead `estimateOllamaModelsGdpval`** and documented why
  `ollama-gdpval.ts`/`ollama-context.ts`/`ollama-utils.ts` remain three
  separate modules instead of one (different concerns: pure scoring math,
  context-window resolution from scan capabilities, live HTTP API wrapper).
- **A2 — Consolidated GDPval resolution into a single pipeline**, removing
  a second, divergent lookup path that had grown alongside the primary one.
- **F3 — Translated remaining German code comments to English** across
  `index.ts` (this pass's runtime-string translations, above, close the gap
  this left for user-visible text).
- **C1 — Extracted oversized closures out of `index.ts`'s `activate()`**
  into pure, independently-testable functions: `dynamic-config.ts` and
  `stream-driver.ts` gained `getFallbackGroup()`/`FALLBACK_GROUP_ORDER` and
  `pushRouterInfo()`, replacing hand-copied reimplementations that had
  drifted from the real logic in several test files.
- **Fixed `registerGroupProviders()`'s cosmetic label for dynamic groups**
  and verified the previously-tracked "context-size mismatch on model
  switch breaks compaction" bug was already fixed by the driveStream
  reliability pass in 1.4.0 (not a new fix — confirmed via code inspection
  and existing test coverage, TODO.md updated accordingly).

### Tests
- Removed three fully-superseded test files whose coverage now lives in
  real unit tests against the extracted `src/` functions above
  (`dynamic-config-generation.test.ts`, `rate-limit-detection.test.ts`,
  `dedup-models.test.ts`), and rewrote `fallback-chain.test.ts` /
  `router-info-events.test.ts` to exercise the actual exported
  `getFallbackGroup()` / `pushRouterInfo()` functions instead of local
  reimplementations that could no longer regress-test anything real.
- Un-skipped and repaired the `TEST_INTEGRATION`-gated "GLM-5-2 end-to-end
  regression" block in `refactor-golden-master.test.ts` (5 tests): it was
  hidden behind a stale, copy-pasted comment claiming it needed external
  developer-machine files it never actually read. Un-skipping immediately
  surfaced two real, previously-invisible bugs in the test itself — a
  missing `setGdpval()` call that made every assertion vacuous, and a
  fixture keyed under a GDPval slug (`glm-5-2`) that had since been
  renamed (`glm-5-3`) — both fixed. Deleted the non-portable
  `glm-live-debug.test.ts`, which read personal machine-specific files
  (`~/.pi/agent/router-config.user.json`, local scan cache) and duplicated
  the now-working golden-master coverage.
- Added `test/dynamic-config.test.ts` (25 tests) and
  `test/register-group-providers-label.test.ts`; added coverage thresholds
  to `vitest.config.ts` and a build step to CI so both are enforced going
  forward.
- Added a regression test for the Ollama family-score shadowing bug
  (`mistral-large:70b` must resolve via the specific family, not the
  generic one it's a substring of) and `is-expected-transient-error.test.ts`
  (previously zero coverage for that function).

### Removed
- 9 dead/obsolete files with no functional impact: pre-refactor root-level
  test files that vitest's config never picked up and that hand-copied
  logic already covered by real `src/`+`test/` modules
  (`routing.test.ts`, `integration.test.ts`, `pass-parser.test.ts`,
  `model-utils.ts`/`.test.ts`, `test-dynamic-api.mjs`,
  `test-dynamic-router.sh`), plus two obsolete docs
  (`MIGRATION-0.82.md` — one-time dependency-version migration long since
  completed; `IMPLEMENTATION_REPETITION_GUARD.md` — orphaned design note
  whose content is documented in `src/repetition-guard.ts`).

### Docs
- Removed stale references to the already-removed "Cost Tier System" as
  an active feature in `PI.md`/`AGENT.md`/`TODO.md`/`SKILL.md`; corrected
  stale version/date markers (`TODO.md` "Last Updated: June 2026" →
  August; `SKILL.md` "New Features (v1.1.8)" → "Features (v1.1.8
  onwards)").
- Rewrote `RELEASE_CHECKLIST.md` from a single-shot v1.3.0 checklist
  (referencing specific validation items and test counts that no longer
  hold) into a reusable, version-agnostic template.
- Repaired a dead link to the deleted `glm-live-debug.test.ts` in
  `docs/architecture.md`; updated the `gdpval_builtin` example in
  `docs/config-override.md` from the renamed `glm-5-2` slug to `glm-5-3`.
- Added `router-config.dynamic.json.*-bak` to `.gitignore` to stop the
  router's own test-run backup artifacts from appearing as untracked
  clutter.

## [1.4.0] — 2026-08-17 — Reliability: cycles, runaway retries, externalized deps, context-overflow, reasoning timeout, HINT cooldowns, force-retry escalation

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

### Fixed (roborev)
- **Direct-model HINT overrides had a dead fallback cascade.** The
  `hintType === 'model'` `driveStream` call was the one call site never
  updated to pass a `groupName`, so once a HINT-resolved model and all its
  auto-appended fallbacks failed, the cascade to a lower-tier group
  (`getFallbackGroup`) was unreachable — straight to "All N candidates
  failed". Now passes a group approximated from the resolved model's GDPval
  tier (expensive→strategic, medium→tactical, cheap→scout), mirroring the
  classifier's own escalation tiering.
- **Context-window overflow short-circuit could fire before the fallback
  cascade got a chance.** Groups are filtered by cost tier, not context
  window, so a lower-priority fallback group can contain a model with a
  larger context window than anything in the current group. The cascade
  attempt now runs first; the synthetic overflow signal only fires once the
  cascade is exhausted.
- **Total-cooldown-collapse force-retry always used the short soft-backoff,
  even for real rate-limit failures.** Factored the main loop's reason-based
  escalation (hard cooldown + key rotation for rate-limit/paid-empty-
  response, short soft backoff otherwise) into a shared `recordStreamFailure`
  helper and reused it in the force-retry path, so a still-rate-limited
  force-retried candidate can't be force-retried again almost immediately.
- **`empty_response_timeout_ms`/`reasoning_empty_response_timeout_ms` had the
  same dynamic-config staleness bug already fixed for `exclude`.** Once
  `router-config.dynamic.json` exists on disk, `load()` only re-synced
  `exclude` from `staticCfg`; the two timeout overrides were not, so editing
  them in `router-config.json` had no effect in the common steady state.
  Both fields are now forced from `staticCfg` on the load path and the
  generate/save path, same as `exclude`.
- **Regenerated `package-lock.json`** (stale version field, unrelated `diff`
  lockfile-entry drift) and restored the trailing newline in `package.json`.
- **Force-retry path had no `context_overflow` branch and its own escalation
  logic drifted from the main loop.** The total-cooldown-collapse force-retry
  path fell through to the generic "All N candidates failed" message when a
  provider rejected the force-retried prompt as too large — that message
  lacks the pattern Pi's `isContextOverflow()` recognises, so compaction
  never fired even though the provider had definitively measured the prompt
  as oversized. The force-retry path now mirrors the main loop's
  `context_overflow` branch (native overflow message + return). The main
  loop's `rate_limit_exceeded` and paid-cloud-empty-response branches now
  also go through the shared `recordStreamFailure` helper instead of calling
  `recordLimit` directly, so both paths can no longer drift apart on
  escalation policy, and the force-retry caller emits a "(key rotated to X)"
  info line on key rotation, matching the main loop.

### Tests
- `test/dynamic-config-staleness.test.ts` — regression coverage for the
  `exclude`/timeout dynamic-config staleness fix (previously untested).
- `test/reasoning-timeout.test.ts` — mock now uses `reasoning: true` (the
  real pi-ai `Model.reasoning` type), not the string `'default'`.
- `test/context-overflow.test.ts` — regression coverage for the
  overflow-vs-cascade ordering fix.
- Several shared-state test files (scan-cache/dynamic-config) raced each
  other when run concurrently, producing spurious failures unrelated to the
  code under test. Added `test/helpers/router-state-lock.ts`, a cross-process
  file lock, and applied it across all affected test files. The lock now
  also reclaims itself if left stale by a killed run (5 min threshold) and
  cleans up on `SIGINT`/`SIGTERM`/`exit`, instead of hanging every future run
  for the full acquire timeout.

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
