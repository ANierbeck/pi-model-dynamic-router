# 🚀 pi-model-dynamic-router - Current Tasks & Roadmap

> **Status**: Updated with cascading fallback, group-based cost/quality routing, model momentum, and status line integration
> **Last Updated**: August 2026
> **Current State**: ✅ All critical fixes implemented and verified

## 📌 **IMPORTANT RULES**

### Documentation Language
- **ALL documentation MUST be in English** - This includes:
  - Code comments
  - JSDoc comments
  - Markdown files (README.md, TODO.md, etc.)
  - Commit messages
  - Type definitions and interfaces
- **Rationale**: International project, English is the lingua franca of development
- **Exception**: None - all German comments/documentation must be translated to English

---

## 🔴 **Open Issues (Known Bugs)**

_None currently known. See Completed Tasks below for the context-size-mismatch bug that used
to be listed here._

## ✅ **Completed Tasks**

### Core Infrastructure
- [x] **Modular architecture** - 8 modules (providers, types, utils, rate-limit, discovery, metrics, cache, routing, content-classifier)
- [x] **Strangler Fig Pattern** - Incremental migration from monolithic to modular
- [x] **Code reduction** - index.ts reduced from 1,528 to ~1,800 lines with better organization
- [x] **TypeScript Strict Mode** - Already enabled in tsconfig.json

### Session Escalation System
- [x] **Session escalation on loop detection** - Automatically upgrade model when session stagnates
- [x] **LLM-based detection** - `detectLoopWithLLM()` using gemma2:2b
- [x] **Rule-based fallback** - `detectLoop()` with keyword matching
- [x] **Race condition fix** - `levelAtCallTime` + `llmEscalationInFlight` flag
- [x] **Integration** - Override target group in dynamic routing when escalated
- [x] **Session management** - Reset on new session via `session_switch` and `session_start` handlers

### Dynamic Routing & Classification
- [x] **HINT-Override System** - LLM-based detection
  - Works in ALL modes (dynamic, static, direct)
  - Users can override with `HINT: use mistral-medium-3.5` or `HINT: use group tactical`
  - No regex - integrated into `CLASSIFICATION_PROMPT`
  - Supports all languages and formats

- [x] **Model boundaries** - GDPval-based limits
  - `CATEGORY_TO_GROUP` mapping in `src/content-classifier.ts`
  - `router-config.json` contains model groups with `min_gdpval` thresholds
  - Complex tasks (code_complex, design, planning) → tactical group (GDPval >= 600)

- [x] **Cloud fallback for classification**
  - Fallback chain: Ollama → Free cloud models (opt-in, off by default) → Static classification
  - `classifyPrompt()` supports `allowCloudFallback` option; `index.ts` only passes `true` when the
    dynamic group config explicitly sets `classifier_cloud_fallback: true` (data-minimization —
    sends raw prompt text externally, so it must not be silently on for anyone with a `free_models`
    provider configured)
  - Uses `CloudClient.callModel()` for cloud classification

- [x] **Static classification as ultimate fallback**
  - `classifyStatically(prompt: string): ClassificationResult`
  - Categories: trivial, simple, code_simple, standard, code_complex, design, planning, exploration, fallback

### Cost-Efficient Routing (Phase 2)
- [x] ~~**Cost tier system** - Three tiers (cheap, medium, expensive)~~ → REMOVED (redundant with group thresholds, conflicted with local models + fallback cascade)
- [x] **Multi-tier escalation** - Direct jumps based on task complexity
- [x] **Task complexity mapping** - Low/Medium/High tiers
- [x] **Cost optimization** - After expensive model → cheaper models for simple tasks

### Free Cloud Models
- [x] **Free cloud models for classification** - `DiscoveryManager.getFreeModels()`
- [x] **Free model detection** - `DiscoveryManager.hasFreeModels()`
- [x] **Static free_models** - Included in dynamic config generation

