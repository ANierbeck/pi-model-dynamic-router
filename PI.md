# pi-model-dynamic-router

Route model group names (strategic, tactical, operational, scout, fallback, **dynamic**) to concrete provider/model pairs. Auto-discovers models and pricing. Balances intelligence, cost, and availability.

## Dynamic Routing

The **dynamic routing** feature introduces a new model group (`dynamic`) that automatically classifies user prompts and selects the optimal model group based on the task type. This enables **context-aware model selection** without manual intervention.

### How It Works

1. **Prompt Classification**: Each user prompt is classified into one of the predefined categories using **Ollama (gemma2:2b)**.
2. **Group Mapping**: The category is mapped to a specific model group (`scout`, `operational`, `tactical`, or `strategic`).
3. **Model Resolution**: The system resolves the best model for the selected group using the existing `resolve_model_group` logic.

### Categories and Mappings

| Category | Model Group | Description |
|----------|-------------|-------------|
| `code_simple` | operational | Simple code changes (1–10 lines, syntax fixes, typos) |
| `code_complex` | tactical | Complex code changes (refactoring, debugging, >50 lines) |
| `design` | strategic | Architecture, system design, API design |
| `planning` | tactical | Project planning, roadmaps, task breakdown |
| `exploration` | scout | Research, unclear requirements, brainstorming |
| `fallback` | tactical | Fallback for unclear or multi-category requests |

### Implementation

The dynamic routing is implemented in **`src/content-classifier.ts`** and integrated via the `before_user_prompt` hook in the extension. The classification is performed using **Ollama (gemma2:2b)**, which must be installed and running locally.

### Requirements

- **Ollama** must be installed and running (`ollama serve`)
- The **gemma2:2b** model must be available (`ollama pull gemma2:2b`)
- Ollama must be accessible from the system (default: `http://localhost:11434`)

## Architecture

### Auto-Discovery Pipeline

```
startup → discoverKeys() → scan() → registerProviders → registerGroups
```

1. **Key discovery**: env vars, auth.json, pass store, CLI OAuth files across 24+ providers
2. **Model scan** (async, non-blocking): Chutes API, OpenRouter API, direct provider /v1/models endpoints
3. **GDPval scrape**: intelligence scores from artificialanalysis.ai, cached with builtin fallbacks
4. **Pricing**: per-provider/model from APIs, OpenRouter backfill for providers without pricing endpoints
5. **Provider registration**: discovered providers registered with pi's modelRegistry (skip built-in + CLI OAuth providers)
6. **Group registration**: virtual providers for each group that route through resolved models

### Key Components

| Component | Purpose | Implementation |
|-----------|---------|----------------|
| **DiscoveryManager** | API key and model discovery | `src/discovery.ts` |
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
| 2 | 2m | **Key rotation** — try next API key for the provider (1hr cooldown on current key) |
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
3. **Register providers**: Register all discovered providers with pi's modelRegistry
4. **Register groups**: Register virtual providers for each model group
5. **Set footer**: Display current model and group in pi's footer

## Configuration

### `router-config.json`

The actual configuration file contains provider definitions, model groups, and cost tiers. Below is a simplified example based on the real configuration:

```json
{
  "providers": {
    "openrouter": {
      "billing": "pay_per_token",
      "free_models": ["openrouter/qwen/qwen3-4b:free", "openrouter/google/gemma-3-4b-it:free"]
    },
    "anthropic": {
      "billing": "pay_per_token"
    },
    "mistral": {
      "billing": "pay_per_token"
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

### Files

| File | Purpose | Description |
|------|---------|-------------|
| `router-config.json` | Providers, groups, optional metric overrides | Main configuration file |
| `.cache/scan-cache.json` | GDPval scores, model lists, pricing, costMux | Persistent cache |
| `skills/router-login/` | Guided provider onboarding skill | Interactive setup |

### Features
- Auto-discovery of models and pricing
- Dynamic routing based on content
- Rate limit handling with key rotation
- Cost optimization with billing preferences
- Modular architecture for easy extension

### Limitations
- No curated model lists (auto-discover everything)
- No token budget tracking (providers don't expose limits)
- Requires Ollama for dynamic routing

## Commands

| Command | Description |
|---------|-------------|
| `/router` | Show status of all model groups |
| `/router <group>` | Details for a specific group (e.g., `/router strategic`) |
| `/router scan` | Re-scan models and GDPval scores |
| `/router reload` | Reload config and cache |

## Tools

| Tool | Description |
|------|-------------|
| `set_model_from_group` | Switch to the best model from a group |
| `resolve_model_group` | Preview what a group resolves to |
| `update_model_metrics` | Manually override model metrics |
