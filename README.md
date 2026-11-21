# pi-model-dynamic-router

> Pi extension that routes model group names to concrete provider/model pairs. Auto-discovers models and pricing. Balances intelligence (GDPval), cost, and availability.

> **Origin:** this project started in 2026 as a fork of [`a-canary/pi-model-router`](https://github.com/a-canary/pi-model-router) and has since been rewritten almost completely: content-based routing, failover, the Laya classifier and the test suite are new work. A small part of the original (about 0.5 % of today's lines, in 21 files) remains and keeps its copyright notice, see [`docs/upstream-attribution.md`](docs/upstream-attribution.md).

## What You Get

- **Content-aware routing** — every prompt is classified (from a short
  follow-up to an architecture review) and routed to a matching model tier: free
  models for daily coding, top-tier models reserved for design and planning work.
- **Automatic discovery & pricing** — the router scans local daemons (Ollama,
  LM Studio) and cloud catalogs, and scrapes Artificial Analysis benchmark
  scores (GDPval plus per-task capability columns: an Intelligence Index /
  Omniscience / HLE Diamond blend for planning, AA-Briefcase Elo for design,
  SciCode/Terminal-Bench for coding).
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
3. Select `router/dynamic` ("Router (dynamic)") with `/model` — the router
   classifies every prompt and serves it from the matching group (`simple`,
   `standard`, `code_complex`, `design`, `planning`). To stay on one group,
   pin it with the `set_model_from_group` tool.

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
  /router config exclude <ref|glob|provider>  exclude a model/pattern/provider from routing
  /router config unexclude <ref|glob|provider>  remove a user-layer exclusion
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

### Classifier Decision Log

Every classification writes one JSONL record to `~/.pi/logs/classifier-decisions.jsonl`: the stage (hint / compaction / momentum / cache / laya / llm-local / llm-cloud / static / fallback; the non-routing records `pool`, `comparator`, `observation` and `observation-comparator` are skipped by every reader that counts decisions), the full candidate chain with per-attempt outcome and machine-classified failure reason, the raw vs the final category (with the post-processing steps between them), the routed group, and timing — the input for "how good is the classifier" and for offline known-vs-candidate comparisons (`scripts/classifier-replay.ts`, ADR-0027). `/router classifier [days]` summarises the same file and its rotated copies (stage mix, `continue` before and after inheritance, chain exhaustions, chain failures, latency, top Laya disagreements). The log is fail-open (an unwritable location never changes routing) and the file is created with mode 0600.

**Correcting a category.** `HINT: category <name> <your prompt>` applies the named category to that turn and saves the correction for the exact prompt text that follows (at least five words; shorter prompts are never saved). The same prompt later, without the HINT, gets the saved category with no classifier call. `/router corrections` lists the saved corrections, `/router corrections clear` drops them all. An unknown name is ignored with a warning that lists the valid names. Design: `docs/adr/0030-feedback-correction-sequencing.md`.

A turn that is compacted is never answered from a saved correction. An unknown name is reported (in the log and as a notice) and the content is classified without the HINT head — with no content behind the head, the turn falls back to `continue` without any classifier call, so the marker never reaches the classifier. A saved name that is no longer a category is reported once and dropped.

Privacy: a correction is stored under the **raw prompt text** as its exact-match key, so the router's scan cache file (`<state-dir>/.cache/scan-cache.json`, next to `router-config.dynamic.json` in the extension dir unless `PI_ROUTER_STATE_DIR` is set) contains what the user typed. The store is capped at 64 entries (least recently used dropped first), it is listed and cleared with `/router corrections`, and the cache file is written owner-only (mode 0600), like the classifier decision log.

```jsonc
{
  "classifier": {
    "log": {
      "enabled": true,        // shipped default; absent block = off
      "store_text": "none",   // "none" | "snippet" (prompt prefix) | "full" (prompt + context, replay mode)
      "max_bytes": 20971520,  // rotation size, default 20 MiB
      "keep": 3               // files kept including the live one
    }
  }
}
```

`store_text` is the privacy gate: `"none"` (shipped) stores lengths and a 12-hex sha prefix only — the model's reasons count as prompt-derived text and are nulled too; `"full"` additionally stores the prompt and both context texts, which is what `scripts/classifier-replay.ts` needs to replay a corpus against a candidate classifier endpoint (`POST /classify {prompt} → {category, confidence?}`).

### Category-to-Group Mapping

The built-in `CATEGORY_TO_GROUP` mapping routes each classification category to a model group (e.g., `design` → `design`, `continue` → `standard`). Users can override individual mappings via the `category_groups` config key:

```json
{
  "category_groups": {
    "code_complex": "planning"
  }
}
```

Unknown categories or target groups are rejected with a warning at load time and ignored; the rest of the mapping still applies.

When the classifier answers `continue` (a short continuation or confirmation, not a self-contained task), the classification inherits the previous turn's category (same momentum mechanism as the short-prompt path), so a conversation keeps its routing context; without history `continue` goes to the `standard` group — a decent model, not a free one.

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
  "context_budget": {
    "enabled": true,
    "soft_tokens": 150000,
    "hard_tokens": 400000,
    "cache_ttl_s": 300,
    "fresh_session": { "enabled": true }
  }
}
```

The thresholds are the 5b compaction gates; `fresh_session` is independent of them
(see the bullet below) — a user can switch on the suggestion alone.

**Pi's `cacheWarming` setting is honored** (pi 1.6.0+). Pi decides when to warm — your
mode (`off` / `streaming` / `idle`, Pi's default), its idle limit and its savings threshold;
the router only makes a group model look like the model behind it: after a served request
the group model declares that model's prompt-cache lifetime and price, and Pi's warm
request (a one-token replay) goes verbatim to the model that served the session's last
request — no routing, no fallback, nothing logged as a turn. No warm goes to a model that
is rate-limited or behind an open breaker, or after a failed request. To stop router
sessions from warming, set `"cacheWarming": "streaming"` or `"off"` in Pi's settings.
Warm costs show in `/router cost` (`Cache warms (Pi)`, outside the session total) and in
the footer's session totals; a recent warm counts as a step for the cold-cache signal
below, so a cache Pi kept warm is not compacted and does not trigger the fresh-session
suggestion. Limits: the declaration follows the previous request (Pi reads the session
model's economics when a request starts), so a session's first request is never warmed
and a turn that switches models warms with the previous model's lifetime and price; two
in-process sessions of one group share the group model's declaration. See
[docs/plans/2026-11-20-honor-pi-cache-warming.md](docs/plans/2026-11-20-honor-pi-cache-warming.md).

Evaluated at every **turn boundary** (never between tool steps): context over `hard_tokens` compacts regardless of cache state; context over `soft_tokens` compacts only when the cache is cold — a miss on the last step (cacheRead below half the step's tokens; partial hits count as mostly-reprocessed), an idle gap over `cache_ttl_s`, or no step recorded yet (fresh/resumed session). A warm cache is never thrown away. Per-group overrides live on `model_groups.<g>.context_budget` and win per field over the global block.

Heuristic caveat (honest disclosure): the "last step" is the last entry of the shared persistent `usage_log` — with concurrent sessions, or right after resuming one, the signal can come from another session, in which case the trigger can misfire in the wasteful direction (compacting a warm cache costs one full-price step — the same cost the feature already accepts on a genuinely cold start) or the conservative direction (a cheap compaction opportunity is missed). Never a wrong exclusion; opt-in only.

- **Hints** (default): with `enabled` false or absent but thresholds configured, the same conditions only produce a hint — "compacting now would pay off: /compact" (at most one per 30 minutes).
- **Automatic**: `enabled: true` additionally calls Pi's compaction at the boundary instead of hinting.
- `/router config compaction on|off` toggles the master switch live (persisted to `router-config.user.json`; the thresholds remain hand-edited config).
- **Fresh-session suggestion** (step 5c, `context_budget.fresh_session.enabled`, off by default): when the cache went cold on a large context or compaction is not sticking (it already ran twice this session and the context grew back), the hint names the better move — "fresh session suggested — /router fresh". `/router fresh [next step]` then does the handover, always user-invoked: confirm → compact (the summary) → a new session seeded with the handoff as its first prompt; the parent link is recorded by Pi.

## How It Works

For the full runtime decision tree (classification → category → group →
gates → ranking → failure handling) as a Mermaid diagram, see
[`docs/routing-flow.md`](docs/routing-flow.md).

### Dynamic Routing

The **dynamic routing** feature automatically classifies user prompts and selects the optimal model group based on the task type. It uses a classifier chain (a local Ollama chain derived from the models you have pulled, tried first; with `classifier.cloud.enabled: true`, as shipped, a cloud chain follows as the fallback) and routes by the `CATEGORY_TO_GROUP` table in `src/content-classifier.ts`. Since 2.0 every category selects the group named like it: `simple` and `code_simple` → `simple`, `standard` and `continue` → `standard`, `code_complex` → `code_complex`, `design` → `design`, `planning` → `planning`.

#### Categories for Classification

The system classifies prompts into the following categories (see `CATEGORY_TO_GROUP` in `src/content-classifier.ts` for the authoritative mapping):

- `simple`: Simple requests with clear, short answers
- `code_simple`: Small code changes (1-10 lines, syntax fixes, renames, typos)
- `standard`: Standard requests (general questions, moderate complexity)
- `code_complex`: Substantial changes (refactoring, debugging, new features, >50 lines); analyzing or reviewing existing code
- `design`: Architecture, system design, API design, weighing options
- `planning`: Task breakdown, roadmaps, prioritization, project planning
- `continue`: Not a self-contained task — a short continuation or confirmation

#### Mapping of Categories to Model Groups

Each category maps to a model group (`CATEGORY_TO_GROUP`, `src/content-classifier.ts`). Two tier-routing mechanisms (ADR-0023) keep the tiers meaningful despite GDPval compression at the top of the score range: a per-group **`max_gdpval`** cap (the shipped `code_complex` is capped at 1700, so the flat-fee Mistral tank — glm-5-3 at 1644 — carries the daily `code_complex` load, while Claude's top models stay in `design` and `planning`), and a **`best_quality_window`** (default 5%): inside a `best`-method group, candidates within the window of the best score are treated as equally good — cheapest first, cost ties to the lower score (in `planning`, claude-sonnet-5-5 beats claude-opus-5-5 at equal subscription cost). On Mistral-quota days, `code_complex` escalates through its `fallback_groups` into `planning`, so Claude takes over automatically. A group can additionally rank its pool task-type-aware via **`score_by`** (ADR-0023 round 2): the same Artificial Analysis scrape that yields GDPval also carries the per-benchmark columns, so `design` and `planning` rank by AA-Briefcase Elo and `code_complex` by the SciCode/Terminal-Bench coding blend — floors and caps stay on GDPval, and a missing column falls back to GDPval ordering.

| Category | Model Group | Use Case |
|----------|-------------|----------|
| `simple` | simple | Short real tasks — free or subscription models, cheap |
| `code_simple` | simple | Small coding tasks (free models only) |
| `standard` | standard | Everyday tasks (GDPval ≥ 300) |
| `continue` | standard | Continuation without a predecessor — a decent model, not a free one |
| `code_complex` | code_complex | Complex coding tasks (1630 ≤ GDPval ≤ 1700 — the free-tank tier) |
| `design` | design | Design decisions — upper band (GDPval ≥ 1600), best first |
| `planning` | planning | Project planning and architecture — the reasoning tier (reasoning ≥ 35, no GDPval floor) |

#### Dynamic Group

The **`dynamic`** group is a special group that classifies each prompt in real-time (local Ollama chain first, cloud chain as the fallback: primary/fallback derived from your pulled models) and automatically routes to the most appropriate model group via the `CATEGORY_TO_GROUP` table — `simple`, `standard`, `code_complex`, `design`, or `planning`. Design and planning prompts never route to the `code_complex` group. This enables **context-aware model selection** without manual intervention.

**Requirements for Dynamic Routing:**

To use the **`dynamic`** group, you need:
- **Ollama** installed and running locally (`ollama serve`) with at least one chat model pulled — optional when the cloud classifier chain is enabled
- No classifier model is shipped or required by name: after each scan the router **derives** the local chain from the models Ollama reports (completion-capable, no embedding-only models, no model that answers a classification with HTTP 501 "structured output is unavailable"), orders them by parameter size (small = fast), and **probes** them with the same classification cases the cloud chain uses. The verified list is the chain (`/router` shows the heads; "none yet" until a scan ran). Pin your own with `classifier.local.model` / `classifier.local.fallback` in the `classifier` block of `router-config.user.json` (e.g. `"ollama/<model>:<tag>"`).
- Ollama accessible from your system (default: `http://localhost:11434`)

