# 🚀 pi-model-router - Current Tasks & Roadmap

> **Status**: Updated with cost-efficient dynamic routing Phase 2 implementation + Session Escalation
> **Last Updated**: June 17, 2026
> **Current State**: ✅ Migration complete, all tests green (207), Cloud-Fallback implemented, HINT-Override implemented, model boundaries improved, cost tiers system implemented, session escalation implemented

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

## ✅ **Completed Tasks**

### Session Escalation System
- [x] **Session escalation on loop detection** - Automatically upgrade model when session stagnates
  - *Implementation*: Detection based on error keywords, repeated prompts, or user corrections
  - *Signals*: same error message seen 2x, user writes "again", "still", "once more"
  - *Escalation levels*: operational -> tactical -> strategic
  - *LLM-based detection*: `detectLoopWithLLM()` using gemma2:2b
  - *Rule-based fallback*: `detectLoop()` with keyword matching
  - *Race condition fix*: `levelAtCallTime` + `llmEscalationInFlight` flag
  - *Integration*: Override target group in dynamic routing when escalated
  - *Session management*: Reset on new session via `session_switch` and `session_start` handlers

### Migration & Refactoring
- [x] Implemented modular architecture (8 modules)
- [x] Applied Strangler Fig Pattern (incremental migration)
- [x] Moved all 40+ functions to modules
- [x] Reduced index.ts from 1,528 to 1,047 lines (-481 lines)
- [x] All 207 tests passing (204 unit + 3 integration)
- [x] Updated documentation (README.md, SKILL.md, REFACTORING_SUMMARY.md)
- [x] Archived outdated planning files

### Modules
- [x] `src/types.ts` - Type definitions
- [x] `src/providers.ts` - Provider definitions (24 providers)
- [x] `src/utils.ts` - Utility functions
- [x] `src/rate-limit.ts` - RateLimitManager
- [x] `src/discovery.ts` - DiscoveryManager
- [x] `src/metrics.ts` - Metrics module
- [x] `src/cache.ts` - CacheManager
- [x] `src/routing.ts` - Router
- [x] `src/content-classifier.ts` - Content classification
- [x] `src/ollama-utils.ts` - Ollama utility functions
- [x] `src/cost-tiers.ts` - Cost tier system
- [x] `src/cost-tracker.ts` - Cost tracking

### Core Features
- [x] **HINT-Override System** - LLM-based detection
  - Works in ALL modes (dynamic, static, direct)
  - Users can override with `HINT: use mistral-medium-3.5` or `HINT: use group tactical`
  - No regex - integrated into `CLASSIFICATION_PROMPT`
  - Supports all languages and formats

- [x] **Model boundaries** - GDPval-based limits
  - `CATEGORY_TO_GROUP` mapping in `src/content-classifier.ts`
  - `router-config.json` contains model groups with `min_gdpval` thresholds
  - Complex tasks (code_complex, design, planning) → tactical group (GDPval >= 600)
  - Standard tasks → operational group (GDPval >= 300)
  - Trivial/Simple tasks → scout group (any free models)

- [x] **Cloud fallback for classification**
  - Fallback chain: Ollama → Free cloud models → Static classification
  - `classifyPrompt()` supports `allowCloudFallback` option
  - Uses `CloudClient.callModel()` for cloud classification

- [x] **Static classification as ultimate fallback**
  - `classifyStatically(prompt: string): ClassificationResult`
  - Categories: trivial, simple, code_simple, standard, code_complex, design, planning, exploration, fallback
  - Keyword-based classification with confidence scores

- [x] **Cost-efficient dynamic routing** - Phase 2 implemented
  - Cost tier system (free/budget/premium)
  - Classification → cost tier → model group
  - Automatic model selection based on cost and capability

- [x] **Free cloud models for classification**
  - `DiscoveryManager.getFreeModels()` returns free models from `router-config.json`
  - `DiscoveryManager.hasFreeModels()` for quick availability check
  - Example: `openrouter.free_models = ['openrouter/qwen/qwen3-4b:free', ...]`