### Dynamic Configuration
- [x] **Fix for dynamic configuration generation** - Static free_models now included
- [x] **Priority handling** - static models > scanned models
- [x] **Cost filters** - Corrected for free models

---

## ✅ **Recently Completed Tasks (v1.1.8 through v1.4.0)**

### Provider Registration & Architecture
- [x] **Skip all known providers** - SKIP_REGISTRATION extended to all built-in and extension providers
  - Built-in: anthropic, openai, google, mistral
  - Extensions: qwen-cli, gemini-cli, ollama, lm-studio, antigravity, **claude-bridge**
  - Only OpenRouter is registered by router (for free tier models)

- [x] **Claude-bridge support** - Works with claude-bridge Pi extension
  - No double registration (router skips claude-bridge)
  - Models discovered automatically when extension is loaded
  - Automatic fallback on rate limit/subscription errors

- [x] **Clean provider separation** - Router only registers what Pi doesn't know

### Cascading Fallback System
- [x] **Fallback groups** - Each group can define cascade chain
  - strategic → tactical → operational → scout → fallback
  - Configurable via `fallback_groups` in router-config.json

- [x] **Automatic recovery** - Soft failures trigger next model attempt
- [x] **Rate limit handling** - "out of usage credits", "rate limit hit" errors treated as soft failures
- [x] **Transparent to user** - Session continues with next available model

### Cost & Metrics
- [x] **Provider-based cost estimates** - `cost_per_m` in providers config
- [x] **Model-specific cost overrides** - `model_metrics` for per-model costs
- [x] **GDPval overrides** - `gdpval_builtin` for new/unranked models
  - mistral-medium-3-5: 933 (was incorrectly 665)
  - claude-sonnet-5: 1603
  - claude-fable-5: 1747
  - claude-opus-5: 1860

### Error Handling & UX
- [x] **Rate limit error detection** - Recognizes subscription/rate limit errors from claude-bridge
- [x] **Soft failure treatment** - Rate limit errors trigger automatic fallback
- [x] **Filtered error messages** - Expected errors (rate limits, API not found) suppressed
- [x] **Status line integration** - Shows actually active model (not failed candidates)
  - Updates **immediately** when stream starts (before first token)
  - Uses `pi.setModel()` to sync with Pi's status bar

### Model Momentum
- [x] **Context compaction detection** - >30% token drop or >5 messages/500 tokens
- [x] **Model reuse** - Previous model reused after compaction
- [x] **Smart hints** - Model hint provided to classifier for similar tasks

### Documentation
- [x] **README.md updated** - New sections for cascading fallback, group-based cost/quality routing, model momentum, status line, claude-bridge support, rate limit handling
- [x] **PI.md updated** - SKIP_REGISTRATION, fallback_groups, model_metrics, gdpval_builtin, claude-bridge support
- [x] **SKILL.md updated** - New features listed
- [x] **TODO.md updated** - This file

---

## 🎯 **Prioritized Tasks (Next Steps)**

### ✅ **A1 — Shared group-candidate filters (DONE 2026-08-23)**

`applyGroupFilters(refs, g, cfg, dedup?, dedupFn?)` in `src/routing.ts` is the
single source of truth for the method-independent filter pipeline:
exclude_providers, exclude_models, min_gdpval/pct, max_cost, max_cost_per_m.

- **`resolveGroup`** (live selection) and **`getTopModels`** (display) both
  call it — the display path no longer diverges (the old display path dropped
  ALL unknown-cost models, so `/router` showed models the live path kept —
  now billing-aware: subscription/local = sunk cost = kept, payg = dropped).
- **`generateDynamicConfig`** (persist) deliberately does NOT use it: its
  `max_cost`/`max_cost_per_m` semantics diverge (`max_cost=0` groups admit
  ONLY genuine $0 free models, excluding subscription models that cost real
  money). Documented inline. Only the truly shared bits (exclude, min_gdpval)
  match in spirit.
