# 🚀 pi-model-dynamic-router - Current Tasks & Roadmap

> **Status**: Updated with cascading fallback, cost tiers, model momentum, and status line integration
> **Last Updated**: June 2026
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

- [ ] **Context-size mismatch on model switch breaks compaction** — when the router switches
  from a large-context model (e.g. claude-bridge, ~1M tokens) to a smaller-context model
  (e.g. mistral, ~128k-256k tokens) mid-session — whether via fallback cascade, HINT override,
  or dynamic classification — the accumulated conversation context can exceed the new model's
  window. Auto-compaction then fails with "Summarization failed: Unknown error", leaving the
  session stuck (observed 2026-07-27). Needs: detect the new model's max context before
  switching, and either force compaction *before* the switch or block switches that would
  overflow the target model's window outright.

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
  - Fallback chain: Ollama → Free cloud models → Static classification
  - `classifyPrompt()` supports `allowCloudFallback` option
  - Uses `CloudClient.callModel()` for cloud classification

- [x] **Static classification as ultimate fallback**
  - `classifyStatically(prompt: string): ClassificationResult`
  - Categories: trivial, simple, code_simple, standard, code_complex, design, planning, exploration, fallback

### Cost-Efficient Routing (Phase 2)
- [x] **Cost tier system** - Three tiers (cheap, medium, expensive)
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

## ✅ **NEW: Recently Completed Tasks (v1.1.8)**

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
- [x] **README.md updated** - New sections for cascading fallback, cost tiers, model momentum, status line, claude-bridge support, rate limit handling
- [x] **PI.md updated** - SKIP_REGISTRATION, fallback_groups, model_metrics, gdpval_builtin, claude-bridge support
- [x] **SKILL.md updated** - New features listed
- [x] **TODO.md updated** - This file

---

## 🎯 **Prioritized Tasks (Next Steps)**

### 🔥 **Immediately Actionable** (Quick Wins - 1-2 hours)

#### Code Quality & Maintenance
- [ ] **Increase test coverage** - Currently ~80%, target: 90%+
- [ ] **Improve mock data for unit tests** - More realistic test data
- [ ] **Add performance tests** - Benchmarks for modules

#### Build & Deployment
- [ ] **Optimize build process** - Reduce `npm run build` time
- [ ] **Set up CI/CD pipeline** - Automated tests & deployment

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
- [ ] **Refactor resolveGroup() and resolveGroupWithCostTier()** - Reduce ~80 lines of code duplication
- [ ] **Fix resolve() for dynamic groups** - Currently returns null for method: 'dynamic'
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

### Intelligent Failure Management
- [ ] **recordFailure(model, reason)** - Track model failures
- [ ] **recordSuccess(model)** - Track model successes
- [ ] **Temporary blacklist** - After X failures, blacklist model for 1 hour
- [ ] **Cooldown period** - Exponential backoff for failed models
- [ ] **Integration in resolveGroup()** - Filter blacklisted models

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

### Phase 1: Stabilization (1-2 days)
- [ ] Increase test coverage to 90%+
- [ ] Improve mock data for unit tests
- [ ] Optimize build process
- [ ] Refactor resolveGroup() and resolveGroupWithCostTier()
- [ ] Fix resolve() for dynamic groups

### Phase 2: Resilience (2-3 days)
- [ ] Implement caching for classification
- [ ] Add batch processing
- [ ] Add more categories
- [ ] Implement recordFailure/recordSuccess
- [ ] Temporary blacklist system

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
- ✅ **Cost Tier System** - Intelligent model selection based on task complexity
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
- [ ] Code duplication in `resolveGroup()` and `resolveGroupWithCostTier()`
- [ ] `resolve()` returns null for dynamic groups
- [ ] No intelligent failure tracking (recordFailure/recordSuccess)

---

*Last updated: After v1.1.8 implementation and verification*
