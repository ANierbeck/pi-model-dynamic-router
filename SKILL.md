---
name: pi-model-dynamic-router
description: Dynamically routes model group names (strategic/tactical/operational/scout/fallback/dynamic) to concrete models. Balances intelligence, cost, and availability.
---

# pi-model-dynamic-router

**Purpose**: Routes model group names (e.g., `strategic`, `tactical`, `operational`, `scout`, `fallback`, `dynamic`) to concrete provider/model pairs. Auto-discovers models, pricing, and GDPval scores to balance intelligence, cost, and availability.

## Features

### Core Routing Features
- **Auto-Discovery**: Scans for models from 26+ providers (Anthropic, OpenAI, Google, Mistral, etc.).
- **Dynamic Routing**: Uses content-based classification (via Ollama gemma2:2b) to select the best model group for a prompt.
- **Rate Limits**: Automatic key rotation and exponential backoff on 429 errors.
- **Cost Optimization**: Prefers subscription models and applies cost multipliers to rate-limited providers.
- **Modular Architecture**: Code is organized into reusable modules (types, providers, utils, rate-limit, discovery, metrics, cache, routing, content-classifier).

### New Features (v1.1.8)

#### ✨ Cascading Fallback Groups
- **Automatic recovery** from model failures, rate limits, and unavailability
- **Multi-layer cascade**: strategic → tactical → operational → scout → fallback
- **Transparent to user**: Session continues with next available model
- **Configurable**: Each group can define its own fallback chain via `fallback_groups`

#### 💰 Cost Tier System
- **Three tiers**: Cheap (Ollama, Mistral Small), Medium (Mistral Medium, Claude Sonnet), Expensive (Claude Opus, Fable)
- **Multi-tier escalation**: Direct jumps between tiers based on task complexity
- **Task complexity mapping**: Low (trivial/simple), Medium (standard/code_simple), High (code_complex/design/planning)
- **Automatic optimization**: After expensive model → cheaper models for simple tasks; after cheap model → expensive models for complex tasks

#### ⚡ Model Momentum
- **Consistency after compaction**: Reuses previous model after context compaction (>30% token drop or >5 messages/500 tokens removed)
- **Stability**: Maintains same model's "thinking style" during long conversations
- **Smart hints**: Provides hint to classifier for similar tasks

#### 📊 Status Line Integration
- **Real-time updates**: Status line shows model as soon as stream is established (before first token)
- **Accurate display**: Only shows models that successfully started streaming
- **No false positives**: Failed candidates never appear in status line
- **Pi synchronization**: Uses `pi.setModel()` to sync with Pi's status bar

#### 🔌 Claude-bridge Support
- **Extension-based**: Works with claude-bridge Pi extension for Claude subscription access
- **No double registration**: Router does NOT register claude-bridge providers (handled by extension)
- **Automatic discovery**: claude-bridge models appear in `/router` when extension is loaded
- **Seamless fallback**: Rate limit/subscription errors trigger automatic fallback to next model

#### 🛡️ Enhanced Error Handling
- **Rate limit detection**: Recognizes "out of usage credits", "rate limit hit", "limit hit" errors
- **Soft failure treatment**: Rate limit errors are treated as soft failures (not hard errors)
- **Automatic retry**: Router automatically tries next model in group, then cascades to fallback groups
- **Filtered messages**: Expected errors (rate limits, API not found) are suppressed to reduce noise

#### 📈 GDPval Overrides
- **Custom scores**: Built-in GDPval scores for new/unranked models (mistral-medium-3.5: 933, claude-sonnet-5: 1603, etc.)
- **Provider-based estimates**: Cost estimates for subscription providers via `cost_per_m`
- **Model-specific metrics**: Per-model cost overrides in `model_metrics`

## Architecture

The router uses a **modular architecture** with the following components:

| Module | Purpose |
|--------|---------|
| **providers.ts** | Provider definitions and mappings (26 providers) |
| **types.ts** | Type definitions (Config, Cache, Metrics, RateLimit, etc.) |
| **utils.ts** | Utility functions (string manipulation, reference parsing) |
| **rate-limit.ts** | Rate limit management (key rotation, backoff, cost multiplier) |
| **discovery.ts** | Discovery management (API key discovery, model scanning) |
| **metrics.ts** | Metrics management (GDPval, throughput, latency tracking) |
| **cache.ts** | Cache management (persistent caching, versioning) |
| **routing.ts** | Routing logic (model selection, filtering, sorting, cascading fallback) |
| **content-classifier.ts** | Content classification (Ollama-based prompt categorization, cost-tier escalation) |

## Commands
| Command | Description |
|---------|-------------|
| `/router` | Show status of all model groups with cascading fallback info. |
| `/router <group>` | Details for a specific group including fallback chain (e.g., `/router strategic`). |
| `/router scan` | Re-scan models and GDPval scores. |
| `/router reload` | Reload config and cache. |

## Tools
- `set_model_from_group`: Switch to the best model from a group.
- `resolve_model_group`: Preview what a group resolves to.
- `update_model_metrics`: Manually override model metrics.
- `set_model_from_group`: Switch session to best model from a group.

## Dynamic Routing

The **`dynamic`** group automatically classifies user prompts using **Ollama (gemma2:2b)** and routes to the most appropriate model group:

| Category | Model Group | Use Case |
|----------|-------------|---------|
| `code_simple` | operational | Simple code changes (1-10 lines, syntax fixes, typos) |
| `code_complex` | tactical | Complex code changes (refactoring, debugging, >50 lines) |
| `design` | strategic | Architecture, system design, API design |
| `planning` | tactical | Project planning, roadmaps, task breakdown |
| `exploration` | scout | Research, unclear requirements, brainstorming |
| `fallback` | fallback | Fallback for unclear requests |

**Requirements for Dynamic Routing:**
- Ollama must be installed and running locally (`ollama serve`)
- The gemma2:2b model must be available (`ollama pull gemma2:2b`)

## Files
- `index.ts`: Core router logic and extension entry point (~1,800 lines)
- `router-config.json`: Provider and group configuration with fallback groups
- `model-map.yaml`: Model to GDPval slug mappings (100+ models)
- `src/content-classifier.ts`: Content-based prompt classification with cost-tier escalation
- `src/ollama-utils.ts`: Ollama helper functions
- `src/types.ts`: Type definitions (Group, Provider, Config, etc.)
- `src/providers.ts`: Provider definitions with SKIP_REGISTRATION for built-in/extension providers
- `src/utils.ts`: Utility functions
- `src/rate-limit.ts`: Rate limit management
- `src/discovery.ts`: Discovery management
- `src/metrics.ts`: Metrics management with GDPval overrides
- `src/cache.ts`: Cache management
- `src/routing.ts`: Routing logic with cascading fallback support

## Configuration Highlights

### Provider Registration Philosophy
- **Skip all known providers**: Built-in Pi providers (anthropic, openai, google, mistral) and extension-based providers (ollama, lm-studio, claude-bridge) are **skipped**
- **Only register what Pi doesn't know**: Currently only OpenRouter (for free tier models)
- **Prevent conflicts**: No double registration of providers

### New Configuration Options
- **`fallback_groups`**: Define cascade chain for automatic fallback
- **`cost_per_m`**: Provider-based cost estimates for subscription models
- **`model_metrics`**: Per-model cost overrides
- **`gdpval_builtin`**: GDPval score overrides for new models
- **`exclude_providers` / `exclude_models`**: Filter specific providers/models (available but not used in default config)
