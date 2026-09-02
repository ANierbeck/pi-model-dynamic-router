# pi-model-dynamic-router

> Pi extension that routes model group names to concrete provider/model pairs. Auto-discovers models and pricing. Balances intelligence (GDPval), cost, and availability.

> **Fork of [`a-canary/pi-model-router`](https://github.com/a-canary/pi-model-router)** — adds content-based dynamic routing (prompt classification → model group) on top of the upstream's price/quality/availability routing.

## Architecture

The router uses a **modular architecture** with the following components:

| Module | Purpose | Key Features |
|--------|---------|--------------|
| **providers.ts** | Provider definitions and mappings | 26 supported providers, authentication patterns |
| **types.ts** | Type definitions | Config, Cache, Metrics, RateLimit, Group, Provider types |
| **utils.ts** | Utility functions | String manipulation, reference parsing |
| **rate-limit.ts** | Rate limit management | Key rotation, backoff, cost multiplier |
| **discovery.ts** | Discovery management | API key discovery, model scanning |
| **metrics.ts** | Metrics management | GDPval, throughput, latency tracking |
| **cache.ts** | Cache management | Persistent caching, versioning |
| **routing.ts** | Routing logic | Model selection, filtering, sorting |
| **stream-orchestrator.ts** | Stream orchestration | `groupStream`/`driveStream` extraction from index.ts, `buildOrchestratorContext` factory with live getters for router/rateLimitManager/cacheManager |
| **detection.ts** | Error event detection | Rate-limit/abort/overflow text patterns, `isRateLimitLikeReason()`, `isAbortLikeText()`, `parseResetAtMs()` |
| **content-classifier.ts** | Content classification | gemma4:12b-mlx primary, gemma2:2b fallback, cloud fallback via pi's `modelRegistry.completeSimple()` (see ADR 0004) |
| **escalation.ts** | Session escalation | Loop detection, level tracking, session-safe reset |
| **model-matcher.ts** | LLM-assisted model matching | Batched matching, plausibility guard, hallucination rejection |
| **local-llm.ts** | Provider-agnostic LLM caller | Ollama OR LM Studio, OpenRouter free cloud fallback |
| **exclude.ts** | Personalized exclude rules | Provider/pattern/paid-model filtering for all groups |
| **config-loader.ts** | Layered configuration | Deep-merge defaults → global → project-local overrides |

This modular design enables better maintainability, testing, and extensibility.

### GDPval model matching pipeline

When a model needs a GDPval score, the router resolves it in three tiers:

1. **model-map.yaml** (authoritative) — explicit model-id → slug mapping
2. **Token-set fallback** (deterministic) — fuzzy token matching
3. **LLM-assisted matching** (semantic) — a local LLM matches model ids to
   GDPval slugs, with cross-family and size-tier guards

See [`docs/architecture.md`](docs/architecture.md) for details.

### Personalized configuration

Users can override the embedded defaults without editing extension files:

- **Global**: `~/.pi/agent/router-config.user.json`
- **Project-local**: `<project>/.pi/router-config.json`

Supports `exclude` rules (no paid OpenRouter models, no Fable, etc.).
See [`docs/config-override.md`](docs/config-override.md) for details.

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

- `code_simple`: Simple code changes (1-10 lines, syntax fixes, typos)
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

To use the **`dynamic`** group, you need:
- **Ollama** installed and running locally (`ollama serve`)
- **gemma4:12b-mlx** pulled for best classification quality (`ollama pull gemma4:12b-mlx`)
- **gemma2:2b** pulled as fallback (`ollama pull gemma2:2b`) — used automatically if gemma4:12b-mlx fails
- Ollama accessible from your system (default: `http://localhost:11434`)

If both Ollama models are unavailable, the classifier falls back to a free cloud model only when `classifier_cloud_fallback: true` is explicitly set on the `dynamic` group (opt-in, off by default — see [Data handling & privacy](#data-handling--privacy)), and finally to static keyword-based classification (only if `allowStaticFallback` is enabled) — otherwise the category `fallback` is returned.

---

### Cascading Fallback & Intelligent Routing

The router implements a **multi-layer fallback system** that automatically recovers from model failures, rate limits, and unavailability.

#### How it works

When a model fails (API error, rate limit, empty response, or usage limit exceeded), the router:

1. **Tries the next model in the same group**
2. **If all models in the group fail → cascades to fallback groups** in this order:
   ```
   strategic → tactical → operational → scout → fallback
   ```
3. **Continues until a working model is found**

**Example:** You select `dynamic` group, but the first model hits a rate limit → router automatically tries the next `dynamic` model → if all fail, tries `strategic` → then `tactical` → etc.

#### Configuration

Each group can define its fallback chain in `router-config.json`:

```json
{
  "strategic": {
    "description": "Best models by GDPval",
    "method": "best",
    "models": ["anthropic/claude-3-sonnet", "mistral/mistral-medium-3.5"],
    "fallback_groups": ["tactical", "operational", "scout", "fallback"]
  }
}
```

**Note:** The `dynamic` group automatically inherits the full cascade chain.

---

### Group-Based Cost/Quality Routing

The router encodes cost-quality tradeoffs directly in **model groups** rather than a
separate tier overlay. Each group's `min_gdpval` and `max_cost` settings act as the
cost tier: `trivial`/`simple` use `max_cost: 0` (free models only), `scout`/`fallback`
use `min_gdpval: 0` (anything), `tactical`/`strategic` raise the GDPval floor to
600/700. A classified prompt maps to a group via `CATEGORY_TO_GROUP`
(content-classifier.ts), and the group's own filters do the rest.

> **Historical note:** an earlier separate "Cost Tier System" (free/budget/premium
> buckets, `src/cost-tiers.ts`) existed as a second filter layer on top of groups,
> but was removed — it was redundant with the group thresholds and conflicted
> with local models and the fallback cascade (see git history, commit that
> removed it: "remove cost-tier overlay from dynamic routing").

---

### Model Momentum

After **context compaction** (when >30% of tokens are removed or >5 messages/500 tokens are dropped), the router **reuses the previous model** for the next turn.

#### Why?

- **Consistency:** Maintains the same model's "thinking style" after major context changes
- **Efficiency:** Avoids unnecessary model switching
- **Stability:** Reduces variation in responses during long conversations

#### Detection

Compaction is automatically detected when:
- Token count drops by >30% compared to previous turn
- More than 5 messages are removed
- More than 500 tokens are removed

**Note:** Model momentum only forces reuse during compaction. For similar tasks, it provides a **hint** to the classifier.

---

### Status Line Integration

The router now **synchronizes with Pi's status line** to display the **actually active model** (not failed candidates).

#### Behavior

- Status line updates **as soon as a model's stream is established** (before the first token)
- Only shows models that **successfully started streaming**
- Failed candidates (API errors, rate limits) **never appear** in the status line
- After successful completion, the model remains displayed until the next turn

#### Example

```
# Before (incorrect):
scout/dynamic→claude-bridge/claude-fable-5  # ← Failed, but shown!

# After (correct):
scout/dynamic→mistral/mistral-medium-3.5   # ← Actually active model
```

This provides **accurate feedback** about which model is currently generating responses.

---

### Auto-Discovery

On startup, the router automatically:

1. **Discovers API keys** from env vars, `~/.pi/agent/auth.json`, `pass` store, and CLI OAuth files (qwen, gemini) — for `auth.json`/`pass`/CLI-OAuth sources, only a *reference* (e.g. which auth.json entry, which pass path) is kept in memory/config, never the raw secret value; the actual key is looked up on demand only at the moment a request is made to that key's own provider (see [Data handling & privacy](#data-handling--privacy))
2. **Scans models** from Chutes, OpenRouter, and direct provider APIs (Anthropic, OpenAI, Google, Mistral, DeepSeek)
3. **Scrapes GDPval scores** from [Artificial Analysis](https://artificialanalysis.ai/evaluations/gdpval-aa) with hardcoded fallbacks — a plain, unauthenticated GET of a public leaderboard page; no local data is sent
4. **Caches pricing** per provider/model from APIs, with OpenRouter backfill for providers without pricing endpoints

All scanning is async and non-blocking.

### Data handling & privacy

- **API keys are never written to `router-config.json`** (the tracked, in-repo static config). Discovery stores only resolvable reference markers there (env var name, `pass` path, auth-file pointer); the real secret is read from its source (env, `auth.json`, `pass`, CLI OAuth file) only at the point of use and is never persisted back to a tracked file.
- **Prompt content stays local by default.** The dynamic-group content classifier runs against a local Ollama model. If both local classifier models are unavailable, it falls back to static keyword matching (only if `allowStaticFallback` is enabled) rather than sending anything externally.
- **Optional cloud classifier fallback (`classifier_cloud_fallback`, off by default).** If explicitly enabled in `router-config.json`, and only as a last resort when local classification fails, the raw prompt is sent to a free cloud model from your own configured `free_models` for classification purposes. This is opt-in and separate from using that same provider as a normal answering fallback, because classification and answering have different data-exposure implications for the same free-model config. Enable only if you're comfortable with that provider seeing prompt content for classification, not just for answering your requests.
- **GDPval scraping and pricing/model scans are outbound-only, read-only HTTP GETs** to public model/leaderboard endpoints; no prompt content, API keys, or other local data is included in those requests.

---

### Group Selection

Each group auto-discovers available models, filters by quality, and selects by billing preference:

| Group | Method | Quality Filter | Use For |
|-------|--------|---------------|---------|
| **strategic** | `best` | — | Best model available. Critical decisions. |
| **tactical** | `tiered` | >=75th percentile | Top quality, cost-optimized. Planning. |
| **operational** | `tiered` | >=50th percentile | Good quality, cheapest. Daily coding. |
| **scout** | `tiered` | >=25th percentile | Acceptable quality, cheapest. Exploration. |
| **fallback** | `tiered` | >=0th percentile | Any available. Last resort. |
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

---

### Rate Limits & Failover

On HTTP 429 the router works through three escalating responses:

1. **Key rotation** — immediately tries the next API key for the same provider; the exhausted key enters a 1-hour cooldown before rejoining the pool.
2. **Model backoff** — if all keys for a provider are cooling down, the model enters exponential backoff (1 min → 2 → 4 → ... → 90 min cap) and the group falls over to its next-ranked candidate for the current request.
3. **costMux penalty** — after 4 consecutive 429s, the provider receives a permanent cost multiplier for the session (see [costMux](#costmux) above), demoting all its models in future selections.

All three mechanisms are transparent to the user — the session continues with the next available model.

#### Rate Limit & Subscription Handling

The router automatically handles **rate limits, usage limits, and subscription errors** from all providers, including third-party extensions like **claude-bridge**.

##### Supported Error Patterns

| Error Type | Detection | Behavior |
|------------|-----------|----------|
| **Rate Limit (429)** | HTTP 429 response | Soft failure → try next model |
| **Usage Limit Exceeded** | "out of usage credits", "rate limit hit" | Soft failure → try next model |
| **API Provider Not Found** | "No API provider registered" | Soft failure → try next model |
| **Empty Response** | No tokens within timeout | Soft failure → try next model |
| **Hard API Error** | Connection refused, timeout | Soft failure → try next model |

##### Example: Claude Subscription Limits

If you hit your Claude subscription limit:

```
Warning: [rate-limit] Claude unknown rate limit hit — resets unknown
You're out of usage credits. Run /usage-credits to keep using Fable 5
```

**The router will:**
1. Detect the "out of usage credits" message
2. Treat it as a **soft failure** (not a hard error)
3. **Automatically try the next model** in the group
4. If all models in the group fail → cascade to fallback groups

##### Important Notes

- **Claude-bridge:** Different subscription tiers have different model access:
  - **Pro:** Claude 3.5 Sonnet, Haiku
  - **Max:** All models including Fable 5, Opus 5
- **The router cannot know your subscription tier** — it tries models and falls back on errors
- **This is intentional:** It allows graceful degradation when limits are hit

##### Best Practices

1. **Order models by preference** in your groups (most preferred first)
2. **Include fallback models** from different providers
3. **Use cascading fallback groups** for maximum reliability
4. **Check `/usage-credits`** if you consistently hit limits

**Example configuration for reliability:**

```json
{
  "strategic": {
    "models": [
      "claude-bridge/claude-opus-5",    // First choice (Max only)
      "claude-bridge/claude-sonnet-5",  // Fallback (Pro/Max)
      "anthropic/claude-3-5-sonnet",    // Cloud fallback
      "mistral/mistral-medium-3.5"     // Final fallback
    ],
    "fallback_groups": ["tactical", "operational", "scout", "fallback"]
  }
}
```

This ensures **automatic recovery** when subscription limits are hit.

---

### Stream Retry

When a streaming response fails mid-stream (empty body, connection drop, timeout), the group automatically retries with the next ranked candidate without requiring the user to resend the prompt. Soft failures are distinguished from hard errors: a 4xx response is not retried, but an interrupted stream or empty response is.

## Configuration

### Main Configuration File

`router-config.json`:

```jsonc
{
  "providers": {
    "openrouter": {
      "billing": "pay_per_token",
      "free_models": [
        "openrouter/qwen/qwen3-4b:free",
        "openrouter/openai/gpt-4o-mini:free"
      ]
    }
  },
  "model_groups": {
    "strategic": { "method": "best" },
    "tactical": { "method": "tiered", "min_gdpval_pct": 75 },
    "scout": { "method": "tiered", "min_gdpval_pct": 25 }
  },
  "model_metrics": {
    "claude-bridge/claude-sonnet-5": { "cost_per_m": 0.0000015 }
  },
  "gdpval_builtin": {
    "mistral-medium-3-5": 933,
    "claude-sonnet-5": 1603,
    "qwen3-8-27b": 580
  }
}
```

#### Billing Preference (per-group tier override)

By default, `method: "tiered"` sorts by billing tier first: **free → subscription → local → payg**. This means already-paid subscription models (e.g. Mistral) always rank ahead of local compute (Ollama), even in scout where local $0-Modelle conceptually belong on top.

Set `billing_preference: "local_first"` on a group to rank **local models ahead of subscription** (but still after truly-free $0 models). payg stays last. This is opt-in per group — other groups keep the default ordering.

```json
"scout": {
  "method": "tiered",
  "billing_preference": "local_first",
  "min_gdpval": 0
}
```

#### Provider Configuration

**Provider registration is conservative (never overwrites):** the router only registers a provider with Pi when Pi does **not** know it yet — i.e. when `modelRegistry.find(provider, modelId)` returns nothing for every model of that provider. This protects `models.json` entries (with `compat` flags), extension-provided providers, and Pi-native providers from being clobbered. If Pi already knows the provider from any source, the router does not touch the registration.

**Real per-model capabilities (not hardcoded):** when the router does register a provider, it uses the **real** capabilities the scan captured from the provider's `/v1/models` (Mistral `capabilities.vision/reasoning`/`max_context_length`, OpenRouter `architecture.input_modalities`/`context_length`) — never a hardcoded `reasoning: true / input: ['text','image']` blanket. Unknown fields fall back to conservative defaults (`vision: false` unless confirmed, `reasoning: false` unless confirmed), so a model is never falsely advertised as vision-capable (which caused 422 errors for GLM-5-2).

**Ollama is setup-independent:** the router scrapes Ollama's `/api/show` per model to get the real context length (`model_info.*.context_length`) and capabilities, and registers Ollama with `providerOptions.num_ctx` set to that real value — so prompts >32K don't get truncated. This works for **every** user, with or without any specific Ollama extension. The router only registers Ollama when Pi doesn't know it; if another extension or `models.json` already registered Ollama, the router doesn't overwrite.

**Per-provider model filter (optional, generic):** a `PROVIDER_MAP` entry may set `modelFilter: "<regex>"` to constrain which scanned model ids are kept. Generic and user-configurable — not a hardcoded special case. Useful when a key sees a broad catalog (e.g. a provider key that returns all of a vendor's models when the provider is meant for a subset).

#### New Configuration Options

| Option | Purpose | Example |
|--------|---------|---------|
| **`fallback_groups`** | Define cascade chain for fallback | `["tactical", "operational", "scout"]` |
| **`cost_per_m`** | Cost per million tokens (for estimates) | `0.0000015` |
| **`model_metrics`** | Per-model cost overrides | `{ "claude-bridge/claude-sonnet-5": { "cost_per_m": 0.0000015 } }` |
| **`gdpval_builtin`** | GDPval overrides for new models (keyed by **slug**) | `{ "mistral-medium-3-5": 933, "qwen3-8-27b": 580 }` |
| **`billing_preference`** | Per-group tier ordering override (`"local_first"` ranks local models ahead of subscription) | `"local_first"` |
| **`modelFilter`** (PROVIDER_MAP) | Regex to constrain scanned model ids per provider | `"^(zai-)?glm"` |

Groups need no `models` arrays — everything is auto-discovered **plus** any explicitly listed models.

### Adding a Provider

Use the built-in skill: `/skill:router-login`

Or manually:
1. Set API key via env var, `pass`, or `pi auth <provider>`
2. Restart pi — the router discovers keys and scans models automatically

### Supported Providers

**Total: 26 providers**

| Provider | Type | Registration | Notes |
|----------|------|--------------|-------|
| **anthropic** | Built-in | Pi | Token-based (via claude-bridge extension for subscription) |
| **openai** | Built-in | Pi | Standard OpenAI |
| **google** | Built-in | Pi | Google AI |
| **mistral** | Built-in | Pi | Mistral Cloud |
| **openrouter** | Router | Router | **Free tier models available** |
| **ollama** | Extension | Extension | Local models |
| **lm-studio** | Extension | Extension | Local models |
| **claude-bridge** | Extension | Extension | **Claude subscription via local proxy** |
| **qwen-cli** | Extension | Extension | Qwen CLI |
| **gemini-cli** | Extension | Extension | Google Gemini CLI |
| **antigravity** | Extension | Extension | - |
| ... | ... | ... | 20+ more |

**Claude-bridge Support:**
- **Important:** Claude-bridge is a **separate Pi extension** that must be installed to use Claude models with a subscription.
- **How it works:** The extension registers `claude-bridge/*` models with Pi. The router **discovers and uses** them automatically.
- **Model availability** depends on your Claude subscription plan (Pro, Max, etc.).
- **No double registration:** The router **does not** register claude-bridge providers itself — it only uses models already registered by the extension.

### Requirements for Dynamic Routing

To use the **`dynamic`** group, you need:
- **Ollama** installed and running locally (`ollama serve`)
- **gemma4:12b-mlx** pulled for best classification quality (`ollama pull gemma4:12b-mlx`)
- **gemma2:2b** pulled as fallback (`ollama pull gemma2:2b`) — used automatically if gemma4:12b-mlx fails
- Ollama accessible from your system (default: `http://localhost:11434`)

If both Ollama models are unavailable, the classifier falls back to a free cloud model only when `classifier_cloud_fallback: true` is explicitly set on the `dynamic` group (opt-in, off by default — see [Data handling & privacy](#data-handling--privacy)), and finally to static keyword-based classification (only if `allowStaticFallback` is enabled) — otherwise the category `fallback` is returned.

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
