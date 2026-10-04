# pi-model-dynamic-router

Route model group names (strategic, planning, tactical, operational, scout, fallback, **dynamic**) to concrete provider/model pairs. Auto-discovers models and pricing. Balances intelligence, cost, and availability.

## Dynamic Routing

The **dynamic routing** feature introduces a new model group (`dynamic`) that automatically classifies user prompts and selects the optimal model group based on the task type. This enables **context-aware model selection** without manual intervention.

### How It Works

1. **Prompt Classification**: Each user prompt is classified into one of the predefined categories by a classifier chain — cloud-first (`classifier_cloud_fallback`), with Ollama (**mistral-nemo:latest** primary, **gemma2:2b** fallback) as the local last resort.
2. **Group Mapping**: The category is mapped to a specific model group via the shipped `CATEGORY_TO_GROUP` table (`scout`, `operational`, `simple`, `tactical`, or the top-tier `planning` group).
3. **Model Resolution**: The system resolves the best model for the selected group using the existing `resolve_model_group` logic.

### Categories and Mappings

| Category | Model Group | Description |
|----------|-------------|-------------|
| `trivial` | scout | Greetings, one-liners |
| `simple` | operational | Simple conversational requests |
| `standard` | operational | Everyday tasks |
| `code_simple` | simple | Simple code changes (1-10 lines, syntax fixes, typos) |
| `code_complex` | tactical | Complex code changes (refactoring, debugging, >50 lines) |
| `design` | planning | Architecture, system design, API design — top tier only |
| `planning` | planning | Project planning, roadmaps, task breakdown — top tier only |
| `exploration` | scout | Research, unclear requirements, brainstorming |
| `fallback` | tactical | Fallback for unclear or multi-category requests |

### Implementation

The dynamic routing is implemented in **`src/content-classifier.ts`** and integrated via the `before_user_prompt` hook in the extension.

### Requirements

With the shipped cloud-first classifier chain, **no local setup is required** —
classification runs on free cloud models, and Ollama is only the last resort:

- **Optional, for local-only classification**: **Ollama** installed and running (`ollama serve`), with **mistral-nemo:latest** (primary) and **gemma2:2b** (fallback) pulled
- If every classifier hop fails, the category `fallback` is returned (or static keyword classification, if `allowStaticFallback` is enabled)

## Architecture

### Auto-Discovery Pipeline

```
startup → load config + cache → scan() → register local Ollama + groups
```

1. **Key resolution (ADR-0022)**: the router resolves NO keys itself — Pi owns credential resolution end-to-end (auth.json incl. `!` secret commands, models.json, env vars, CLI OAuth) and answers `getApiKeyForProvider` on demand
2. **Model scan** (async, non-blocking): local daemons (Ollama /api/show, LM Studio), OpenRouter pricing catalog
3. **GDPval + capability scrape**: quality scores from artificialanalysis.ai — one page fetch yields GDPval plus the per-task capability columns (AA-Briefcase Elo, SciCode, Terminal-Bench); cached with builtin fallbacks
4. **Pricing**: per-provider/model from APIs, OpenRouter backfill for providers without pricing endpoints
5. **Provider registration (ADR-0021)**: cloud inventory comes from Pi's registry — the router registers only local Ollama (real capabilities from /api/show), explicitly configured `free_models`, and its own virtual group providers
6. **Group registration**: virtual providers for each group that route through resolved models

### Key Components