Local first (ADR 0032, 2026-11-14): with `classifier.cloud.enabled: true` (set in the shipped `classifier` block) the classifier runs the local Ollama chain first, and a usable local answer is final. Only when the local leg produces no answer (or, with the opt-in `classifier.cloud.escalate_low_confidence` on, a low-confidence one) does the cloud chain run, trying in order: pinned `classifier.cloud.model` → the scan-time probe-verified list → lazy discovery over Pi's model registry (output price at most $5 per million tokens, or a $0 catalog placeholder; at most 20 candidates) → the static `free_models` list (see [Data handling & privacy](#data-handling--privacy)). If every candidate fails, the classification falls back to the `continue` category (routed to `standard`).

#### Local Laya classifier stage (experimental)

An opt-in **local stage** can answer the category from a small multilingual
encoder model (Laya, 322M parameters, Apache-2.0 base) instead of the chain:
every Laya answer with a valid category takes the route, and the chain
answers when Laya fails. It is **experimental** and **disabled by default** — see
`docs/config-override.md#integrationslaya--experimental-local-classifier-stage` for every config key.

- **Platforms:** the sidecar ships inside this package (`dist/laya-sidecar.js`);
  only its native ONNX runtime is a separate download,
  `pi-laya-model runtime install` (about 115 MB, pinned and integrity-checked,
  no install scripts). Start it with `pi-laya-model serve router@1.0.0`.
  Apple Silicon is the tested platform; Linux and Windows should work and are
  **not tested**; Intel Macs are not supported and the runtime install says so
  before downloading anything. `laya-sidecar/README.md` has the platform table.
  The sidecar exposes `POST /classify` and reports what it serves on
  `GET /health`, which the decision log and the `/router` overview use. The
  router only talks HTTP to loopback (`127.0.0.0/8`, `localhost`, `::1` —
  enforced at config load) and never downloads weights or starts a process.
