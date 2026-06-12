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

- **Ollama** must be installed and running (`ollama serve`).
- The **gemma2:2b** model must be available (`ollama pull gemma2:2b`).
- Ollama must be accessible from the system (default: `http://localhost:11434`).

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

### Group Selection

| Group | Method | Description |
|-------|--------|-------------|
| **strategic** | `best` | Highest gdpval available, period |
| **tactical** | `tiered` ≥75% | Top 25% quality, cheapest by billing preference |
| **operational** | `tiered` ≥50% | Top 50% quality, cheapest by billing preference |
| **scout** | `tiered` ≥25% | Top 25% quality, cheapest by billing preference |
| **fallback** | `tiered` ≥0% | Any available, cheapest by billing preference |
| **dynamic** | `dynamic` | Auto-classifies prompts via Ollama (gemma2:2b) and routes to the best group |

**Billing preference order**: free → subscription (by rate-limit pressure + cost) → local → pay-per-token (by cost)

### Effective Cost

```
effectiveCost = (baseCost || 0.01) × subDiscount(0.5) × costMux[provider]
```

### Rate Limit Handling

On 429 (after key rotation exhausted): exponential backoff per model, immediate failover to next candidate.

| Hit | Cooldown | Effect |
|-----|----------|--------|
| 1-3 | 1m→4m | failover only |
| 4 | 8m | **costMux[provider] += 1** (max 1/day, never decays) |
| 5-7 | 16m→64m | |
| 8+ | 90m cap | |

### Stream Retry

Groups use proxy streams with soft-failure detection. On empty response or timeout, the router automatically retries with the next candidate model.

## Data Flow

```
session_start → load config + cache, async scan, register providers + groups, set footer
turn_start    → record timestamp + model ref
turn_end      → update throughput/latency EMA, record success
tool_result   → detect 429 → key rotation → backoff + costMux at 4th hit
```

## Key Functions

- `scan()` → async fetch GDPval + models + pricing from APIs
- `allDiscoveredRefs()` → all models from API discovery + pinned
- `resolve(name)` → quality filter + billing preference sort → {selected, candidates}
- `effCost(ref)` → base × subDiscount × costMux
- `lookupPrice(ref)` → config → exact cache → normalized backfill from OpenRouter
- `billingTier(ref)` → 0:free, 1:subscription, 2:local, 3:payg
- `filterByQualityPct(refs, pct)` → keep models at or above gdpval percentile
- `groupStream()` → proxy stream with retry on soft failures

## Config Shape

```jsonc
{
  "providers": {
    "anthropic": { "billing": "subscription", "keys": [{ "key": "!pass show api/claude/token", "label": "primary" }] },
    "chutes": { "billing": "subscription" },
    "openrouter": { "billing": "pay_per_token" },
    "ollama": { "billing": "subscription" }  // Required for dynamic routing
  },
  "model_groups": {
    "strategic": { "method": "best" },
    "tactical": { "method": "tiered", "min_gdpval_pct": 75 },
    "operational": { "method": "tiered", "min_gdpval_pct": 50 },
    "scout": { "method": "tiered", "min_gdpval_pct": 25 },
    "fallback": { "method": "tiered", "min_gdpval_pct": 0 },
    "dynamic": { "method": "dynamic", "description": "Auto-classifies prompts via Ollama (gemma2:2b)" }
  },
  "model_metrics": {}
}
```

No curated model lists. Models auto-discovered. GDPval scores scraped + cached.

### Dynamic Routing Implementation Details

The **`dynamic`** group uses the following workflow:

1. **Prompt Classification**: The `classifyPrompt` function in `src/content-classifier.ts` sends the user prompt to **Ollama (gemma2:2b)** for classification.
2. **Category Mapping**: The classification result is mapped to a model group using `CATEGORY_TO_GROUP`.
3. **Model Resolution**: The `resolve_model_group` tool is called to select the best model for the mapped group.
4. **Model Switching**: The extension automatically switches to the resolved model using `pi.setModel()`.

**Key Functions:**
- `classifyPrompt(prompt, options)`: Classifies a prompt into a category.
- `setupContentBasedRouting(pi)`: Sets up the `before_user_prompt` hook for real-time classification.
- `CATEGORY_TO_GROUP`: Maps categories to model groups (e.g., `code_simple` → `operational`).

**Fallback Behavior:**
- If Ollama is unavailable or classification fails, the system falls back to the `tactical` group.
- If the resolved model is unavailable, the system falls back to the next best candidate in the group.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry point (~1200 lines) |
| `router-config.json` | Providers, groups, optional metric overrides |
| `.cache/scan-cache.json` | GDPval scores, model lists, pricing, costMux |
| `skills/router-login/` | Guided provider onboarding skill |
| `src/content-classifier.ts` | Dynamic prompt classification and routing logic |
| `src/ollama-utils.ts` | Ollama helper functions for classification |
| `PI.md` | This file — design source of truth |
| `README.md` | Quick-start reference |

## What NOT to add

- Curated model lists (auto-discover everything)
- Token budget tracking (providers don't expose limits)
- Proactive load balancing (429 is the signal)
- Auto-switching mid-session (only via explicit tool call)
- Complex health checks (backoff + costMux is sufficient)
- Hardcoded pricing (scrape/backfill from APIs)