| Component | Purpose | Implementation |
|-----------|---------|----------------|
| **DiscoveryManager** | Model/pricing discovery (keys are Pi's business — ADR-0022) | `src/discovery.ts` |
| **RateLimitManager** | Rate limit handling | `src/rate-limit.ts` |
| **Metrics** | GDPval, cost, latency tracking | `src/metrics.ts` |
| **CacheManager** | Persistent caching | `src/cache.ts` |
| **Router** | Model group resolution | `src/routing.ts` |
| **ContentClassifier** | Prompt classification | `src/content-classifier.ts` |

## Rate Limits & Failover

### Rate Limit Strategy

| Attempt | Delay | Action |
|---------|-------|--------|
| 1 | 1m | Try current key |
| 2 | 2m | **Exponential backoff** — the group falls over to its next-ranked candidate (ADR-0022: exactly one key per provider, owned by Pi — there is no key rotation) |
| 3 | 4m | **Exponential backoff** — double previous delay |
| 4 | 8m | **Exponential backoff + costMux** — double previous delay, on 4th consecutive 429 provider gets permanent cost penalty |
| 5 | 16m | **Exponential backoff** — double previous delay |
| 6 | 32m | **Exponential backoff** — double previous delay |
| 7 | 64m | **Exponential backoff** — double previous delay |
| 8 | 90m | **Exponential backoff** — would be 128m if doubled, but capped at 90m |

### Cost Multiplier

```
effectiveCost = (baseCost || 0.01) × subDiscount(0.5) × costMux[provider]
```

- **subDiscount**: 0.5 for subscription providers (lower rate limit pressure)
- **costMux**: Permanent multiplier (max 1/day, never decays) for providers with 4+ consecutive 429 errors

## Billing Preference

**Order**: free → subscription (lowest rate-limit pressure) → local → pay-per-token (by cost)

- **Free models**: Always preferred (cost = 0)
- **Subscription models**: Lower cost multiplier (0.5)
- **Local models**: No cost multiplier (1.0)
- **Pay-per-token models**: Full cost (1.0)

## Startup Sequence

```
session_start → load config + cache, async scan, register providers + groups, set footer
```

1. **Load configuration**: Load `router-config.json` and cache
2. **Async scan**: Scan for models and GDPval scores in background
3. **Register providers**: Only local Ollama, explicitly configured `free_models`, and the router's own virtual group providers (ADR-0021 — Pi's registry owns the cloud inventory)
4. **Register groups**: Register virtual providers for each model group
5. **Set footer**: Display current model and group in pi's footer

## Configuration

### `router-config.json`

The actual configuration file contains provider definitions and model groups. Below is a simplified example based on the real configuration:

```json
{
  "providers": {
    "openrouter": {
      "billing": "pay_per_token",
      "free_models": [
        "openrouter/qwen/qwen3-4b:free",
        "openrouter/google/gemma-3-4b-it:free"
      ]
    }
  },
  "model_groups": {
    "trivial": {
      "description": "Trivial tasks - free models only",
      "method": "min_cost",
      "max_cost": 0,
      "models": ["qwen/qwen3-4b:free", "google/gemma-3-4b-it:free"]
    },
    "simple": {
      "description": "Simple tasks - free models only",
      "method": "min_cost",
      "max_cost": 0,
      "models": ["qwen/qwen3-4b:free", "google/gemma-3-12b-it:free"]
    },
    "standard": {
      "description": "Standard tasks - cost-effective models",
      "method": "tiered",
      "min_gdpval": 500,
      "max_cost_per_m": 0.5,
      "models": ["openai/gpt-4o-mini", "anthropic/claude-3-haiku"]
    },
    "complex": {
      "description": "Complex tasks - GDPval >=600 (mistral-medium tier), best available",
      "method": "best",
      "min_gdpval": 600,
      "models": ["anthropic/claude-3-sonnet", "openai/gpt-4o", "mistral/mistral-medium-3.5"]
    },
    "tactical": {
      "description": "GDPval >=600: magistral/mistral-medium tier, best available",
      "method": "best",
      "min_gdpval": 600,
      "models": ["mistral/mistral-medium-3.5"]
    },
    "dynamic": {
      "description": "Dynamic model selection based on content classification",
      "method": "dynamic"
    },
    "fallback": {
      "description": "Fallback group for ambiguous requests",
      "method": "tiered",
      "models": ["anthropic/claude-3-haiku"]
    }
  },
  "gdpval_builtin": {
    "magistral-small": 665,
    "magistral-medium": 669
  }
}
```

Note: The actual configuration may contain additional fields and values. See `router-config.json` for the complete and up-to-date configuration.

### New Configuration Options

#### Provider Configuration

**Important (ADR-0021, 2026-10-02):** The router **never registers models
Pi does not already know**. Pi's registry (builtin catalog + `models.json` +
extensions) is the single source of truth for the cloud model inventory; the
router only enriches and uses what Pi already resolves (GDPval, pricing,
capabilities). New provider models become routable when Pi ships them (or via
`models.json`), not before; provider keys must live where Pi resolves them
(`auth.json` / `models.json`) — for scan-discovered models, router-config keys
alone no longer make a provider routable (the configured-`free_models` row
below is the explicit exception: on-demand registration resolves its key
from the provider config).

What the router still registers (ADR-0021 out-of-scope decisions):

| Registration | Notes |
|--------------|-------|
| **Local Ollama** | The only local registration — Pi has no live local-discovery mechanism; `num_ctx` comes from real capabilities the scan captured from `/api/show` |
| **Configured free models** | On demand (`free_models` in the provider config) — explicit user intent, not scan discovery; never overwrites a provider Pi knows |
| **Virtual group providers** | The router's own product surface (`strategic`, `tactical`, …) |

