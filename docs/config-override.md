# Router Configuration Override

The router ships with sensible defaults in `router-config.json` (bundled with
the extension). You can **personalize** the configuration without editing
extension files — your overrides survive extension updates.

## How it works

The router deep-merges config from three layers (later layers win):

1. **Embedded defaults** — `router-config.json` (ships with the extension)
2. **Global user override** — `~/.pi/agent/router-config.user.json`
3. **Project-local override** — `<project>/.pi/router-config.json`

Each override file is a **partial config** (a "patch"): it only needs to contain
the keys you want to change. Nested objects are merged key-by-key; arrays are
replaced entirely — except the `exclude.*` lists, which accumulate across layers
(see Merge semantics).

## Quick start

Create `~/.pi/agent/router-config.user.json`:

```json
{
  "exclude": {
    "paid_models_from": ["openrouter"],
    "models": ["*fable*"]
  }
}
```

This excludes all paid OpenRouter models (keeping the `:free` tier) and any
model matching `*fable*` (which costs extra), across all projects.

For a per-project override, create `<project>/.pi/router-config.json`:

```json
{
  "exclude": {
    "models": ["*fable*", "claude-bridge/claude-opus-5"]
  }
}
```

## What you can override

### `exclude` — Personalized support/no-support list

Applied to **all groups** before per-group filtering.

| Field | Type | Effect |
|---|---|---|
| `providers` | `string[]` | Exclude entire providers (e.g. `["openrouter"]` drops all `openrouter/*`). Supports globs. |
| `models` | `string[]` | Exclude model refs by glob pattern (e.g. `["*fable*", "openrouter/*"]`). Case-insensitive. |
| `paid_models_from` | `string[]` | Exclude paid models from a provider, **keeping its `:free` tier** (e.g. `["openrouter"]`). |

Example: no paid OpenRouter models, no Fable, no Chutes:

```json
{
  "exclude": {
    "providers": ["chutes"],
    "paid_models_from": ["openrouter"],
    "models": ["*fable*"]
  }
}
```

### `providers` — Free models and API keys

```json
{
  "providers": {
    "openrouter": {
      "free_models": [
        "openrouter/qwen/qwen3-4b:free",
        "openrouter/openai/gpt-4o-mini:free"
      ]
    }
  }
}
```

### `model_groups` — Group thresholds

Override a group's `min_gdpval` or `fallback_groups`:

```json
{
  "model_groups": {
    "planning": { "min_gdpval": 1500 }
  }
}
```

### `gdpval_builtin` — Manual GDPval scores

Add or override benchmark scores for models not in the scraped table:

```json
{
  "gdpval_builtin": {
    "glm-5-2": 1506
  }
}
```

### `integrations.laya` — Experimental local classifier stage

> **Renamed in 2.0.** This block was the top-level `classifier_laya` before.
> There is no read alias: a user or project layer that still has
> `classifier_laya` is warned about once per file and the old block is
> ignored (Laya then stays off). Move the values under `integrations.laya`.
> Top-level keys the router does not know (typos such as `classifer_log`) are
> warned about too, with the closest known key; the layer is still merged.
>
> Switch it from Pi without editing the file: `/router config integration laya on`,
> `… laya off`, or `… laya shadow` (a mode implies on). `/router` lists
> every integration with its state.

An opt-in stage that classifies with a **local Laya sidecar** (Apple
Silicon / MLX) instead of the cloud chain. Disabled by default and
experimental — start in `"shadow"` mode, which only logs.