- **min_gdpval <= 0** = "no gate" (unscored models pass); **strict positive**
  threshold drops unscored models (`lookupGdp null`). This is the fix for the
  13/148-style collapse where unscored models leaked past the gate via the
  old `filterByQualityMin` `return filtered.length ? filtered : refs` fallback
  (that fallback was removed — it was error-masking, not a feature).
- Tests: `test/apply-group-filters.test.ts` (12), updated 8 driveStream tests
  to set `min_gdpval: 0` explicitly (they relied on the old fallback).

### ✅ **F1 — Ollama module cleanup (DONE 2026-08-24)**

Removed dead `estimateOllamaModelsGdpval` (non-slug variant) export from
`src/ollama-gdpval.ts` — nothing consumed it, only
`estimateOllamaModelsGdpvalAsSlugs` is wired into the cache. Evaluated
consolidating the three Ollama modules (`ollama-gdpval.ts`,
`ollama-context.ts`, `ollama-utils.ts`) and declined: distinct concerns
(pure scoring math / context-window resolution / live HTTP client), distinct
consumers. Documented the decision in each file header instead.

### ✅ **A2 — Single GDPval resolution pipeline (DONE 2026-08-24)**

`src/metrics.ts` is now the sole owner of GDPval resolution, documented as a
file-header block answering two questions: **Q1** "which slug does a ref
mean?" (`resolveSlug`: model-map.yaml → LLM-assisted match → algorithmic
fuzzy matcher) and **Q2** "what score does that slug have?" (`lookupGdp`:
`gdpval_builtin` wins, merged additively over `cache.gdpval_scores`,
self-healing against `setGdpval()`'s replace-semantics wipe). Removed a
dead, drifted duplicate pipeline in `src/model-matcher.ts`
(`resolveModelScores`/etc.) that was never called from `index.ts`. Fixed a
same-scan visibility gap: newly-discovered Ollama models are now visible to
`generateDynamicConfig()` within the same scan cycle via a `setCache()`
resync.

### ✅ **F3 — German→English comment translation (DONE 2026-08-24)**

All German prose comments in `index.ts` translated to English (1:1, no code
changes). `Ü1`/similar short code-names kept as-is (project shorthand, not
prose).

### ✅ **C1 — index.ts oversized-function extraction (DONE 2026-08-24)**

`index.ts`: 3583 → 3254 lines (-329, -9.2%), pure code motion. Extracted
`src/dynamic-config.ts` (pure computational core of `generateDynamicConfig`:
filter/sort/collect/fallback-group logic) and `src/stream-driver.ts`
(`pushStreamError`/`buildErrorAssistantMessage`, the zero-cost error-envelope
boilerplate duplicated 6x across `driveStream`/`groupStream`, plus
`isExpectedTransientError`). `groupStream`'s HINT model-target resolution
(~130 lines) was intentionally left in place — too entangled with mutable
session state to extract safely in this pass.

### ✅ **"Context-size mismatch on model switch breaks compaction" — was already fixed, not a new fix (verified 2026-08-26)**

This bug (previously listed under Open Issues, observed 2026-07-27) was already
resolved by v1.3.1 (`0a99930`, 2026-08-14) and the driveStream reliability pass
(`b3c8d93`, 2026-08-16) — the TODO entry just never got updated. `driveStream`'s
context-window guard (`index.ts`, near `getModelContextWindow`) pre-emptively
skips any candidate whose `contextWindow` is smaller than the estimated
conversation size, for every switch path (fallback cascade, HINT override,
dynamic classification — they all funnel through the same `driveStream` loop).
If every candidate in the cascade is skipped for that reason, the router emits
a synthetic "prompt is too long" error matching the pattern Pi's
`isContextOverflow()` recognises, so Pi's native compaction fires instead of
the session hanging. Because the router never calls `pi.setModel()` for group
routing, Pi's own compaction call re-enters the router's virtual group
provider too, so the summarization call itself benefits from the same guard.
Regression tests: `test/context-overflow.test.ts` (3 cases: total skip →
compaction signal, non-overflow failures still walk the normal cascade,
a fallback group with enough room is tried before signalling overflow).

### ✅ **`resolve()` "→ none" for dynamic groups — code-quality fix (DONE 2026-08-26)**

`resolve()` returning `null` for `method: 'dynamic'` groups is intentional
(documented invariant in `src/routing.ts`: the classifier hook resolves those
per-prompt, not `resolve()`) — not a bug to fix. The actual rough edge was
cosmetic: `registerGroupProviders()` called `resolve()` anyway for display
purposes, showing the misleading `"dynamic → none"` in Pi's model picker. Now
dynamic-method groups skip the call entirely and show `"dynamic →
auto-classify"` instead. Also improved the log line when a HINT targets the
dynamic group itself (`HINT: use group dynamic`) — previously logged as
"group not found" (implying a typo), now explicitly notes it falls through to
normal classification. Tests: `test/register-group-providers-label.test.ts`.

### 🔥 **Immediately Actionable** (Quick Wins - 1-2 hours)

#### ✅ D2 — Shared logger (DONE 2026-08-23)

`src/logger.ts` is the SINGLE source of truth for router log output:
`routerLog`, `writeLogLine`, `appendRawLog`, `setProjectLogDir`. `index.ts`
re-imports them (no longer defines them locally). All four `src/` modules
that used `console.*` now route through `routerLog`:
- `content-classifier.ts` (11 → 0)
- `cost-tracker.ts` (6 → 0, still gated by `DEBUG_COST_TRACKER`)
- `escalation.ts` (4 → 0)
- `metrics.ts` (1 → 0)

Why: `console.*` bypasses Pi's TUI (`ctx.ui.notify`) and can land in the
user's input field, corrupting the prompt. The file logger writes to both
`~/.pi/logs/router.log` and the project-local `.pi/logs/router.log` — never
to stdout/stderr. Tests: `test/cost-tracker.test.ts` updated to assert
`routerLog` is called and `console.*` is NOT (the D2 goal).

#### Code Quality & Maintenance
- [x] **Test coverage floor + CI enforcement (DONE 2026-08-26)** — actual
  coverage was 67.7% overall (not the ~80% previously claimed here — that
  number was never measured, just aspirational). Raised to 70.5% by adding
  real unit tests for `src/dynamic-config.ts` (9.7% → 85.7%; it was extracted
  in C1 specifically to be unit-testable but shipped without tests) and
  replacing a pre-existing `test/dynamic-config.test.ts` that never actually
  imported the module under test (it mocked `metrics.ts` and reimplemented
  the sort/filter logic inline, asserting against itself — zero real
  regression coverage despite the misleading name). Added `coverage.thresholds`
  to `vitest.config.ts` (68% stmts/funcs/lines, 78% branches — a few points
  below the measured baseline) so `npm run test:coverage` fails the build on
  a real regression instead of coverage silently drifting down again. Raise
  these thresholds as coverage improves; don't lower them to unblock a red CI
  run without fixing the actual regression.
- [x] **Audit other roborev-findings test files for the same tautological-test
  pattern found in the old `dynamic-config.test.ts` (DONE 2026-08-28)** —
  swept all 58 test files for (a) `vi.mock()` targeting the module under
  test itself (only legitimate dependency mocks found: `ollama-utils`,
  `metrics`, `logger`, `discovery`, `node:os` — never the tested module), and
  (b) locally-reimplemented business logic asserted against itself (only
  hit was `refactor-golden-master.test.ts`'s `makeRouter()`, which
  constructs a real `Router` and calls real methods — legitimate test
  setup, not a reimplementation). No other instances of the anti-pattern
  found; the `dynamic-config.test.ts` fix from that review pass was the only
  occurrence.
- [x] **Improve mock data for unit tests / Add performance tests (CLOSED —
  not pursued, 2026-08-28)** — too vague to act on without a concrete
  failing scenario; would produce busywork with no tied regression. Revisit
  if a specific gap surfaces.

#### Build & Deployment
- [x] **CI pipeline runs tsc + coverage (with enforced thresholds) + build on
  every push/PR to main (DONE 2026-08-26)** — `.github/workflows/test.yml`
  now also runs `npm run build` after tests, so a broken esbuild bundle (not
  caught by `tsc --noEmit` alone) fails CI too.
- [x] **Optimize build process (CLOSED — not a real problem, 2026-08-28)** —
  measured: 5.6s total (`tsc` type-check + esbuild bundle), esbuild bundling
  itself is 101ms. Not worth chasing.

---

## 🚀 **Medium-term Improvements** (1-3 days)

### Resilience & Fallback Strategies
- [ ] **Implement caching for classification** - LRU cache with TTL for frequent prompts
- [ ] **Add batch processing** - Parallelize classification requests
- [ ] **Optimize model selection** - Evaluate smaller models for classification

### Extended Classification
- [ ] **Add more categories** - More specific distinction
- [ ] **Multi-label classification** - Multiple categories per prompt
- [ ] **Context-based classification** - Consider session context

### Code Quality
- [x] **Refactor resolveGroup() and getTopModels()** - DONE as A1 (see above): both call `applyGroupFilters()` in `src/routing.ts`
- [x] **`resolve()` returns null for dynamic groups** — intentional (see the
  `✅ resolve() "→ none" for dynamic groups` entry above, DONE 2026-08-26),
  not a bug. Cross-referenced here to stop it resurfacing as "open".
- [ ] **Improve error handling** - Better error messages and recovery
- [ ] **Add more unit tests** - Increase coverage for edge cases

---

## 🌟 **Long-term Features** (1-2 weeks)

### Extended Provider Management
- [ ] **Add more providers** - Support for additional AI providers
- [ ] **Improve provider detection** - Better discovery of available models

### Intelligent Routing
- [ ] **Multi-label classification** - Assign multiple categories to a single prompt
  - *Idea*: Allow prompts to match multiple categories (e.g., "code_simple" + "explanation")
  - *Benefit*: More accurate model selection based on combined requirements
- [ ] **Implement learning from user feedback** - Improve classification based on corrections
- [ ] **Add user-specific configurations** - Personalized model preferences

### ✅ Intelligent Failure Management (already built, TODO was stale — closed 2026-08-28)

This section described functionality that was already fully implemented in
`src/rate-limit.ts`'s `RateLimitManager`, just under different names than
what this TODO originally envisioned:

- [x] **recordFailure(model, reason)** → `recordLimit(ref, providerKeys)` (hard:
  rate-limit/auth, with key rotation) + `recordSoftFailure(ref)` (soft:
  timeout/empty response) — reason-differentiated exactly as planned.
- [x] **recordSuccess(model)** → `recordOk(ref)` resets the hit counter.
- [x] **Temporary blacklist** → the cooldown ladder (`cooldown_until` per ref)
  IS the blacklist; a limited ref is filtered out of candidates until it
  expires.
- [x] **Cooldown period, exponential backoff** → `backoff_minutes: [1, 2, 4,
  8, 16, 32, 64, 90]` (hard failures) and `soft_backoff_ms: [30s, 60s, 120s,
  300s]` (soft failures) in `router-defaults.yaml` — a real escalation
  ladder, not a fixed cooldown.
- [x] **Integration in resolveGroup()** → `src/routing.ts:837` already does
  `c.filter((ref) => !this.isLimited(ref))`.

Tests: `test/rate-limit-cooldown.test.ts`, `test/cooldown-collapse.test.ts`.
Not pursued further: a *separate* hard-blacklist ("after N failures, sperren
24h regardless of ladder expiry") was considered and explicitly declined —
the existing ladder already caps at 90min and resets on success, which was
judged sufficient.

### Integration & Extensibility
- [ ] **Create plugin system** - Extensible architecture for new features
- [ ] **Add webhook support** - Notifications for model changes

---

## 📊 **Technical Debt**

### Low Priority
- [ ] **Clean up archive directory** - Remove outdated files
- [ ] **Update dependencies** - Check for newer versions

### Medium Priority
- [ ] **Clean up test files** - Remove redundant tests
- [ ] **Improve documentation** - Add more examples and use cases

---

## 📅 **Suggested Timeline**

### Phase 1: Stabilization (1-2 days) — DONE 2026-08-28, see entries above
- [ ] Increase test coverage to 90%+ (currently 70.5%, not pursued further —
  no concrete gap identified)
- [x] ~~Improve mock data for unit tests~~ CLOSED, not pursued
- [x] ~~Optimize build process~~ CLOSED, not a real problem (5.6s total)
- [x] Refactor resolveGroup() and getTopModels() — DONE as A1
- [x] ~~Fix resolve() for dynamic groups~~ not a bug, intentional (DONE 2026-08-26)

### Phase 2: Resilience (2-3 days)
- [x] ~~Implement caching for classification~~ DONE in v1.5.0 (LRU+TTL, `test/classification-cache.test.ts`)
- [ ] Add batch processing
- [ ] Add more categories
- [x] ~~Implement recordFailure/recordSuccess~~ already existed as recordLimit/recordSoftFailure/recordOk (DONE 2026-08-28, see ✅ Intelligent Failure Management above)
- [x] ~~Temporary blacklist system~~ already existed as the cooldown ladder (DONE 2026-08-28, see above)

### Phase 3: New Features (1-2 weeks)
- [ ] Multi-label classification
- [ ] Context-based classification
- [ ] Learning from user feedback
- [ ] User-specific configurations

---

## 🎯 **Recommendations for Getting Started**

1. **Start with quick wins** - Code quality improvements (1-2 hours)
2. **Focus on resilience** - Fallback strategies and error handling (2-3 days)
3. **Then extend features** - New classification capabilities (1-2 weeks)

---

## 📝 **Release Notes (v1.1.8)**

### New Features
- ✅ **Cascading Fallback Groups** - Automatic recovery from model failures
- ✅ ~~**Cost Tier System**~~ - Intelligent model selection based on task complexity → REMOVED (redundant with group thresholds, conflicted with local models + fallback cascade)
- ✅ **Model Momentum** - Model reuse after context compaction
- ✅ **Status Line Integration** - Accurate display of active model
- ✅ **Claude-bridge Support** - Works with claude-bridge Pi extension
- ✅ **Enhanced Error Handling** - Rate limit/subscription errors trigger automatic fallback

### Improvements
- ✅ **Provider Registration** - Only registers providers Pi doesn't know (OpenRouter)
- ✅ **SKIP_REGISTRATION** - Extended to all built-in and extension providers
- ✅ **GDPval Overrides** - Correct scores for mistral-medium-3.5 (933) and new Claude models
- ✅ **Cost Tracking** - Provider-based and model-specific cost estimates

### Bug Fixes
- ✅ **Rate-Limit Handling** - Automatic fallback on "out of usage credits" errors
- ✅ **Status Line** - Shows actually active model (not failed candidates)
- ✅ **Filtered Error Messages** - Expected errors suppressed to reduce noise

### Known Issues
- [x] ~~Code duplication in `resolveGroup()` and `getTopModels()`~~ - FIXED by A1 (`applyGroupFilters()`)
- [x] ~~`resolve()` returns null for dynamic groups~~ - intentional, not a bug (DONE 2026-08-26)
- [ ] No intelligent failure tracking (recordFailure/recordSuccess) — up next

---

*Last updated: 2026-08-28 (Thread D rest closed out; tautological-test audit
clean; resolve()/build-time stale entries corrected)*