- **Bring-your-own weights**: a pinned `checkpoint` is required when enabled.
  Publishing a fine-tuned router checkpoint is planned separately
  (`docs/plans/2026-10-31-laya-sidecar-distribution.md`).
- `mode: "active"` is what the installer writes (ADR-0035): an installed Laya
  leads the classifier chain, and the chain runs when Laya is unavailable or
  its answer is vetoed. `mode: "shadow"` logs Laya's answer without affecting
  the route (ADR-0027 decision log); it is the code default when a hand-written
  block has no `mode`. There is no confidence gate by default
  (`confidence_threshold: 0`, ADR-0036): every Laya answer with a valid
  category decides. Set a value between 0 and 1 to send less confident
  answers to the local and cloud chain instead.

---

### Cascading Fallback & Intelligent Routing

The router implements a **multi-layer fallback system** that automatically recovers from model failures, rate limits, and unavailability.

#### How it works

When a model fails (API error, rate limit, empty response, or usage limit exceeded), the router:

1. **Tries the next model in the same group**
2. **If all models in the group fail → cascades to fallback groups** in this order:
   ```
   planning → design → code_complex → standard → simple
   ```
   (the global order; every shipped group also carries its own `fallback_groups` chain, which wins over it)
3. **Continues until a working model is found**

**Example:** A request is classified into a group, but the first model hits a rate limit → router automatically tries the next `dynamic` model → if all fail, tries the group's fallback chain (e.g. `standard` → `simple`).

#### Configuration

Each group can define its fallback chain in `router-config.json`:

```json
{
  "planning": {
    "description": "Best models by GDPval",
    "method": "best",
    "models": ["anthropic/claude-3-sonnet", "mistral/mistral-medium-3.5"],
    "fallback_groups": ["code_complex", "standard", "simple"]
  }
}
```