A `SKIP_REGISTRATION` set used to guard the (removed) scan-union registration;
it was deleted together with it in commit `ff81300`.

#### Fallback Groups

Define a **cascade chain** for automatic fallback when all models in a group fail:

```json
{
  "strategic": {
    "method": "best",
    "models": ["anthropic/claude-3-sonnet", "mistral/mistral-medium-3.5"],
    "fallback_groups": ["tactical", "operational", "scout", "fallback"]
  },
  "tactical": {
    "method": "best",
    "min_gdpval": 600,
    "models": ["mistral/mistral-medium-3.5"],
    "fallback_groups": ["operational", "scout", "fallback"]
  }
}
```

**Cascade order:** `strategic → tactical → operational → scout → fallback`

When a model fails (API error, rate limit, empty response), the router automatically tries the next model in the same group, then descends to the fallback groups in order.

#### Model Metrics

Override cost per million tokens for specific models:

```json
{
  "model_metrics": {
    "claude-bridge/claude-sonnet-5": { "cost_per_m": 0.0000015 },
    "claude-bridge/claude-opus-5": { "cost_per_m": 0.0000015 },
    "claude-bridge/claude-fable-5": { "cost_per_m": 0.0000015 }
  }
}
```

**Purpose:** Provide cost estimates for models not in the OpenRouter pricing database.

#### GDPval Builtins

Override GDPval scores for new or unranked models:

```json
{
  "gdpval_builtin": {
    "mistral-medium-3-5": 933,    // Was 665, corrected to 933
    "claude-sonnet-5": 1603,
    "claude-fable-5": 1747,
    "claude-opus-5": 1860
  }
}
```

**Purpose:** Ensure new Claude models have correct GDPval scores for proper ranking.

#### Exclude Providers/Models

Filter out specific providers or models from selection:

```json
{
  "model_groups": {
    "strategic": {
      "exclude_providers": ["openai"],
      "exclude_models": ["anthropic/claude-3-haiku"],
      "models": ["anthropic/claude-3-sonnet", "mistral/mistral-medium-3.5"]
    }
  }
}
```

**Note:** Currently not actively used in the default config, but available for custom configurations.

### Files

| File | Purpose | Description |
|------|---------|-------------|
| `router-config.json` | Providers, groups, optional metric overrides | Main configuration file |
| `.cache/scan-cache.json` | GDPval scores, model lists, pricing, costMux | Persistent cache |
| `skills/router-login/` | Guided provider onboarding skill | Interactive setup |

### Features

- Auto-discovery of models and pricing
- Dynamic routing based on content
- Rate limit handling with model backoff and provider cooldowns
- Cost optimization with billing preferences
- **Cascading fallback groups** for automatic recovery
- **Group-based cost/quality routing** — cost-quality tradeoffs encoded directly in each group's `min_gdpval`/`max_cost` thresholds (no separate tier overlay)
- **Model momentum** for consistency after compaction
- **Status line integration** for accurate model display
- **Claude-bridge support** via extension
- Modular architecture for easy extension

### Limitations

- No curated model lists (auto-discover everything plus explicit models)
- No token budget tracking (providers don't expose limits)
- Cloud-first classification needs at least one reachable free cloud model; without one, Ollama (or the optional static fallback) is required

## Commands

| Command | Description |
|---------|-------------|
| `/router` | Show status of all model groups |
| `/router <group>` | Details for a specific group (e.g., `/router strategic`) |
| `/router scan` | Re-scan models and GDPval scores |
| `/router blocklist` | Models blocked after a permanent provider failure (reason, since, re-probe time) |
| `/router blocklist clear [ref]` | Unblock one model, or all (e.g. after fixing an API key) |
| `/router reload` | Reload config and cache |

## Tools

| Tool | Description |
|------|-------------|
| `set_model_from_group` | Switch to the best model from a group |
| `resolve_model_group` | Preview what a group resolves to |
| `update_model_metrics` | Manually override model metrics |
| `bulk_read` | Answer a question about files via a cheap reader model without loading them into the session context |

## Additional Documentation

- **AGENT.md**: Quick reference guide for AI agents using this extension
- **CLAUDE.md**: Specific information about Claude model support and claude-bridge integration
- **README.md**: Complete documentation with architecture, features, and configuration details
- **docs/architecture.md**: Detailed architecture documentation
- **docs/config-override.md**: Guide for custom configuration overrides
