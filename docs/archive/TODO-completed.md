# TODO archive — completed work and closed roadmap sections

Moved out of `TODO.md` on 2026-11-02 (hygiene Phase 3,
`docs/plans/2026-10-29-repo-hygiene.md`). Nothing here is deleted, only
relocated: these are finished tasks, the v1.1.8 release notes and the
v1.1.8-era roadmap sections that no longer describe the project. Open items
stayed in `TODO.md`; `CHANGELOG.md` remains the release history.

---

## ✅ **Completed Tasks**

### `Summarization failed: Unknown error` from pi-ai auto-compaction — FIXED

**Root cause**: compaction/branch-summary calls DO route through the
router's `groupStream`/`driveStream` cascade (traced end-to-end:
`AgentSession._runDefaultCompaction` → `agent.streamFunction` →
pi-coding-agent's `modelRuntime.streamSimple` → provider lookup by
`model.provider`, which is the router's persistent virtual group model
for the whole session → the router's registered group provider
`streamSimple: groupStream`). The cascade itself worked correctly. The
bug was in how failures were reported back: `driveStream`'s "all
candidates failed" / "dynamic routing failed" / catch-all error paths
called `pushStreamError(proxy, detailText)` without the optional third
`errorMessage` argument, so the resulting `AssistantMessage` had a
detailed failure list in `content[0].text` but an *undefined*
`errorMessage` field. pi-ai's `getSummarizationFailure()` reads only
`response.errorMessage` (never `content[0].text`), so it always fell
through to `"Unknown error"` even though the router had logged the real
reason.

**Fix** (commit pending): populate `errorMessage` at the 3 call sites
that omitted it, but with a *generic, deterministic* string — not the
raw failure list. This matters because pi-ai's `retryAssistantCall`
(used by `completeSummarization`) calls `isRetryableAssistantError()`,
which treats any `errorMessage` matching `RETRYABLE_PROVIDER_ERROR_PATTERN`
(`timeout`, `rate.?limit`, `network.?error`, 5xx, ...) as transient and
re-invokes the *entire* candidate cascade up to `maxRetries` times. Real
failure-list text routinely contains those exact words
(`rate_limit_exceeded`, `empty_timeout`, `stall_timeout`), so echoing it
verbatim into `errorMessage` would turn an already multi-minute fallback
cascade (N candidates × up to `stall_timeout_ms` each, default 180s) into
a multi-attempt retry storm — very plausibly the cause of "pi hangs in
working mode, have to Ctrl-C" reports during compaction. The full
diagnostic detail stays in `content[0].text`; only a short, non-matching
summary (e.g. `"[router] no candidates succeeded for this request (see
chat log for per-candidate reasons)"`) goes into `errorMessage`.

**Regression test**: `test/summarization-error-message.test.ts` asserts
(a) `errorMessage` is non-empty and not `"Unknown error"`, and (b) pi-ai's
own `isRetryableAssistantError()` classifies it as non-retryable —
guarding against the retry-storm regression specifically, not just the
original "Unknown error" symptom.

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
  - Uses pi's `modelRegistry.completeSimple()` for cloud classification (via `getCheapestCloudModels()` in `src/discovery.ts`, which dynamically discovers the cheapest cloud models). The previous custom HTTP client (`src/cloud-client.ts`) was removed — see ADR 0004.

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
- [x] **Skip all known providers** - SKIP_REGISTRATION extended to all built-in and extension providers (set removed with the scan-union in `ff81300` / ADR-0021)
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
- [x] **PI.md updated** - SKIP_REGISTRATION (removed in `ff81300`), fallback_groups, model_metrics, gdpval_builtin, claude-bridge support
- [x] **SKILL.md updated** - New features listed
- [x] **TODO.md updated** - This file

---


## 📅 **Suggested Timeline**

### Phase 1: Stabilization (1-2 days) — DONE 2026-08-28, see entries above
- [x] ~~Increase test coverage to 90%+~~ CLOSED 2026-10-07: the meaningful
  goal (enforced floor + CI gate + boundary-pin tests) is achieved —
  coverage 87.14 % statements / 80.97 % branches against pinned
  thresholds, and the Nightly R1 mutation triage added 152 tests that pin
  the boundaries the suite was missing (docs/mutation-triage.md). The 90 %
  figure was aspirational, not a requirement.
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
- [x] ~~Context-based classification~~ DONE 2026-08-29 (see Extended
  Classification above — `lastCategory` momentum + previous message in
  the LLM context; the multi-turn extension remains open there)
- [ ] Learning from user feedback
- [x] ~~User-specific configurations~~ already built (layered config,
  closed 2026-08-29 — see Long-term Features)

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
- ✅ **SKIP_REGISTRATION** - Extended to all built-in and extension providers (removed in `ff81300` / ADR-0021)
- ✅ **GDPval Overrides** - Correct scores for mistral-medium-3.5 (933) and new Claude models
- ✅ **Cost Tracking** - Provider-based and model-specific cost estimates

### Bug Fixes
- ✅ **Rate-Limit Handling** - Automatic fallback on "out of usage credits" errors
- ✅ **Status Line** - Shows actually active model (not failed candidates)
- ✅ **Filtered Error Messages** - Expected errors suppressed to reduce noise

### Known Issues
- [x] ~~Code duplication in `resolveGroup()` and `getTopModels()`~~ - FIXED by A1 (`applyGroupFilters()`)
- [x] ~~`resolve()` returns null for dynamic groups~~ - intentional, not a bug (DONE 2026-08-26)
- [x] ~~No intelligent failure tracking (recordFailure/recordSuccess)~~
  CLOSED: already existed as the cooldown ladder — see the ✅ Intelligent
  Failure Management section (2026-08-28).
