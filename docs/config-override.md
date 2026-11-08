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

### `classifier_laya` — Experimental local classifier stage

An opt-in stage that classifies with a **local Laya sidecar** (Apple
Silicon / MLX) instead of the cloud chain. Disabled by default and
experimental — start in `"shadow"` mode, which only logs.

```json
{
  "classifier_laya": {
    "enabled": true,
    "checkpoint": "<hf-repo>:<revision>",
    "mode": "shadow",
    "endpoint": "http://127.0.0.1:8089",
    "confidence_threshold": 0.8,
    "timeout_ms": 1500,
    "compare_in_background": false,
    "observe_momentum": false
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turn the stage on (requires `checkpoint`) |
| `checkpoint` | — | Pinned weights, `<hf-repo>:<revision>`. Required when enabled — the router never downloads weights |
| `mode` | `"shadow"` | `"shadow"` logs without routing; `"active"` lets a confident answer take the route |
| `confidence_threshold` | `0.8` | Minimum confidence to use the answer, `0`–`1`. The scale is uncalibrated, so the default keeps a gate; `0` switches the gate off (Laya's answer is used whatever its confidence — the cloud chain then only runs on failure or as the background comparator) |
| `endpoint` | `http://127.0.0.1:8089` | Sidecar URL, `POST /classify` |
| `timeout_ms` | `1500` | Hand the prompt to the chain after this long. One timeout only affects that prompt; 3 in a row switch the stage off for 5 minutes. The sidecar's latency varies with GPU load, so leave headroom above the p90 of `laya.ms` in the decision log |
| `compare_in_background` | `false` | In active mode, still run the replaced chain detached and log it as a comparator record (ADR-0027) |
| `observe_momentum` | `false` | Log detached answers for short momentum prompts (can incur classifier spend) |

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

After editing an override, run `/router reload` (or restart pi) and check the
router log — you'll see:

```
[router] Config loaded from 2 layer(s): …/router-config.json → …/router-config.user.json
[router] Exclude rules removed N model(s): …
```
