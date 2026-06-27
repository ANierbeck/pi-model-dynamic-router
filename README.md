# pi-model-router

> Pi extension that routes model group names to concrete provider/model pairs. Auto-discovers models and pricing. Balances intelligence (GDPval), cost, and availability.

> **Fork of [`a-canary/pi-model-router`](https://github.com/a-canary/pi-model-router)** — adds content-based dynamic routing (prompt classification → model group) on top of the upstream's price/quality/availability routing.

## Architecture

The router uses a **modular architecture** with the following components:

| Module | Purpose | Key Features |
|--------|---------|--------------|
| **providers.ts** | Provider definitions and mappings | 25 supported providers, authentication patterns |
| **types.ts** | Type definitions | Config, Cache, Metrics, RateLimit, Group, Provider types |
| **utils.ts** | Utility functions | String manipulation, reference parsing |
| **rate-limit.ts** | Rate limit management | Key rotation, backoff, cost multiplier |
| **discovery.ts** | Discovery management | API key discovery, model scanning |
| **metrics.ts** | Metrics management | GDPval, throughput, latency tracking |
| **cache.ts** | Cache management | Persistent caching, versioning |
| **routing.ts** | Routing logic | Model selection, filtering, sorting |
| **content-classifier.ts** | Content classification | gemma4:12b-mlx primary, gemma2:2b fallback, cloud fallback |
| **escalation.ts** | Session escalation | Loop detection, level tracking, session-safe reset |

This modular design enables better maintainability, testing, and extensibility.

## Install

```bash
pi install npm:@anierbeck/pi-model-dynamic-router
# Or symlink for development
ln -s ~/pi-model-dynamic-router ~/.pi/agent/extensions/pi-model-dynamic-router
```

Then `/reload` in pi.

## How It Works

### Dynamic Routing

The **dynamic routing** feature automatically classifies user prompts and selects the optimal model group based on the task type. It uses Ollama (**gemma4:12b-mlx** primary, **gemma2:2b** fallback) for real-time classification and routes to one of the predefined groups: `strategic`, `tactical`, `operational`, `scout`, or `fallback`.

#### Categories for Classification

The system classifies prompts into the following categories:

- `code_simple`: Simple code changes (1–10 lines, syntax fixes, typos)
- `code_complex`: Complex code changes (refactoring, debugging, >50 lines)
- `design`: Architecture, system design, API design
- `planning`: Project planning, roadmaps, task breakdown
- `exploration`: Research, unclear requirements, brainstorming
- `fallback`: Unclear or multiple categories apply

#### Mapping of Categories to Model Groups

Each category maps to a specific model group:

| Category | Model Group | Use Case |
|----------|-------------|----------|
| `code_simple` | operational | Simple coding tasks |
| `code_complex` | tactical | Complex coding tasks |
| `design` | strategic | High-level design decisions |
| `planning` | tactical | Project planning and coordination |
| `exploration` | scout | Research and exploration |
| `fallback` | fallback | Fallback for unclear requests |

#### Dynamic Group

The **`dynamic`** group is a special group that uses Ollama (**gemma4:12b-mlx** primary, **gemma2:2b** fallback) to classify each prompt in real-time and automatically routes to the most appropriate model group (`scout`, `operational`, `tactical`, or `strategic`). This enables **context-aware model selection** without manual intervention.

**Requirements for Dynamic Routing:**
- **Ollama** must be installed and running locally.
- The **gemma2:2b** model must be available in Ollama (`ollama pull gemma2:2b`).

### Auto-Discovery

### Auto-Discovery

On startup, the router automatically:

1. **Discovers API keys** from env vars, `~/.pi/agent/auth.json`, `pass` store, and CLI OAuth files (qwen, gemini)
2. **Scans models** from Chutes, OpenRouter, and direct provider APIs (Anthropic, OpenAI, Google, Mistral, DeepSeek)
3. **Scrapes GDPval scores** from [Artificial Analysis](https://artificialanalysis.ai/evaluations/gdpval-aa) with hardcoded fallbacks
4. **Caches pricing** per provider/model from APIs, with OpenRouter backfill for providers without pricing endpoints

All scanning is async and non-blocking.

### Group Selection

Each group auto-discovers available models, filters by quality, and selects by billing preference:

| Group | Method | Quality Filter | Use For |
|-------|--------|---------------|---------|
| **strategic** | `best` | — | Best model available. Critical decisions. |
| **tactical** | `tiered` | ≥75th percentile | Top quality, cost-optimized. Planning. |
| **operational** | `tiered` | ≥50th percentile | Good quality, cheapest. Daily coding. |
| **scout** | `tiered` | ≥25th percentile | Acceptable quality, cheapest. Exploration. |
| **fallback** | `tiered` | ≥0th percentile | Any available. Last resort. |
| **dynamic** | `dynamic` | — | Auto-classifies prompts and routes to the best group. |

No curated model lists. Groups draw from all discovered models automatically.

#### GDPval

GDPval is a composite quality score from [Artificial Analysis](https://artificialanalysis.ai/evaluations/gdpval-aa) that combines intelligence, throughput, and cost-efficiency into a single number. Higher = better overall value. The router scrapes scores **once** on first run and caches them; subsequent startups use the cache. Use `/router scan` to force a refresh. Hardcoded fallbacks from `gdpval_builtin` in the config are always loaded as a baseline.

#### Price Routing — how `tiered` works

1. **Filter** — discard any model below the group's GDPval percentile threshold.
2. **Sort** — rank survivors by billing tier first, then by effective cost within each tier:
   - Tier 0: free models
   - Tier 1: subscription (lowest rate-limit pressure first, then cost)
   - Tier 2: local (Ollama / LM Studio)
   - Tier 3: pay-per-token (ascending effective cost)
3. **Select** — pick the top-ranked model (cheapest within the preferred billing tier that clears the quality floor).

This means `operational` always uses the cheapest model that is at least median quality, while `strategic` always picks the single highest-scoring model regardless of cost.

#### costMux

After 4 consecutive HTTP 429s from a provider, the router applies a permanent **cost multiplier penalty** (`costMux`) to all its models. This pushes the provider to the back of the sorted list without blocking it entirely — useful when a provider is temporarily overloaded but still reachable. The penalty persists for the session and is reset on `/router reload`.

### Rate Limits & Failover

On HTTP 429 the router works through three escalating responses:

1. **Key rotation** — immediately tries the next API key for the same provider; the exhausted key enters a 1-hour cooldown before rejoining the pool.
2. **Model backoff** — if all keys for a provider are cooling down, the model enters exponential backoff (1 min → 2 → 4 → … → 90 min cap) and the group falls over to its next-ranked candidate for the current request.
3. **costMux penalty** — after 4 consecutive 429s, the provider receives a permanent cost multiplier for the session (see [costMux](#costmux) above), demoting all its models in future selections.

All three mechanisms are transparent to the user — the session continues with the next available model.

### Stream Retry

When a streaming response fails mid-stream (empty body, connection drop, timeout), the group automatically retries with the next ranked candidate without requiring the user to resend the prompt. Soft failures are distinguished from hard errors: a 4xx response is not retried, but an interrupted stream or empty response is.

## Configuration

### Main Configuration File

`router-config.json`:

```jsonc
{
  "providers": {
    "anthropic": { "billing": "subscription", "keys": [{ "key": "!pass show api/claude/token" }] },
    "chutes": { "billing": "subscription" },
    "openrouter": { "billing": "pay_per_token" }
  },
  "model_groups": {
    "strategic": { "method": "best" },
    "tactical": { "method": "tiered", "min_gdpval_pct": 75 },
    "scout": { "method": "tiered", "min_gdpval_pct": 25 }
  },
  "model_metrics": {}
}
```

Groups need no `models` arrays — everything is auto-discovered.

### Adding a Provider

Use the built-in skill: `/skill:router-login`

Or manually:
1. Set API key via env var, `pass`, or `pi auth <provider>`
2. Restart pi — the router discovers keys and scans models automatically

### Supported Providers (25)

anthropic, openai, google, openrouter, chutes, mistral, groq, cerebras, xai, zai, huggingface, kimi-coding, minimax, minimax-cn, opencode, opencode-go, vercel-ai-gateway, azure-openai, deepseek, github-copilot, qwen-cli, gemini-cli, antigravity, ollama, lm-studio

### Requirements for Dynamic Routing

To use the **`dynamic`** group, you need:
- **Ollama** installed and running locally (`ollama serve`)
- **gemma4:12b-mlx** pulled for best classification quality (`ollama pull gemma4:12b-mlx`)
- **gemma2:2b** pulled as fallback (`ollama pull gemma2:2b`) — used automatically if gemma4:12b-mlx fails
- Ollama accessible from your system (default: `http://localhost:11434`)

If both Ollama models are unavailable, the classifier falls back to cloud models (if configured), and finally to static keyword-based classification (only if `allowStaticFallback` is enabled) — otherwise the category `fallback` is returned.

## Commands

| Command | Description |
|---------|-------------|
| `/router` | Overview: providers, groups, selections, rate limits |
| `/router <group>` | Detailed view of a group with ranked candidates |
| `/router scan` | Re-scan models and GDPval scores |
| `/router reload` | Hot-reload config and cache |

## Tools

| Tool | Purpose |
|------|---------|
| `set_model_from_group` | Switch session to best model from a group |
| `resolve_model_group` | Preview what a group would resolve to |
| `update_model_metrics` | Manual metric override |

### Dynamic Routing Tools

The **`dynamic`** group uses the following internal tools:
- **`classifyPrompt`**: Classifies user prompts into categories (via Ollama).
- **`getGroupForCategory`**: Maps categories to model groups.
- **`setupContentBasedRouting`**: PI hook for real-time classification and model switching.

## Footer

```
strategic/anthropic/claude-opus-4-6 | int:1450 tps:80 | 12k/8k $1.43 62% | ⏱14m | ⌂ proj | ⎇ main | ⛔2
```

## License

MIT
