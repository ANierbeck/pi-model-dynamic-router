# pi-model-dynamic-router

> Pi extension that routes model group names to concrete provider/model pairs. Auto-discovers models and pricing. Balances intelligence (GDPval), cost, and availability.

> **Fork of [`a-canary/pi-model-router`](https://github.com/a-canary/pi-model-router)** — adds content-based dynamic routing (prompt classification → model group) on top of the upstream's price/quality/availability routing.

## What You Get

- **Content-aware routing** — every prompt is classified (trivial one-liner up to
  architecture review) and routed to a matching model tier: free models for daily
  coding, top-tier models reserved for design and planning work.
- **Automatic discovery & pricing** — the router scans local daemons (Ollama,
  LM Studio) and cloud catalogs, and scrapes Artificial Analysis benchmark
  scores (GDPval plus per-task capability columns: AA-Briefcase Elo for
  planning work, SciCode/Terminal-Bench for coding).
- **Cost & quota balancing** — flat-fee subscription models carry the daily
  load so expensive top-tier models stay available; quality-equivalence
  windows pick the cheapest model that is just as good.
- **Failover everywhere** — model backoff, provider cooldowns, cascading
  fallback groups, and mid-stream retries are all transparent: the session
  just continues on the next best model.

## Quick Start

```bash
pi install npm:@anierbeck/pi-model-dynamic-router
# Development checkout instead:
ln -s ~/pi-model-dynamic-router ~/.pi/agent/extensions/pi-model-dynamic-router
```

1. **Add a provider key** — keys live with Pi, not with the router
   (see [Adding a Provider](#adding-a-provider)).
2. Run `/reload` in pi — the router discovers models, prices, and quality
   scores automatically.
3. Switch your session to a group: `scout`, `operational`, `tactical`,
   `strategic`, `planning`, or `dynamic` (content-classified per prompt).

The shipped defaults need no configuration. To personalize, see
[Personalized configuration](#personalized-configuration) below — or jump
straight to [How It Works](#how-it-works).

## Personalized configuration

Users can override the embedded defaults without editing extension files:

- **Global**: `~/.pi/agent/router-config.user.json`
- **Project-local**: `<project>/.pi/router-config.json`

Supports `exclude` rules (no paid OpenRouter models, no Fable, etc.).
See [`docs/config-override.md`](docs/config-override.md) for details.

You can also change exclusion rules live from the Pi prompt without editing JSON:

```
> /router config
Router config

Sources (later layers override earlier ones; exclude lists are unioned):
  shipped   <pi-extensions>/pi-model-dynamic-router/router-config.json
  user     <pi-agent>/router-config.user.json
  project  <project>/.pi/router-config.json (not present)

Exclude rules:
  [shipped] models: openrouter/*  → matches 8 discovered model(s)
  [user]    models: mistral/*  → matches 3 discovered model(s)

Compaction (context_budget): off (no soft_tokens/hard_tokens configured — triggers disarmed)

Usage:
  /router config                          show config sources + exclude rules
  /router config exclude <ref|glob>       exclude a model/pattern from routing
  /router config unexclude <ref|glob>     remove a user-layer exclusion
  /router config compaction on|off        cache-aware auto-compaction (Phase 5b)
Shipped and project entries cannot be removed with unexclude — only user-layer entries can.
```

Example: exclude all Anthropic models from routing:
```
> /router config exclude anthropic/*
Excluded "anthropic/*" — it matches 5 discovered model(s) right now.
Saved to <pi-agent>/router-config.user.json. The live pipeline applies it from the next turn; it takes full effect at the next scan cycle for persisted group lists.
```

To undo:
```
> /router config unexclude anthropic/*
Removed "anthropic/*" from the user config (<pi-agent>/router-config.user.json). The live pipeline applies it from the next turn; it takes full effect at the next scan cycle for persisted group lists.
```

### Category-to-Group Mapping

The built-in `CATEGORY_TO_GROUP` mapping routes each classification category to a model group (e.g., `code_complex` → `tactical`). Users can override individual mappings via the `category_groups` config key:

```json
{
  "category_groups": {
    "code_complex": "planning"
  }
}
```

Unknown categories or target groups are rejected with a warning at load time and ignored; the rest of the mapping still applies.

When the classifier is uncertain and returns `fallback`, the classification now inherits the previous turn's category (same momentum mechanism as the short-prompt path), so a conversation keeps its routing context; without history the configured default (`fallback` → `tactical`) stands.

### Budget Pacing

`providers.<p>.budget` declares a spend allowance per provider (user-layer key; absent = off). The router compares its own usage counter against the **linear** target for the current window — a provider that runs ahead of pace is **demoted**: it stays a candidate (failover still reaches it) but ranks behind every on-pace candidate in every group. The counter is the persistent usage log, cached context included; the window restarts each month at `reset_day` (clamped to shorter months). `unit: "tokens"` counts tokens, `unit: "usd"` estimates spend via the router's blended $/1M price. Works for capped subscriptions and pay-per-token spend limits alike:

```json
{
  "providers": {
    "claude-bridge": {
      "billing": "subscription",
      "budget": { "amount": 50000000, "unit": "tokens", "period": "month", "reset_day": 1 }
    },
    "openrouter": {
      "billing": "pay_per_token",
      "budget": { "amount": 20, "unit": "usd", "period": "month", "reset_day": 1 }
    }
  }
}
```

A malformed budget is ignored (the provider stays unpaced) — a typo never removes a provider from routing.

### Cache-Aware Compaction

Long agentic sessions burn most of their cost resending context — and a **cold cache is the cheapest moment to compact**: after a miss the next step pays full input price anyway, so compacting then discards nothing already paid for, while compacting a warm cache throws a paid cache away. `context_budget` makes the router act on that (opt-in; absent = off — measurement, shipped with the footer's `ctx/cache` segment, is always on):

```json
{
  "context_budget": { "enabled": true, "soft_tokens": 150000, "hard_tokens": 400000, "cache_ttl_s": 300 }
}
```

Evaluated at every **turn boundary** (never between tool steps): context over `hard_tokens` compacts regardless of cache state; context over `soft_tokens` compacts only when the cache is cold — a miss on the last step (cacheRead below half the step's tokens; partial hits count as mostly-reprocessed), an idle gap over `cache_ttl_s`, or no step recorded yet (fresh/resumed session). A warm cache is never thrown away. Per-group overrides live on `model_groups.<g>.context_budget` and win per field over the global block.

Heuristic caveat (honest disclosure): the "last step" is the last entry of the shared persistent `usage_log` — with concurrent sessions, or right after resuming one, the signal can come from another session, in which case the trigger can misfire in the wasteful direction (compacting a warm cache costs one full-price step — the same cost the feature already accepts on a genuinely cold start) or the conservative direction (a cheap compaction opportunity is missed). Never a wrong exclusion; opt-in only.

- **Hints** (default): with `enabled` false or absent but thresholds configured, the same conditions only produce a hint — "compacting now would pay off: /compact" (at most one per 30 minutes).
- **Automatic**: `enabled: true` additionally calls Pi's compaction at the boundary instead of hinting.
- `/router config compaction on|off` toggles the master switch live (persisted to `router-config.user.json`; the thresholds remain hand-edited config).

## How It Works

For the full runtime decision tree (classification → category → group →
gates → ranking → failure handling) as a Mermaid diagram, see
[`docs/routing-flow.md`](docs/routing-flow.md).

### Dynamic Routing

The **dynamic routing** feature automatically classifies user prompts and selects the optimal model group based on the task type. It uses a classifier chain (cloud-first with `classifier_cloud_fallback: true`, a local Ollama chain derived from the models you have pulled as the last resort) and routes by the `CATEGORY_TO_GROUP` table in `src/content-classifier.ts`: `trivial`/`exploration` → `scout`, `simple`/`standard` → `operational`, `code_simple` → `simple`, `code_complex`/`fallback` → `tactical`, and `design`/`planning` → `planning` (top tier only).

#### Categories for Classification

The system classifies prompts into the following categories (see `CATEGORY_TO_GROUP` in `src/content-classifier.ts` for the authoritative mapping):

- `trivial`: Greetings, one-liners, questions about the router itself
- `simple`: Simple conversational requests
- `standard`: Everyday tasks with no special shape
- `code_simple`: Simple code changes (1-10 lines, syntax fixes, typos)
- `code_complex`: Complex code changes (refactoring, debugging, >50 lines)
- `design`: Architecture, system design, API design
- `planning`: Project planning, roadmaps, task breakdown
- `exploration`: Research, unclear requirements, brainstorming
- `fallback`: Unclear or multiple categories apply

#### Mapping of Categories to Model Groups

Each category maps to a specific model group (`CATEGORY_TO_GROUP`, `src/content-classifier.ts`). Two tier-routing mechanisms (ADR-0023) keep the tiers meaningful despite GDPval compression at the top of the score range: a per-group **`max_gdpval`** cap (the shipped `tactical` is capped at 1700, so the flat-fee Mistral tank — glm-5-3 at 1644 — carries the daily `code_complex` load, while Claude's top models stay in `strategic`), and a **`best_quality_window`** (default 5%): inside a `best`-method group, candidates within the window of the best score are treated as equally good — cheapest first, cost ties to the lower score (in `strategic`, claude-sonnet-5-5 beats claude-opus-5-5 at equal subscription cost). On Mistral-quota days, `tactical` escalates through its `fallback_groups` into `strategic`, so Claude takes over automatically. Since the AA multi-benchmark round, a group can additionally rank its pool task-type-aware via **`score_by`** (ADR-0023 round 2): the same Artificial Analysis scrape that yields GDPval also carries the per-benchmark columns, so `planning` ranks by AA-Briefcase Elo and `tactical` by the SciCode/Terminal-Bench coding blend — floors and caps stay on GDPval, and a missing column falls back to GDPval ordering.

| Category | Model Group | Use Case |
|----------|-------------|----------|
| `trivial` | scout | Greetings, one-liners — any free model |
| `simple` | operational | Simple conversational requests |
| `standard` | operational | Everyday tasks (GDPval ≥ 300) |
| `code_simple` | simple | Simple coding tasks (GDPval ≥ 300, free models only) |
| `code_complex` | tactical | Complex coding tasks (GDPval ≥ 600, capped at 1700 — the free-tank tier) |
| `design` | planning | High-stakes design decisions — top tier only (GDPval ≥ 1700) |
| `planning` | planning | Project planning and architecture — top tier only (GDPval ≥ 1700) |
| `exploration` | scout | Research and exploration — any model, cheap |
| `fallback` | tactical | Uncertain classification — a decent model, not a free one |

#### Dynamic Group

The **`dynamic`** group is a special group that classifies each prompt in real-time (cloud chain first, Ollama as last resort: primary/fallback derived from your pulled models) and automatically routes to the most appropriate model group via the `CATEGORY_TO_GROUP` table — `scout`, `operational`, `simple`, or `tactical` (`strategic` is not a classification target; `planning` is — design/planning prompts route to the top-tier-only planning group, never to the free-tank tactical tier). This enables **context-aware model selection** without manual intervention.

**Requirements for Dynamic Routing:**

To use the **`dynamic`** group, you need:
- **Ollama** installed and running locally (`ollama serve`) with at least one chat model pulled — optional when the cloud classifier chain is enabled
- No classifier model is shipped or required by name: after each scan the router **derives** the local chain from the models Ollama reports (completion-capable, no embedding-only models, no model that answers a classification with HTTP 501 "structured output is unavailable"), orders them by parameter size (small = fast), and **probes** them with the same classification cases the cloud fallback uses. The verified list is the chain (`/router` shows the heads; "none yet" until a scan ran). Pin your own with `classifier_model` / `classifier_fallback` in the `dynamic` group of `router-config.user.json` (e.g. `"ollama/<model>:<tag>"`).
- Ollama accessible from your system (default: `http://localhost:11434`)

Cloud-first (2026-09-27): with `classifier_cloud_fallback: true` (set on the
shipped `dynamic` group) the classifier tries a chain of free cloud models
FIRST — pinned `classifier_cloud_model` → scan-time probe-verified list →
tiered discovery → configured free models — and treats Ollama as the last
resort (see [Data handling & privacy](#data-handling--privacy)). If every
cloud candidate fails and Ollama is unavailable, the classifier falls back
to static keyword-based classification (only if `allowStaticFallback` is
enabled) — otherwise the category `fallback` is returned.

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

A group may also set `min_context_length` to require a minimum model context
window (in tokens). Models whose scanned context window is unknown or below
the threshold are dropped — strict, like `min_gdpval`. This lets a
use-case-specific group (e.g. `bulk_reader`) guarantee its cheap models can
actually hold the large inputs the use case demands, instead of falling back
to the smallest free model that would truncate.

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

1. **Resolves nothing credential-related itself (ADR-0022).** The router never reads or writes Pi's credential store — Pi resolves API keys (auth.json incl. `!` secret-manager commands, models.json, env, CLI OAuth) via `modelRegistry.getApiKeyForProvider` whenever a router-internal path needs one (free-model registration, free-cloud fallback). If a key lives in a `pass` store or a shell command, reference it from Pi's own auth.json and Pi executes it.
2. **Scans local models** (Ollama / LM Studio) and OpenRouter's public pricing catalog; cloud model inventory comes from Pi's catalog (ADR-0021 — the router registers no scan-discovered cloud models)
3. **Scrapes GDPval scores** from [Artificial Analysis](https://artificialanalysis.ai/evaluations/gdpval-aa) with hardcoded fallbacks — a plain, unauthenticated GET of a public leaderboard page; no local data is sent
4. **Caches pricing** per provider/model from OpenRouter's public pricing endpoint

All scanning is async and non-blocking.

### Data handling & privacy

- **The router never reads or writes Pi's credential store (ADR-0022).** No API key, key reference, or auth-file pointer is stored in `router-config.json` or resolved by the router — Pi owns credential resolution end-to-end. (Legacy `keys` arrays in older router-config files are ignored, never read.)
- **Prompt content stays local by default.** The dynamic-group content classifier runs against a local Ollama model. If both local classifier models are unavailable, it falls back to static keyword matching (only if `allowStaticFallback` is enabled) rather than sending anything externally.
- **Optional cloud classifier fallback (`classifier_cloud_fallback`, off by default).** If explicitly enabled in `router-config.json`, and only as a last resort when local classification fails, the raw prompt is sent to a free cloud model from your own configured `free_models` for classification purposes. This is opt-in and separate from using that same provider as a normal answering fallback, because classification and answering have different data-exposure implications for the same free-model config. Enable only if you're comfortable with that provider seeing prompt content for classification, not just for answering your requests.
- **GDPval scraping and pricing/model scans are outbound-only, read-only HTTP GETs** to public model/leaderboard endpoints; no prompt content, API keys, or other local data is included in those requests.

---

### Group Selection

Each group auto-discovers available models, filters by quality, and selects
by billing preference. The shipped groups (see `router-config.json`):

| Group | Method | Quality gate | Ranks within the pool by | Use for |
|-------|--------|--------------|--------------------------|---------|
| **strategic** | `best` | GDPval ≥ 700 | GDPval (quality window) | Critical decisions |
| **planning** | `best` | GDPval ≥ 1700 | AA-Briefcase Elo (`score_by`) | Design & architecture — top tier only |
| **tactical** | `best` | 600 ≤ GDPval ≤ 1700 | SciCode/Terminal-Bench blend (`score_by`) | Daily coding — the free-tank tier |
| **operational** | `tiered` | GDPval ≥ 300 | billing preference | Everyday tasks |
| **scout** | `tiered` | GDPval ≥ 0 | billing preference | Exploration, cheap work |
| **fallback** | `tiered` | GDPval ≥ 0 | billing preference | Last resort |
| **dynamic** | `dynamic` | — | — | Auto-classifies each prompt and routes to the best group |

No curated model lists. Groups draw from all discovered models automatically.
Quality gates (`min_gdpval`/`max_gdpval`) always use GDPval — a `score_by`
column only orders the models **within** an admitted pool.

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

This means `operational` picks the cheapest model that clears its GDPval floor, while `strategic` ranks by `best` (highest score, quality window applied) regardless of cost.

#### costMux

After 4 consecutive HTTP 429s from a provider, the router applies a permanent **cost multiplier penalty** (`costMux`) to all its models. This pushes the provider to the back of the sorted list without blocking it entirely — useful when a provider is temporarily overloaded but still reachable. The penalty persists for the session and is reset on `/router reload`.

---

### Rate Limits & Failover

On HTTP 429 the router works through two escalating responses:

1. **Model backoff** — the model enters exponential backoff (1 min → 2 → 4 → ... → 90 min cap) and the group falls over to its next-ranked candidate for the current request. (ADR-0022 removed multi-key rotation — with keys owned and resolved by Pi there is exactly one key per provider.)
2. **costMux penalty** — after 4 consecutive 429s, the provider receives a permanent cost multiplier for the session (see [costMux](#costmux) above), demoting all its models in future selections.

Both mechanisms are transparent to the user — the session continues with the next available model.

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

---

### Delegating subtasks to cheap groups (Pi subagents)

The router only resolves a group name to the best available model *for a single completion request* — it has no concept of "split this task into subtasks and run the cheap ones on a cheap model." That kind of decomposition belongs one layer up, in [Pi's subagent system](https://github.com/earendil-works/pi-subagents), which can already address any configured group directly by model ref: every group is registered as its own provider, so `<group>/<group>` (e.g. `trivial/trivial`, `scout/scout`, `strategic/strategic`) is a valid `model` value for `subagent(...)` calls, exactly like any other provider/model pair Pi knows about.

This lets you fan out I/O-heavy work (reading/summarizing several files) to a cheap group in parallel, then run one expensive-group call over the collected results — without any router code changes:

```js
subagent({
  workflowScript: `
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const summaries = await runs.all(files.map((f) => ({
      key: f,
      agent: "scout",
      model: "trivial/trivial",
      task: "Summarize the public API of " + f,
    })));
    const combined = summaries.map((s) => s.output).join("\\n\\n");
    return runs.run("synthesize", {
      agent: "worker",
      model: "strategic/strategic",
      task: "Given these file summaries, propose a refactor:\\n\\n" + combined,
    });
  `,
});
```

The `bulk_reader` group adds a `min_context_length` floor so the cheap model
it resolves to is guaranteed to hold several files at once — exactly the
property a trivial/scout group does *not* guarantee:

```js
subagent({
  workflowScript: `
    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
    const summaries = await runs.all(files.map((f) => ({
      key: f,
      agent: "scout",
      model: "bulk_reader/bulk_reader",
      task: "Read " + f + " and return a bullet list of its public API.",
    })));
    return runs.run("synthesize", {
      agent: "worker",
      model: "strategic/strategic",
      task: "Given these file summaries, propose a refactor:\\n\\n" +
        summaries.map((s) => s.output).join("\\n\\n"),
    });
  `,
});
```

`code_writer/code_writer` is the symmetric counterpart: a cheap group with
enough context for a spec + one reference file, used to generate boilerplate
the expensive model never has to read back as output tokens.

See [docs/adr/0007-task-decomposition-and-delegation.md](docs/adr/0007-task-decomposition-and-delegation.md) for why this lives in the subagent layer rather than in the router.

## Configuration

### Main Configuration File

`router-config.json` ships group definitions and tuning only. Concrete model and provider
choices (`providers.*`, `free_models`, `exclude.models`, `model_metrics`) are **user-layer** keys:
put them in `router-config.user.json` (see [docs/config-override.md](docs/config-override.md)) — the
router derives candidates, free-tier models and subscription cost ordering from what Pi has registered.

```jsonc
{
  "model_groups": {
    "strategic": { "method": "best" },
    "tactical": { "method": "tiered", "min_gdpval_pct": 75 },
    "scout": { "method": "tiered", "min_gdpval_pct": 25 }
  },
  "gdpval_builtin": {
    "mistral-medium-3-5": 933,
    "claude-sonnet-5": 1603,
    "qwen3-8-27b": 580
  }
}
```

#### Declaring billing, free models and exclusions (`router-config.user.json`)

Provider billing is declared per provider in your **user** config (it is not shipped). Providers the
router knows (e.g. Mistral, Ollama) have a built-in default; declare it for everything else, for example
a subscription bridge or a pay-per-token aggregator:

```jsonc
{
  "providers": {
    "claude-bridge": { "billing": "subscription" },
    "openrouter": {
      "billing": "pay_per_token",
      // optional: pin extra free-tier refs. Free-tier models of credentialed
      // providers are derived from the scan without this list.
      "free_models": ["openrouter/vendor/some-model:free"]
    }
  },
  "exclude": { "models": ["openrouter/vendor/never-use-this:free"] }
}
```

- `billing`: `"subscription"` | `"pay_per_token"`. A subscription model's routing cost is
  `ε × OpenRouter list price` (constant fallback when unlisted), so subscription models sort ahead of
  pay-per-token peers and cheaper tiers sort ahead of pricier ones — no per-model `model_metrics` needed.
- `free_models` and `exclude.models` are user-layer keys: arrays under `exclude` are unioned across layers,
  `free_models` still requires a credentialed provider. Models that fail permanently (403 agentic-harness
  gate, 404 guardrail) are blocked automatically after the first failure (`/router blocklist`), so no
  shipped exclusion list is needed.

#### Pinning the classifier, and what no longer ships

The shipped config names no model that can admit, select, rank or exclude one (ADR-0025; guard:
`test/no-hardcoded-models.test.ts`, baseline closed at 0). Everything that used to be a shipped
default is either derived or a **user-layer** choice in `router-config.user.json`:

| You want | Put in your user layer |
|---|---|
| A specific local classifier (instead of the derived/probed chain) | `"model_groups": { "dynamic": { "classifier_model": "ollama/<model>:<tag>", "classifier_fallback": "ollama/<model>:<tag>" } }` |
| A specific cloud classifier tried first | `"model_groups": { "dynamic": { "classifier_cloud_model": "<provider>/<model>" } }` |
| Provider billing / free-tier pins / exclusions | the `providers` / `exclude` block above |
| Families kept out of routing groups (poor agents) | `"non_agent_model_prefixes": ["<family>-"]` (see below) |

#### Billing Preference (per-group tier override)

By default, `method: "tiered"` sorts by billing tier first: **free → subscription → local → payg**. This means already-paid subscription models (e.g. Mistral) always rank ahead of local compute (Ollama), even in scout where local models conceptually belong on top.

`billing_preference` re-ranks a group by billing tier after its `method` has ordered the candidates. It does not change which models passed the filters — only their order. Five values:

| Value | Ordering | Use for |
|-------|----------|---------|
| `"default"` (or omitted) | free → subscription → local → payg | Groups where an already-paid subscription model is the cheaper choice in time/quota terms. |
| `"cloud_first"` | cloud (free → subscription) ahead of local | Groups that should prefer cloud models — the local daemon is a fallback, not the default (scout / bulk_reader / code_writer). |
| `"local_first"` | free → local → subscription → payg | Groups where local models should rank ahead of subscription, but genuinely-free remote models still win. |
| `"local_before_payg"` | free → subscription → local → payg | Cheap groups (trivial / simple): free and subscription first, local ahead of pay-as-you-go only. |
| `"strict_local"` | local → free → subscription → payg | Groups where the local daemon should answer **first**, ahead of even the $0 remote models. Not used by the shipped config (a guard test forbids it there). |

`payg` is always last. This is opt-in per group — other groups keep the default ordering. The shipped config pins: `trivial`/`simple` → `local_before_payg`, `scout`/`bulk_reader`/`code_writer` → `cloud_first`.

```json
"scout": {
  "method": "tiered",
  "billing_preference": "cloud_first",
  "min_gdpval": 0
},
"trivial": {
  "method": "tiered",
  "billing_preference": "local_before_payg",
  "min_gdpval": 0
}
```

> **A subscription model's $0 cost is not free.** Flat-rate plans like pi-claude hide a hard time/token limit, so a trivial prompt routed there is the single most expensive thing the router can do. Prefer a local model or a genuine `:free` model for cheap work.

#### Agent-capability filter (`non_agent_model_prefixes`)

Models whose ref has a path segment starting with one of these prefixes are
excluded from all routing groups (they remain selectable as plain chat
models). GDPval scores capability, not agent-reliability: families that
benchmark well but serve garbage on main-agent work (stopping after
announcing a result, 0–220-char tool turns) can otherwise win a routing slot.

**Nothing ships in the default config** (ADR-0025). Whether a model is
reliable as an agent is a quality judgement, not a capability flag: Pi's model
type carries no tool-calling field, and the model families this filter was
written for advertise function calling — they just do it badly — so there is
nothing to derive the list from, and the router cannot learn it from errors
(their streams finish normally). If you have models like that, list them in
**your** layer, `router-config.user.json`:

```json
"non_agent_model_prefixes": ["acme-small-", "acme-audio-"]
```

Arrays replace the shipped value in any layer, so set the full list you want.
Absent or empty (the default) turns the filter off. The classifier chain never
passes through this filter, so small models still classify.

> Upgrading from a pre-1.7.0 version? The CHANGELOG's combined migration
> snippet carries the concrete prefix list this filter used to ship with
> (mistral-small-, magistral-small-, ministral-, voxtral-, codestral-).

#### Read Delegation (bulk reads)

Delegation has two halves. A large `read`/`bash` result is **replaced** by a summary produced by a cheap `bulk_reader` group, and a full-file `read` is **blocked before it runs** and redirected to a targeted `offset`/`limit` read. Both are off by default.

```json
"delegation": {
  "enabled": true,
  "group": "bulk_reader",
  "tools": ["read", "bash"],
  "min_chars": 3500,
  "max_raw_chars": 60000,
  "block_lines": 350,
  "expensive_groups": ["strategic", "tactical"],
  "expensive_providers": []
}
```

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `false` | Master switch. Anything other than `true` is off (fail-open). |
| `group` | `"bulk_reader"` | Model group that produces the summary. Must be registered as a group so the router intercepts it. |
| `tools` | `["read", "bash"]` | Result-bearing tools to delegate. Trusted **as a whole**: a non-array, or any non-string/empty entry, discards the entire list and uses the default. |
| `min_chars` | `3500` | Minimum result size before delegating. Below this, delegation latency exceeds the savings. |
| `max_raw_chars` | `60000` | Cap on result text sent to the sub-call. |
| `block_lines` | `350` | Pre-call block for full-file reads. `0` **disables** pre-call blocking explicitly; negative or non-numeric falls back to the default. |
| `expensive_groups` | `["strategic", "tactical"]` | Groups whose models may not do full-file reads. Matched against the **active** config's materialized model lists. |
| `expensive_providers` | `[]` | Provider **prefixes** whose models count as expensive regardless of group — e.g. `["pi-claude"]` matches `pi-claude/claude-sonnet-5`. |

Targeted reads (any `read` with `offset` or `limit`) and piped/grep'd `bash` commands are **always** delegated around — they are precise extracts the orchestrator needs verbatim, and the pre-call block never fires for them.

Group and provider lists are trusted as a whole, like `tools`: a partially-valid list would silently block or delegate the wrong models, so an invalid list falls back to the default and an empty list (`[]`) genuinely disables the check. A config whose `model_groups` have no materialized `models` arrays (static-only) matches nothing on `expensive_groups` — the size threshold still protects on its own.

The expensive-model pre-call block judges the caller by the **driving** model of the turn — the first model that streamed — not by whatever model streamed most recently. A nested `bulk_reader` sub-call mid-turn does not un-block the expensive model's subsequent reads.

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
| **`billing_preference`** | Per-group tier ordering override (`"local_first"` / `"strict_local"` rank local models ahead of subscription) | `"local_first"` |
| **`modelFilter`** (PROVIDER_MAP) | Regex to constrain scanned model ids per provider | `"^(zai-)?glm"` |

Groups need no `models` arrays — everything is auto-discovered **plus** any explicitly listed models.

### Adding a Provider

The router has **no credential storage of its own** (ADR-0022): API keys live
exclusively with Pi, and Pi resolves them whenever a request needs one. Adding
a provider is therefore a single step — give the key to Pi:

1. **Store the key where Pi looks for it** — any one of:
   - `pi auth <provider>` (Pi's built-in auth)
   - an environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …)
   - an entry in Pi's `auth.json` — including a `!`-prefixed secret-manager
     command (e.g. `!pass show api/openrouter`); Pi executes it
   - CLI OAuth for CLI-auth providers (`qwen auth login`, `gemini auth login`)
2. **Restart pi** — the router picks up everything Pi knows, scans local
   daemons and cloud catalogs, and the provider's models start competing in
   your groups automatically.

For a non-standard base URL or model list, configure the provider in Pi's
`models.json` — the router never overwrites an existing Pi registration
(see [Provider Configuration](#provider-configuration) below).

There is a guided walkthrough in the shipped skill: `/skill:router-login`
(same steps, with connectivity checks and troubleshooting).

### Supported Providers

**26 known providers** (the router's `PROVIDER_MAP`, below) — plus any
extension-registered provider (e.g. claude-bridge), which the router
discovers automatically.

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
| **chutes** | Router | Router | Free tier models available |
| **mistral-zai** | Router | Router | Mistral via Z.AI |
| **groq** | Router | Router | Fast inference, free tier |
| **cerebras** | Router | Router | Fast inference |
| **xai** | Router | Router | xAI (Grok) |
| **zai** | Router | Router | Z.AI |
| **huggingface** | Router | Router | - |
| **kimi-coding** | Router | Router | - |
| **minimax** | Router | Router | - |
| **minimax-cn** | Router | Router | - |
| **opencode** | Router | Router | - |
| **opencode-go** | Router | Router | - |
| **vercel-ai-gateway** | Router | Router | - |
| **azure-openai** | Router | Router | - |
| **deepseek** | Router | Router | - |
| **github-copilot** | Router | Router | Subscription |

**Claude-bridge Support:**
- **Important:** Claude-bridge is a **separate Pi extension** that must be installed to use Claude models with a subscription.
- **How it works:** The extension registers `claude-bridge/*` models with Pi. The router **discovers and uses** them automatically.
- **Model availability** depends on your Claude subscription plan (Pro, Max, etc.).
- **No double registration:** The router **does not** register claude-bridge providers itself — it only uses models already registered by the extension.

## Commands

| Command | Description |
|---------|-------------|
| `/router` | Overview: providers, groups, selections, rate limits |
| `/router <group>` | Detailed view of a group with ranked candidates |
| `/router scan` | Re-scan models and GDPval scores |
| `/router cost` | Audit-depth cost report: per-model, per-window usage from the router's own token accounting |
| `/router errors [n]` | Last n session errors (default 15, max 50) with status-line correlation |
| `/router cooldowns [clear]` | Active rate-limit cooldowns (ref, remaining, hits); `clear` also resets model-health streaks |
| `/router blocklist` | Models blocked after a permanent provider failure (reason, since, re-probe time) |
| `/router blocklist clear [ref]` | Unblock one model, or all (e.g. after fixing an API key) |
| `/router reload` | Hot-reload config and cache |
| `/router config` | Show config sources, exclude rules with origin and match counts, compaction state |
| `/router config exclude <ref|glob>` | Exclude a model/pattern from routing (saved to user layer, live without restart) |
| `/router config unexclude <ref|glob>` | Remove a user-layer exclusion (shipped/project entries cannot be removed this way) |
| `/router config compaction on|off` | Cache-aware auto-compaction flag (opt-in, default off) |

### Logging

The router logs to `~/.pi/logs/router.log` (mirrored to `<project>/.pi/logs/router.log`).
Each file rotates at 20 MB into `router.log.1` … `router.log.4`; older data is dropped.

Log levels, from quiet to verbose: `"error"` (hard failures only) → `"warn"`
(adds operational problems: rate limits, failed models, fallbacks, wedges) →
`"info"` (adds routine narration and the per-prompt routing trace) → `"debug"`
(adds `[diag]` lines). Set `"log_level"` in `~/.pi/agent/router-config.user.json`,
or via `ROUTER_LOG_LEVEL` (overrides the config). The shipped default is `"warn"`
(release builds must not be verbose); local dev typically sets `"info"` or
`"debug"`. The recurring "tryStream skipped" line is written once per model
until its reason changes.

### KPI audit

`npm run audit:kpi -- [--since 7d|24h|<ISO date>] [--log <path>] [--json]` summarizes
`~/.pi/logs/router.log`: delegation savings and failures, blocked full-file reads,
failed hops by reason and model, total failovers, learned blocklist entries,
watchdog wedge events and classifier health.

## Tools

| Tool | Purpose |
|------|---------|
| `set_model_from_group` | Switch session to best model from a group |
| `resolve_model_group` | Preview what a group would resolve to |
| `update_model_metrics` | Manual metric override |
| `bulk_read` | Answer a question about files via a cheap reader model, without loading their content into the session context |

The `dynamic` group has no dedicated tools — classification runs automatically
inside the group's resolve path (`src/content-classifier.ts`).

## Footer

```
strategic/anthropic/claude-opus-4-6 | int:1450 tps:80 | 12k/8k $1.43 62% | ⏱14m | ⌂ proj | ⎇ main | ⛔2 | ⚠1 err
```

The `⚠N err` part counts the session's recorded stream failures — the same
entries `/router errors` lists in full.

After the token/cost part the footer shows the prompt-cache state of the
last step, e.g. `ctx 182.0k · cache 97% · ~$0.03/step`: the context the model
read, the share served from the provider cache, and the session-average
billed cost per step (omitted for subscription/free models). `/router cost`
adds the session cache-read share and a `Cache30d` column per model.


## Internals

How the code is organized — relevant if you work on the router itself,
not needed to use it.

The router uses a **modular architecture** with the following components:

| Module | Purpose | Key Features |
|--------|---------|--------------|
| **providers.ts** | Provider definitions and mappings | 26 supported providers, authentication patterns |
| **types.ts** | Type definitions | Config, Cache, Metrics, RateLimit, Group, Provider types |
| **utils.ts** | Utility functions | String manipulation, reference parsing |
| **rate-limit.ts** | Rate limit management | Backoff cooldowns, cost multiplier |
| **discovery.ts** | Discovery management | Free-model inventory (ADR-0022: key discovery removed — Pi owns credential resolution) |
| **metrics.ts** | Metrics management | GDPval, throughput, latency tracking |
| **cache.ts** | Cache management | Persistent caching, versioning |
| **routing.ts** | Routing logic | Model selection, filtering, sorting |
| **stream-orchestrator.ts** | Stream orchestration | `groupStream`/`driveStream` extraction from index.ts, `buildOrchestratorContext` factory with live getters for router/rateLimitManager/cacheManager |
| **detection.ts** | Error event detection | Rate-limit/abort/overflow text patterns, `isRateLimitLikeReason()`, `isAbortLikeText()`, `parseResetAtMs()` |
| **content-classifier.ts** | Content classification | derived local Ollama chain (classifier-local-probe.ts), cloud fallback via pi's `modelRegistry.completeSimple()` (see ADR 0004) |
| **escalation.ts** | Session escalation | Loop detection, level tracking, session-safe reset |
| **model-matcher.ts** | LLM-assisted model matching | Batched matching, plausibility guard, hallucination rejection |
| **local-llm.ts** | Provider-agnostic LLM caller | Ollama OR LM Studio, OpenRouter free cloud fallback |
| **exclude.ts** | Personalized exclude rules | Provider/pattern/paid-model filtering for all groups |
| **config-loader.ts** | Layered configuration | Deep-merge defaults → global → project-local overrides |

**index.ts wiring (2026-10 refactor):** index.ts is now a thin extension entry point
(~640 lines, down from ~3750): it owns the shared mutable state (the one `cache`
object, `cfg`, managers), `load()`/`loadCache()`, and
`buildOrchestratorContext()`. All behavior lives in `createX(deps)` factory
modules that receive **live getters** (plus setters for write access) so
reload-time swaps are always seen — never stale closure captures:

| Factory module | Owns |
|----------------|------|
| **context-utils.ts** | context estimation, timeouts, compaction detection |
| **limit-glue.ts** | metrics/rate-limit/cost glue functions |
| **model-resolve-glue.ts** | `resolve`, `detectGroup`, `fmtModel`, `getTopModels` |
| **scan-runner.ts** | `scan()` incl. GDPval scrape + LLM matching |
| **dynamic-config-runner.ts** | `generateDynamicConfigNow` |
| **free-model-registration.ts** | `registerFreeModelOnDemand` |
| **stream-proxy.ts** | `groupStream`, `tryStream`, `consumeWithDetection`, local-stream limiter |
| **group-registration.ts** | `registerGroupProviders` (Ü1 guard), `registerGroupModels` (merge-not-replace) |
| **event-handlers.ts** | the core `pi.on(...)` handlers |
| **tools.ts** | the four `pi.registerTool` registrations |
| **commands.ts** | the `/router` command |

The final `session_shutdown` handler and process-exit/signal cleanup stay at the
bottom of index.ts (handler order is load-bearing). The router never calls
`pi.setModel()` except in the `set_model_from_group` tool.

This modular design enables better maintainability, testing, and extensibility.


### GDPval model matching pipeline

When a model needs a GDPval score, the router resolves it in three tiers:

1. **model-map.yaml** (authoritative) — explicit model-id → slug mapping
2. **Token-set fallback** (deterministic) — fuzzy token matching
3. **LLM-assisted matching** (semantic) — a local LLM matches model ids to
   GDPval slugs, with cross-family and size-tier guards

See [`docs/architecture.md`](docs/architecture.md) for details.

## Development

```bash
npm install          # also wires the pre-push secret scan (core.hooksPath)
npm test             # vitest
npx tsc --noEmit     # type check
npm run secret-scan -- --range origin/main..HEAD   # manual range scan
```

`main` is protected: changes land through pull requests with the `test`
and `secret-scan` checks green. The pre-push hook scans every pushed commit
for credentials (gitleaks, `brew install gitleaks`) and for private
references (`scripts/forbidden-patterns.ts`), because in a public
repository a push is already a publication. See `AGENTS.md` §8.

## License

MIT