**Note:** The `dynamic` group automatically inherits the full cascade chain.

---

### Group-Based Cost/Quality Routing

The router encodes cost-quality tradeoffs directly in **model groups** rather than a
separate tier overlay. Each group's `min_gdpval` and `max_cost` settings act as the
cost tier: `simple` uses `max_cost: 0` (free models only, `min_gdpval: 0`),
`standard` clears a floor of 300 within `max_cost: 2.0`, `code_complex`,
`design` raises the GDPval floor to 1600, and `planning` has no GDPval floor at all: it is gated by the reasoning column (≥ 35). A classified prompt maps to a group via `CATEGORY_TO_GROUP`
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
simple/dynamic→claude-bridge/claude-fable-5  # ← Failed, but shown!

# After (correct):
simple/dynamic→mistral/mistral-medium-3.5   # ← Actually active model
```

This provides **accurate feedback** about which model is currently generating responses.

---

### Auto-Discovery

On startup, the router automatically:

1. **Resolves nothing credential-related itself (ADR-0022).** The router never reads or writes Pi's credential store — Pi resolves API keys (auth.json incl. `!` secret-manager commands, models.json, env, CLI OAuth) via `modelRegistry.getApiKeyForProvider` whenever a router-internal path needs one (free-model registration, the free-cloud chain). If a key lives in a `pass` store or a shell command, reference it from Pi's own auth.json and Pi executes it.
2. **Scans local models** (Ollama / LM Studio) and OpenRouter's public pricing catalog; cloud model inventory comes from Pi's catalog (ADR-0021 — the router registers no scan-discovered cloud models)
3. **Scrapes GDPval scores** from [Artificial Analysis](https://artificialanalysis.ai/evaluations/gdpval-aa) with hardcoded fallbacks — a plain, unauthenticated GET of a public leaderboard page; no local data is sent
4. **Caches pricing** per provider/model from OpenRouter's public pricing endpoint

All scanning is async and non-blocking.

### Data handling & privacy

- **The router never reads or writes Pi's credential store (ADR-0022).** No API key, key reference, or auth-file pointer is stored in `router-config.json` or resolved by the router — Pi owns credential resolution end-to-end. (Legacy `keys` arrays in older router-config files are ignored, never read.)
- **Prompt text leaves the machine only when the local chain gives no answer** — or, with the opt-in `classifier.cloud.escalate_low_confidence` on, a low-confidence one (see below). The shipped `classifier` block sets `classifier.cloud.enabled: true`, so a prompt goes to a cloud model from Pi's model registry only after the local Ollama chain produced no answer (or, with escalation on, one below confidence 0.5). The cloud candidates are the pinned `classifier.cloud.model` if set, else the scan-time probe-verified list, else lazy discovery (output price at most $5 per million tokens, or a $0 catalog placeholder; at most 20 candidates), else the static `free_models` list. Models of excluded providers, `paid_models_from` providers, and models that are currently unhealthy or blocklisted are skipped. Cloud candidates are not limited to free models: the price ceiling decides eligibility.
- **Keeping prompts on the machine.** Run `/router config set classifier.cloud.enabled off`, or set `"classifier": { "cloud": { "enabled": false } }` in `router-config.user.json` (the user layer overrides the shipped value). `classifier.cloud.enabled` is an on/off switch for the cloud fallback leg; it does not set the order, which is always local first. With it off, the classifier uses only the local Ollama chain; when no hop answers, the request gets the `continue` category. The opt-in local Laya stage (`integrations.laya`) runs before either chain and talks only to a loopback sidecar.
- **Choosing the cloud classifier models yourself.** Set `classifier.cloud.candidates` to a list of `provider/id` refs, with `/router config set` or as `"classifier": { "cloud": { "candidates": ["provider/id", …] } }` in `router-config.user.json`. The list replaces the automatic cloud candidates (probe-verified list, lazy discovery, static `free_models`) and is tried in the given order. `classifier.cloud.model`, if also set, still goes first. Exclude rules and the paid guards still apply, and the list is used only when `classifier.cloud.enabled` is on. The shipped config sets no list.
- **Escalating low-confidence local replies (opt-in, off by default).** Set `classifier.cloud.escalate_low_confidence` to `true`, with `/router config set` or in `router-config.user.json`. A local reply below confidence 0.5 is then sent once to the cloud chain (which needs `classifier.cloud.enabled` on); a cloud answer replaces it, and if the cloud produces nothing, the local reply is kept. Off by default, so prompt text is not sent to a cloud model for low-confidence local answers. See ADR 0033.
- **Saved HINT corrections stay local, as raw prompt text.** `HINT: category <name> <prompt>` stores the prompt text (at least five words) as an exact-match key in the scan cache file, which is written owner-only (mode 0600). The store is capped at 64 entries and is never sent anywhere; `/router corrections clear` removes them (see "Correcting a category" above).
- **GDPval scraping and pricing/model scans are outbound-only, read-only HTTP GETs** to public model/leaderboard endpoints; no prompt content, API keys, or other local data is included in those requests.

---

### Group Selection

**One selectable model: `router/dynamic`.** The router registers a single Pi
virtual model, `router/dynamic`. Each request it routes goes to a group's
hidden model (`<group>/<group>`), which walks that group's candidates. The
group models are not listed in `/model` or in scoped models
(`enabledModels`). Because the selection is a virtual model, Pi keeps it
across replies, `--continue`, `/resume`, `/fork` and `/tree`.

**Pinning a group.** `set_model_from_group` with a group name pins that group
for the session: `router/dynamic` serves every request from it, and the
session's model stays `router/dynamic`. `none` (or `dynamic`) releases the
pin. The pin, the previous turn's category, the tool follow-up run and the
group the last request was routed to are stored on the session branch, so a
fork or `/tree` jump sees its own values and a restart keeps them. That group
(after a failed walk, the `fallback_groups` entry that took over) also selects the
per-group `context_budget`.

**Older sessions and `--model`.** `--model <group>/<group>` and a settings
default naming a group still resolve. An interactive session on a group model
moves to `router/dynamic` at start, with that group pinned (`dynamic/dynamic`
moves unpinned). So does a pre-2.0.0 session whose branch selected a group.
Headless sessions (print mode, pi-subagents children) keep the group model.

Each group auto-discovers available models, filters by quality, and selects
by billing preference. The shipped groups (see `router-config.json`):

| Group | Method | Quality gate | Ranks within the pool by | Use for |
|-------|--------|--------------|--------------------------|---------|
| **planning** | `best` | reasoning ≥ 35 (`min_score`, `require_score_column`); no GDPval floor | Intelligence Index, Omniscience and HLE Diamond, equal thirds (`score_by: reasoning`) | Planning & architecture — the reasoning tier |
| **design** | `best` | GDPval ≥ 1600 | AA-Briefcase Elo (`score_by`) | Design decisions — the upper band |
| **code_complex** | `best` | 1630 ≤ GDPval ≤ 1700 | SciCode/Terminal-Bench blend (`score_by`) | Daily coding — the free-tank tier |
| **standard** | `tiered` | GDPval ≥ 300 | billing preference | Everyday tasks |
| **simple** | `tiered` | GDPval ≥ 0 | billing preference | Short real tasks, cheap work, last resort |
| **dynamic** | `dynamic` | — | — | Auto-classifies each prompt and routes to the best group |

No curated model lists. Groups draw from all discovered models automatically.
Quality gates (`min_gdpval`/`max_gdpval`) always use GDPval — a `score_by`
column only orders the models **within** an admitted pool. A model without a
value in the column ranks after every model that has one. `planning` goes one
step further (`require_score_column`): a model that is not measured on the
reasoning column does not belong in the planning tier and is left out, and
`min_score: 35` adds a floor on that column (GDPval alone admitted a fast
"Flash" model whose reasoning blend ranks it near last). Both rules stand down
while no model has a value at all (before the first scrape), so a fresh
install never ends up with an empty planning group.

#### GDPval

GDPval is a composite quality score from [Artificial Analysis](https://artificialanalysis.ai/evaluations/gdpval-aa) that combines intelligence, throughput, and cost-efficiency into a single number. Higher = better overall value. The router scrapes scores **once** on first run and caches them; subsequent startups use the cache. Use `/router scan` to force a refresh. Hardcoded fallbacks from `gdpval_builtin` in the config are always loaded as a baseline.

#### Price Routing — how `tiered` works

1. **Filter** — discard any model whose GDPval score is below the group's threshold: `min_gdpval` (absolute) or `min_gdpval_pct` (percent of the best GDPval score in the candidate pool).
2. **Sort** — rank survivors by billing tier first, then by effective cost within each tier:
   - Tier 0: free models
   - Tier 1: subscription (lowest rate-limit pressure first, then cost)
   - Tier 2: local (Ollama / LM Studio)
   - Tier 3: pay-per-token (ascending effective cost)
3. **Select** — pick the top-ranked model (cheapest within the preferred billing tier that clears the quality floor).

This means `standard` picks the cheapest model that clears its GDPval floor, while `planning` ranks by `best` (highest score, quality window applied) regardless of cost.

#### costMux

After 4 consecutive HTTP 429s from a provider (`cost_mux_at_hit`, default 4), the router raises that provider's **cost multiplier** (`costMux`) by one. The multiplier pushes the provider toward the back of the sorted list without blocking it entirely. It is raised at most once per calendar day per provider, and only while the failing model is still listed. The value is kept in the scan cache, so it survives restarts; nothing resets it automatically.

---

### Rate Limits & Failover

On HTTP 429 the router works through two escalating responses:

1. **Model backoff** — the model enters exponential backoff (1 min → 2 → 4 → ... → 90 min cap) and the group falls over to its next-ranked candidate for the current request. (ADR-0022 removed multi-key rotation — with keys owned and resolved by Pi there is exactly one key per provider.)
2. **costMux penalty** — after 4 consecutive 429s, the provider's cost multiplier is raised by one, at most once per day (see [costMux](#costmux) above), demoting all its models in future selections.

Both mechanisms are transparent to the user — the session continues with the next available model.

#### Provider Circuit Breaker

All of the above is per **model**. When a whole **provider** wedges — several *different* models of the same provider failing the same way in a short window (empty responses, timeouts, connection errors; live evidence: a bridge that answered every request with empty responses for six days) — the breaker opens for that provider ([ADR-0026](docs/adr/0026-provider-circuit-breaker.md)):

- **Trip:** 3 distinct cloud models (2 for local ones) fail with provider-level evidence within 10 minutes, with no success in between. Per-model request/shape errors (400/404/422) and rate limits (a parsed reset time) never trip it.
- **Skip:** while open, the provider's candidates are skipped — including the rest of the very candidate walk that discovered the wedge. One narration line states the provider, the evidence and a fix hint.
- **Never a dead end:** if *every* remaining candidate sits behind an open breaker, the walk force-probes the soonest-expiring breaker's best candidate instead of failing.
- **Close:** any success of the provider, the cooldown ladder expiring (2 → 5 → 15 min per repeated trip), `/router cooldowns clear`, or a session restart (breaker state is volatile on purpose — a restart is the usual fix, and it must never leave a stale skip behind).
- **Visibility:** `/router` shows every open breaker with its remaining skip time plus persisted trip/avoided-hop counters per provider.
- **Kill switch:** `"provider_breaker": { "enabled": false }` in the user config disarms the cloud breaker (local providers keep the ADR-0016 watchdog). Thresholds are tunable too (`min_models`, `window_s`, `cooldown_s`).

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
4. **Check your provider's usage page** if you consistently hit limits

**Example configuration for reliability:**

```json
{
  "planning": {
    "models": [
      "claude-bridge/claude-opus-5",    // First choice (Max only)
      "claude-bridge/claude-sonnet-5",  // Fallback (Pro/Max)
      "anthropic/claude-3-5-sonnet",    // Cloud chain
      "mistral/mistral-medium-3.5"     // Final fallback
    ],
    "fallback_groups": ["code_complex", "standard", "simple"]
  }
}
```

This ensures **automatic recovery** when subscription limits are hit.

---

### Stream Retry

When a streaming response fails mid-stream (empty body, connection drop, timeout), the group automatically retries with the next ranked candidate without requiring the user to resend the prompt. Soft failures are distinguished from hard errors: 4xx client errors (other than 429/402) are not rate-limit-shaped, so they start no cooldown and count as no provider-breaker evidence; an interrupted stream or empty response is retried.

---

### Delegating subtasks to cheap groups (Pi subagents)

The router only resolves a group name to the best available model *for a single completion request* — it has no concept of "split this task into subtasks and run the cheap ones on a cheap model." That kind of decomposition belongs one layer up, in [Pi's subagent system](https://github.com/earendil-works/pi-subagents), which can already address any configured group directly by model ref: every group is registered as its own provider, so `<group>/<group>` (e.g. `simple/simple`, `standard/standard`, `planning/planning`) is a valid `model` value for `subagent(...)` calls. The group models are hidden from `/model`, but Pi still resolves them by ref, and a headless subagent child stays on the group it was given.

This lets you fan out I/O-heavy work (reading/summarizing several files) to a cheap group in parallel, then run one expensive-group call over the collected results — without any router code changes:

```js
subagent({
  workflowScript: `
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const summaries = await runs.all(files.map((f) => ({
      key: f,
      agent: "scout",
      model: "simple/simple",
      task: "Summarize the public API of " + f,
    })));
    const combined = summaries.map((s) => s.output).join("\\n\\n");
    return runs.run("synthesize", {
      agent: "worker",
      model: "planning/planning",
      task: "Given these file summaries, propose a refactor:\\n\\n" + combined,
    });
  `,
});
```

The `bulk_reader` group adds a `min_context_length` floor so the cheap model
it resolves to is guaranteed to hold several files at once — exactly the
property the `simple` group does *not* guarantee:

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
      model: "planning/planning",
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

`router-config.json` ships group definitions and tuning. The keys `providers`, `exclude` and `model_metrics` are present but empty. Concrete model and provider
choices (`providers.*`, `free_models`, `exclude.models`, `model_metrics`) are **user-layer** keys:
put them in `router-config.user.json` (see [docs/config-override.md](docs/config-override.md)) — the
router derives candidates, free-tier models and subscription cost ordering from what Pi has registered.

```jsonc
{
  "model_groups": {
    "planning": { "method": "best" },
    "code_complex": { "method": "tiered", "min_gdpval_pct": 75 },
    "simple": { "method": "tiered", "min_gdpval_pct": 25 }
  },
  "gdpval_builtin": {
    "mistral-medium-3-5": 933,
    "claude-sonnet-5": 1603
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
  `free_models` still requires a credentialed provider. Models whose error text matches a permanent signature (such as the agentic-harness gate or the workspace guardrail) are blocked automatically after the first failure (`/router blocklist`), so no
  shipped exclusion list is needed.

#### Pinning the classifier, and what no longer ships

The shipped config names no model that can admit, select, rank or exclude one (ADR-0025; guard:
`test/no-hardcoded-models.test.ts`, baseline closed at 0). Everything that used to be a shipped
default is either derived or a **user-layer** choice in `router-config.user.json`:

| You want | Put in your user layer |
|---|---|
| A specific local classifier (instead of the derived/probed chain) | `"classifier": { "local": { "model": "ollama/<model>:<tag>", "fallback": "ollama/<model>:<tag>" } }` |
| A specific cloud classifier (first in the cloud chain, which runs after the local chain) | `"classifier": { "cloud": { "model": "<provider>/<model>" } }` |
| Provider billing / free-tier pins / exclusions | the `providers` / `exclude` block above |
| Families kept out of routing groups (poor agents) | `"non_agent_model_prefixes": ["<family>-"]` (see below) |

Every classifier and integration key, its shipped value and how to change it is listed in [docs/config-reference.md](docs/config-reference.md) (generated from the key table).

#### Billing Preference (per-group tier override)

By default, `method: "tiered"` sorts by billing tier first: **free → subscription → local → payg**. This means already-paid subscription models always rank ahead of local compute (Ollama), even in `simple` where local models conceptually belong on top — set `billing_preference: "local_before_payg"` (the shipped `simple` setting) to put local ahead of pay-per-token.

`billing_preference` re-ranks a group by billing tier after its `method` has ordered the candidates. It does not change which models passed the filters — only their order. Five values:

| Value | Ordering | Use for |
|-------|----------|---------|
| `"default"` (or omitted) | free → subscription → local → payg | Groups where an already-paid subscription model is the cheaper choice in time/quota terms. |
| `"cloud_first"` | cloud (free → subscription) ahead of local | Groups that should prefer cloud models — the local daemon is a fallback, not the default (bulk_reader / code_writer). |
| `"local_first"` | free → local → subscription → payg | Groups where local models should rank ahead of subscription, but genuinely-free remote models still win. |
| `"local_before_payg"` | free → subscription → local → payg | Cheap group (simple): free and subscription first, local ahead of pay-as-you-go only. |
| `"strict_local"` | local → free → subscription → payg | Groups where the local daemon should answer **first**, ahead of even the $0 remote models. Not used by the shipped config (a guard test forbids it there). |

`payg` is last in every mode except `cloud_first`, where local models come after it. This is opt-in per group — other groups keep the default ordering. The shipped config pins: `simple` → `local_before_payg`, `bulk_reader`/`code_writer` → `cloud_first`.

```json
"bulk_reader": {
  "method": "tiered",
  "billing_preference": "cloud_first",
  "min_context_length": 64000
},
"simple": {
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

> Upgrading from a pre-2.0.0 version (any 1.x release)? The CHANGELOG's combined migration
> snippet carries the concrete prefix list this filter used to ship with
> (mistral-small-, magistral-small-, ministral-, voxtral-, codestral-).

#### Read Delegation (bulk reads)

Delegation has two halves. A large `read`/`bash` result is **replaced** by a summary produced by a cheap `bulk_reader` group, and a full-file `read` is **blocked before it runs** and redirected to a targeted `offset`/`limit` read. The code default is off (`enabled: false`), but the shipped `router-config.json` sets `delegation.enabled: true`, so both halves are active unless your user layer turns delegation off.

```json
"delegation": {
  "enabled": true,
  "group": "bulk_reader",
  "tools": ["read", "bash"],
  "min_chars": 3500,
  "max_raw_chars": 60000,
  "block_lines": 350,
  "expensive_groups": ["planning", "code_complex"],
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
| `expensive_groups` | `["planning", "code_complex"]` | Groups whose models may not do full-file reads. Matched against the **active** config's materialized model lists. |
| `expensive_providers` | `[]` | Provider **prefixes** whose models count as expensive regardless of group — e.g. `["pi-claude"]` matches `pi-claude/claude-sonnet-5`. |

Targeted reads (any `read` with `offset` or `limit`) and piped/grep'd `bash` commands are **always** delegated around — they are precise extracts the orchestrator needs verbatim, and the pre-call block never fires for them.

Group and provider lists are trusted as a whole, like `tools`: a partially-valid list would silently block or delegate the wrong models, so an invalid list falls back to the default and an empty list (`[]`) genuinely disables the check. A config whose `model_groups` have no materialized `models` arrays (static-only) matches nothing on `expensive_groups` — the size threshold still protects on its own.

The expensive-model pre-call block judges the caller by the **driving** model of the turn — the first model that streamed — not by whatever model streamed most recently. A nested `bulk_reader` sub-call mid-turn does not un-block the expensive model's subsequent reads.

#### Provider Configuration

**Provider registration is conservative (never overwrites):** the router only registers a provider with Pi when Pi does **not** know it yet — i.e. when `modelRegistry.find(provider, modelId)` returns nothing for every model of that provider. This protects `models.json` entries (with `compat` flags), extension-provided providers, and Pi-native providers from being clobbered. If Pi already knows the provider from any source, the router does not touch the registration.

**Capabilities:** the router registers a provider with Pi only when Pi does not know it. Local Ollama models are registered with the capabilities read from Ollama's `/api/show`; on-demand `free_models` are registered with id and name only. Capabilities from cloud catalogues (Mistral `capabilities.*`, OpenRouter `architecture.input_modalities`) are kept in the scan cache for ranking, not written into a registration.

**Ollama is setup-independent:** the router scrapes Ollama's `/api/show` per model to get the real context length (`model_info.*.context_length`) and capabilities, and registers Ollama with `providerOptions.num_ctx` set to that real value — so prompts >32K don't get truncated. This works for **every** user, with or without any specific Ollama extension. The router only registers Ollama when Pi doesn't know it; if another extension or `models.json` already registered Ollama, the router doesn't overwrite.

#### New Configuration Options

| Option | Purpose | Example |
|--------|---------|---------|
| **`fallback_groups`** | Define cascade chain for fallback | `["code_complex", "standard", "simple"]` |
| **`cost_per_m`** | Cost per million tokens (for estimates) | `0.0000015` |
| **`model_metrics`** | Per-model cost overrides | `{ "claude-bridge/claude-sonnet-5": { "cost_per_m": 0.0000015 } }` |
| **`gdpval_builtin`** | GDPval overrides for new models (keyed by **slug**) | `{ "mistral-medium-3-5": 933 }` |
| **`billing_preference`** | Per-group tier ordering override (`"local_first"` / `"strict_local"` rank local models ahead of subscription) | `"local_first"` |

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
| `/router classifier [days]` | Classifier summary from the decision log (stage mix, outcomes, failure reasons); `days` 1–90, default 7 |
| `/router scan` | Re-scan models and GDPval scores |
| `/router cost` | Audit-depth cost report: per-model, per-window usage from the router's own token accounting |
| `/router errors [n]` | Last n session errors (default 15, max 50) with status-line correlation |
| `/router cooldowns [clear]` | Active rate-limit cooldowns (ref, remaining, hits); `clear` also resets model-health streaks |
| `/router blocklist` | Models blocked after a permanent provider failure (reason, since, re-probe time) |
| `/router blocklist clear [ref]` | Unblock one model, or all (e.g. after fixing an API key) |
| `/router corrections [list|clear]` | Saved `HINT: category` corrections: list them with the exact prompt text each matches, or clear all (ADR-0030) |
| `/router config` | In TUI mode, opens a guided menu that changes classifier settings one key at a time. Print and RPC mode have no dialogs, so they print the overview (as `config show`) plus a note saying why and naming `config set`/`config unset` |
| `/router config show` | Config overview in every run mode: sources, classifier chain, integrations, exclude rules with origin and match counts, compaction state |
| `/router config set <path> <value>` | Write one classifier setting to the user layer; the path and value are checked against the key table (see [docs/config-reference.md](docs/config-reference.md)) and the change applies now |
| `/router config unset <path>` | Remove one classifier setting from the user layer, so the shipped or code default applies again |
| `/router config classifier` | Classifier settings in effect, how each is changed, and the chain they produce |
| `/router config integrations` | Integration settings in effect and the command that switches each |
| `/router config exclude <ref|glob|provider>` | Exclude a model/pattern from routing (saved to user layer, live without restart). A bare provider name (`openrouter`) excludes the whole provider via `exclude.providers`; an unknown bare name is rejected because it could never match a model ref |
| `/router config unexclude <ref|glob|provider>` | Remove a user-layer exclusion (shipped/project entries cannot be removed this way) |
| `/router config integration <name> on|off|<mode>` | Enable or disable an optional integration (currently `laya`, see [Local Laya classifier stage](#local-laya-classifier-stage-experimental)) or set its mode |
| `/router config compaction on|off` | Cache-aware auto-compaction flag (opt-in, default off) |

The bare `/router` overview ends with this command list. An unknown subcommand (for example `/router rescan`) is reported with a suggestion instead of showing the overview.

### Logging

The router logs to `~/.pi/logs/router.log` (mirrored to `<project>/.pi/logs/router.log`).
Each file rotates at 20 MB into `router.log.1` … `router.log.4`; older data is dropped.

Log levels, from quiet to verbose: `"error"` (hard failures only) → `"warn"`
(adds operational problems: rate limits, failed models, fallbacks, wedges) →
`"info"` (adds routine narration and the per-prompt routing trace) → `"debug"`
(adds `[diag]` lines). Set `"log_level"` in `~/.pi/agent/router-config.user.json`,
or via `ROUTER_LOG_LEVEL` (overrides the config). The shipped default is `"warn"`
(release builds must not be verbose); local dev typically sets `"info"` or
`"debug"`. The recurring "tryStream skipped" line (debug level, `[diag]`) is written once per model
until its reason changes.

### KPI audit

`npm run audit:kpi -- [--since 7d|24h|<ISO date>] [--log <path>] [--json]` summarizes
`~/.pi/logs/router.log`: delegation savings and failures, blocked full-file reads,
failed hops by reason and model, total failovers, learned blocklist entries,
watchdog wedge events and classifier health.

## Tools

| Tool | Purpose |
|------|---------|
| `set_model_from_group` | Pin a group for the session (`router/dynamic` only); `none` releases the pin |
| `resolve_model_group` | Preview what a group would resolve to |
| `update_model_metrics` | Manual metric override |
| `bulk_read` | Answer a question about files via a cheap reader model, without loading their content into the session context |

The `dynamic` group has no dedicated tools — classification runs automatically
inside the group's resolve path (`src/content-classifier.ts`).

## Footer

```
planning/anthropic/claude-opus-4-6 | int:1450 tps:80 | 12k/8k $1.43 62% | ⏱14m | ⌂ proj | ⎇ main | ⛔2 | ⚠1 err
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
| **content-classifier.ts** | Content classification | derived local Ollama chain (classifier-local-probe.ts), cloud chain via pi's `modelRegistry.completeSimple()` (see ADR 0004) |
| **escalation.ts** | Session escalation | Loop detection, level tracking, session-safe reset |
| **model-matcher.ts** | LLM-assisted model matching | Batched matching, plausibility guard, hallucination rejection |
| **local-llm.ts** | Provider-agnostic LLM caller | Ollama OR LM Studio, OpenRouter free cloud chain |
| **exclude.ts** | Personalized exclude rules | Provider/pattern/paid-model filtering for all groups |
| **config-loader.ts** | Layered configuration | Deep-merge defaults → global → project-local overrides |

**index.ts wiring (2026-10 refactor):** index.ts is now a thin extension entry point
(~1200 lines, down from ~3750): it owns the shared mutable state (the one `cache`
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
`pi.setModel()` except once at `session_start`, to move a session on a group
model to `router/dynamic` (`test/no-router-setmodel-static.test.ts`).

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

The router code is MIT, see [`LICENSE`](LICENSE). Copyright is Achim Nierbeck's, except for the files that still contain code of the original `pi-model-router`: those keep the original author's notice (a-canary) next to it. The list and how it was measured: [`docs/upstream-attribution.md`](docs/upstream-attribution.md).

The Laya `router` model weights are a separate work under the Apache License 2.0, derived from the Apache-2.0 model `convaiinnovations/laya-multilingual`. Every installed model directory carries its own `LICENSE` and `NOTICE` (sources in [`laya-models/`](laya-models/)).
