---
name: pi-model-dynamic-router
description: Dynamically routes model group names (strategic/tactical/operational/scout/fallback/dynamic) to concrete models. Balances intelligence, cost, and availability.
---

# pi-model-dynamic-router

**Purpose**: Routes model group names (e.g., `strategic`, `tactical`, `operational`, `scout`, `fallback`, `dynamic`) to concrete provider/model pairs. Auto-discovers models, pricing, and GDPval scores to balance intelligence, cost, and availability.

## Features
- **Auto-Discovery**: Scans for models from 24+ providers (Anthropic, OpenAI, Google, Mistral, etc.).
- **Dynamic Routing**: Uses content-based classification (via Ollama gemma2:2b) to select the best model group for a prompt.
- **Rate Limits**: Automatic key rotation and exponential backoff on 429 errors.
- **Cost Optimization**: Prefers subscription models and applies cost multipliers to rate-limited providers.
- **Modular Architecture**: Code is organized into reusable modules (types, providers, utils, rate-limit, discovery, metrics, cache, routing, content-classifier).

## Architecture

The router uses a **modular architecture** with the following components:

| Module | Purpose |
|--------|---------|
| **providers.ts** | Provider definitions and mappings (24 providers) |
| **types.ts** | Type definitions (Config, Cache, Metrics, RateLimit, etc.) |
| **utils.ts** | Utility functions (string manipulation, reference parsing) |
| **rate-limit.ts** | Rate limit management (key rotation, backoff, cost multiplier) |
| **discovery.ts** | Discovery management (API key discovery, model scanning) |
| **metrics.ts** | Metrics management (GDPval, throughput, latency tracking) |
| **cache.ts** | Cache management (persistent caching, versioning) |
| **routing.ts** | Routing logic (model selection, filtering, sorting) |
| **content-classifier.ts** | Content classification (Ollama-based prompt categorization) |

## Commands
| Command | Description |
|---------|-------------|
| `/router` | Show status of all model groups. |
| `/router <group>` | Details for a specific group (e.g., `/router strategic`). |
| `/router scan` | Re-scan models and GDPval scores. |
| `/router reload` | Reload config and cache. |

## Tools
- `set_model_from_group`: Switch to the best model from a group.
- `resolve_model_group`: Preview what a group resolves to.
- `update_model_metrics`: Manually override model metrics.

## Dynamic Routing

The **`dynamic`** group automatically classifies user prompts using **Ollama (gemma2:2b)** and routes to the most appropriate model group:

| Category | Model Group | Use Case |
|----------|-------------|---------|
| `code_simple` | operational | Simple code changes (1–10 lines, syntax fixes, typos) |
| `code_complex` | tactical | Complex code changes (refactoring, debugging, >50 lines) |
| `design` | strategic | Architecture, system design, API design |
| `planning` | tactical | Project planning, roadmaps, task breakdown |
| `exploration` | scout | Research, unclear requirements, brainstorming |
| `fallback` | fallback | Fallback for unclear requests |

**Requirements for Dynamic Routing:**
- Ollama must be installed and running locally (`ollama serve`)
- The gemma2:2b model must be available (`ollama pull gemma2:2b`)

## Files
- `index.ts`: Core router logic and extension entry point (~1,047 lines)
- `router-config.json`: Provider and group configuration
- `model-map.yaml`: Model to GDPval slug mappings
- `src/content-classifier.ts`: Content-based prompt classification
- `src/ollama-utils.ts`: Ollama helper functions
- `src/types.ts`: Type definitions
- `src/providers.ts`: Provider definitions
- `src/utils.ts`: Utility functions
- `src/rate-limit.ts`: Rate limit management
- `src/discovery.ts`: Discovery management
- `src/metrics.ts`: Metrics management
- `src/cache.ts`: Cache management
- `src/routing.ts`: Routing logic