```json
{
  "integrations": {
    "laya": {
      "enabled": true,
      "checkpoint": "<model>@<version>",
      "mode": "shadow",
      "endpoint": "http://127.0.0.1:8089",
      "confidence_threshold": 0.8,
      "timeout_ms": 1500,
      "compare_in_background": false,
      "observe_momentum": false
    }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turn the stage on (requires `checkpoint`) |
| `checkpoint` | — | What you expect the sidecar to serve, e.g. `router@1.0.0` or `<hf-repo>@<revision>`. Required when enabled. A sidecar that reports its identity on `GET /health` is logged by what it reports (`laya:<model>@<version>`, decision-log `identity: "reported"`); `checkpoint` is the label only when it does not (`identity: "configured"`). `/router status` warns when a `<model>@<version>` here disagrees with the reported one, or when the sidecar serves a different head than the router builds. The router never downloads weights |
| `mode` | `"shadow"` | `"shadow"` logs without routing; `"active"` lets a confident answer take the route |
| `confidence_threshold` | `0.8` | Minimum confidence to use the answer, `0`–`1`. The scale is uncalibrated, so the default keeps a gate; `0` switches the gate off (Laya's answer is used whatever its confidence — the cloud chain then only runs on failure or as the background comparator) |
| `endpoint` | `http://127.0.0.1:8089` | Sidecar base URL: `POST /classify`, optional `GET /health` (identity) |
| `timeout_ms` | `1500` | Hand the prompt to the chain after this long. One timeout only affects that prompt; 3 in a row switch the stage off for 5 minutes. The sidecar's latency varies with GPU load, so leave headroom above the p90 of `laya.ms` in the decision log |
| `compare_in_background` | `false` | In active mode, still run the replaced chain detached and log it as a comparator record (ADR-0027) |
| `observe_momentum` | `false` | Log detached answers for short momentum prompts (can incur classifier spend) |

## Reference: remaining keys

Every top-level key of the config and every group key that the sections above
do not cover. Defaults are the code defaults unless the shipped
`router-config.json` says otherwise.

### Top-level keys

| Key | Default | Meaning |
|-----|---------|---------|
| `log_level` | `warn` (shipped) | `error`, `warn`, `info` or `debug`. `ROUTER_LOG_LEVEL` overrides it. |
| `classifier_log` | `store_text: "none"` (shipped) | Classifier decision log, one JSONL record per classification in `~/.pi/logs/classifier-decisions.jsonl`. `store_text`: `none` (hashes and lengths only), `snippet` (first 120 characters of the prompt) or `full` (prompt and context text, for offline replay; the file is mode 0600). Absent = off. |
| `best_quality_window` | `0.05` (shipped) | Fraction of the best score within which candidates count as equally good for the `best` method; the cheapest of them is picked first. `0` = pure score order. |
| `category_groups` | none | `{ "<category>": "<group>" }` overrides of the built-in category-to-group mapping. Unknown categories or groups are rejected with a warning. |
| `backoff_minutes` | `[1, 2, 4, 8, 16, 32, 64, 90]` | Rate-limit backoff in minutes, escalating per hit. |
| `soft_backoff_ms` | `[30000, 60000, 120000, 300000]` | Backoff in milliseconds for empty responses and stalls. |
| `empty_response_timeout_ms` | `30000` | First-token timeout for ordinary models. |
| `reasoning_empty_response_timeout_ms` | `90000` | First-token timeout for reasoning models. |
| `stall_timeout_ms` | `180000` | Inactivity timeout mid-stream, after the first token. |
| `rate_limit_wait_max_ms` | `120000` | Longest wait for a rate-limited model whose reset time is near. `0` disables waiting. |
| `ollama_max_concurrent_streams` | `1` | Simultaneous streams to one local model server (Ollama, LM Studio). |
| `scan_settle_ms` | `60000` | Milliseconds after start before a scan counts as settled. Only a settled scan may confirm a smaller result that the scan-sanity check refused. |
| `provider_breaker` | code defaults | Cloud provider circuit breaker. `enabled` (`false` is the kill switch for cloud providers; the local watchdog stays on), `min_models` (`{ "cloud": 3, "local": 2 }`, distinct models with evidence needed to trip), `window_s` (`600`), `cooldown_s` (`[120, 300, 900]`). |
| `delegation` | off in code | Enforced delegation: oversized `read` and `bash` results go to a cheap summarizer group before the main model sees them. Fields: `enabled`, `min_chars` (`3500`), `group` (`bulk_reader`), `max_raw_chars` (`60000`), `tools` (`["read", "bash"]`), `block_lines` (`350`; `0` disables the pre-call block), `expensive_groups` (`["planning", "code_complex"]`), `expensive_providers` (none). The shipped config turns it on. |
| `context_budget` | off | Cache-aware compaction, global. Fields: `enabled` (`false`; compacts automatically at turn boundaries), `soft_tokens` (compacts above this when the cache is cold), `hard_tokens` (compacts above this regardless of cache state), `cache_ttl_s` (an idle gap longer than this counts as cold). A group's `context_budget` overrides field by field. Compaction never runs mid-turn. |
| `non_agent_model_prefixes` | none ships | Model-id families that must never do main-agent work, matched against any path segment of the id. Set it in the user layer; a layer replaces the whole array. |
| `model_metrics` | `{}` | Per-model metrics (`gdpval`, `throughput_tps`, `avg_latency_ms`) as written by the `update_model_metrics` tool; display and ranking fall back to them. |
| `integrations` | none | Optional components, one block each. See `integrations.laya` above. |