- [x] **Fix for dynamic configuration**
  - Static free_models now included in dynamic config generation
  - Priority: static models > scanned models
  - Cost filters corrected for free models

---

## 🎯 **Prioritized Tasks (Next Steps)**

### 🔥 **Immediately Actionable** (Quick Wins - 1-2 hours)

### Code Quality & Maintenance
- [x] Perform code review - All modules checked for consistency
- [x] Enable TypeScript Strict Mode - Already enabled in tsconfig.json
- [x] Configure ESLint/Prettier - Configurations created
- [x] Add JSDoc comments - Partially implemented

### Testing
- [ ] **Increase test coverage** - Currently ~80%, target: 90%+
- [ ] **Improve mock data for unit tests** - More realistic test data
- [ ] **Add performance tests** - Benchmarks for modules

### Build & Deployment
- [ ] **Optimize build process** - Reduce `npm run build` time
- [ ] **Create Docker container** - Easy deployment
- [ ] **Set up CI/CD pipeline** - Automated tests & deployment

---

## 🚀 **Medium-term Improvements** (1-3 days)

### Resilience & Fallback Strategies
- [x] Use free cloud models for classification - Implemented in `src/discovery.ts`
- [x] Classification with cloud fallback - Implemented in `src/content-classifier.ts`
- [x] Static classification as ultimate fallback - Implemented in `src/content-classifier.ts`

### Performance Optimizations
- [ ] Implement caching for classification - LRU cache with TTL for frequent prompts
- [ ] Add batch processing - Parallelize classification requests
- [ ] Optimize model selection - Evaluate smaller models for classification

### Extended Classification
- [ ] Add more categories - More specific distinction
- [ ] Multi-label classification - Multiple categories per prompt
- [ ] Context-based classification - Consider session context

### Extended Metrics & Monitoring
- [ ] Add Prometheus metrics - Monitoring for router performance
- [ ] Add usage analytics - Statistics on model usage

---

## 🌟 **Long-term Features** (1-2 weeks)

### Extended Provider Management
- [ ] Add more providers - Support for additional AI providers
- [ ] Improve provider detection - Better discovery of available models

### Intelligent Routing
- [ ] **Multi-label classification** - Assign multiple categories to a single prompt for more precise routing
  - *Idea*: Allow prompts to match multiple categories (e.g., "code_simple" + "explanation")
  - *Benefit*: More accurate model selection based on combined requirements
  - *Implementation*: Modify `CLASSIFICATION_PROMPT` to return array of categories
- [ ] Implement learning from user feedback - Improve classification based on corrections
- [ ] Add user-specific configurations - Personalized model preferences

### Integration & Extensibility
- [ ] Create plugin system - Extensible architecture for new features
- [ ] Add webhook support - Notifications for model changes

---

## 📊 **Technical Debt**

### Low Priority
- [ ] Clean up archive directory - Remove outdated files
- [ ] Update dependencies - Check for newer versions

### Medium Priority
- [ ] Improve error handling - Better error messages and recovery
- [ ] Add more unit tests - Increase coverage for edge cases

---

## 📅 **Suggested Timeline**

### Week 0: Critical Fixes (1 day)
- [x] Fix dynamic configuration generation
- [x] Implement cloud fallback for classification
- [x] Fix model boundaries

### Week 1: Stabilization
- [ ] Increase test coverage to 90%+
- [ ] Improve mock data for unit tests
- [ ] Optimize build process

### Week 2: Extended Features
- [ ] Implement caching for classification
- [ ] Add batch processing
- [ ] Add more categories

### Week 3+: New Features
- [x] Session escalation on loop detection
- [ ] Multi-label classification
- [ ] Context-based classification

---

## 🎯 **Recommendations for Getting Started**

### 1. Code Review (1-2 hours)
- Review all modules for consistency
- Check import paths
- Verify TypeScript types

### 2. Testing (1-2 hours)
- Run all tests (`npm test`)
- Check test coverage (`npm run test:coverage`)
- Add missing tests for edge cases

### 3. Documentation (1 hour)
- Update README.md with new features
- Add examples for HINT-Override
- Document cost tier system