### Group keys

| Key | Meaning |
|-----|---------|
| `description` | Text shown by `/router <group>`. |
| `method` | Ranking method: `best`, `min_cost`, `min_cost_if_all_priced`, `min_latency`, `max_throughput`, `max_gdpval`, `tiered`, `roundrobin`, `billing_preference`, `dynamic` (the classifier group) or `pipeline`. |
| `pipeline` | With `method: "pipeline"`: ordered steps `{ "method": …, "top_k": … }`, each applied to the output of the step before. |
| `top_k` | Keep only the first N candidates after the method. |
| `min_gdpval_pct` | Quality floor as a percentage of the best GDPval in the pool. |
| `max_gdpval` | Quality ceiling: models with a higher GDPval are excluded. Unscored models fail a positive cap. |
| `score_by` | Column that ranks inside this group: `gdpval` (default), `briefcase`, `coding` or `reasoning`. Floors and caps still use GDPval. |
| `require_score_column` | `true` drops models with no value in the `score_by` column. The gate stands down while no model has the column. |
| `min_score` | Minimum value in the `score_by` column; models without a value fail. |
| `max_cost` | Cost cap in the ranking's cost unit (input list price per million tokens for pay-per-token models). `0` admits only local and genuinely free models. |
| `max_cost_per_m` | Cap on the input price in dollars per million tokens. Local and free token-based models always pass. |
| `min_context_length` | Minimum context window in tokens; unknown windows fail. |
| `exclude_providers` | Providers dropped from this group. |
| `exclude_models` | Model refs or globs dropped from this group, e.g. `"*:free"`. |
| `billing_preference` | Re-ranks by billing tier after the method: `default`, `local_first`, `strict_local`, `cloud_first` or `local_before_payg`. |
| `context_budget` | Per-group override of the global `context_budget`, field by field. |
| `classifier_model` | Pin for the local classifier, `ollama/<model>:<tag>` (dynamic group only). Unset = derived from the models Ollama reports and verified by a probe. |
| `classifier_fallback` | Pin for the local classifier fallback. Unset = derived. |
| `classifier_cloud_model` | Cloud classifier `provider/id`, tried first before the probe-verified list. |
| `classifier_cloud_chain` | Allows sending the raw prompt to a free cloud model when the local classifiers are unavailable. Off in code (data minimization); the shipped `dynamic` group turns it on. |

## Merge semantics

- **Plain objects** (`exclude`, `providers.openrouter`, …) are merged recursively.
- **Arrays** (`free_models`, `fallback_groups`, group `models`) are **replaced**,
  not merged.
- **Exception — `exclude.*` arrays** (`exclude.models`, `exclude.providers`,
  `exclude.paid_models_from`) are **unioned** across layers (ADR-0009). Your
  `exclude.models` adds to the bundled blocklist instead of replacing it. A
  lower layer's exclusion cannot be removed by a higher layer.
- **Primitives** are overwritten.

## Verification

After editing an override, run any `/router` command (every call re-reads the config layers; so does every `session_start`) and check the
router log — you'll see:

```
[router] Config loaded from 2 layer(s): …/router-config.json → …/router-config.user.json
[router] Exclude rules removed N model(s): …
```
