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
replaced entirely.

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
    "strategic": { "min_gdpval": 800 }
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

## Merge semantics

- **Plain objects** (`exclude`, `providers.openrouter`, …) are merged recursively.
- **Arrays** (`exclude.models`, `free_models`, `fallback_groups`) are **replaced**,
  not merged. If you set `exclude.models`, it replaces the default list entirely.
- **Primitives** are overwritten.

## Verification

After editing an override, run `/router reload` (or restart pi) and check the
router log — you'll see:

```
[router] Config loaded from 2 layer(s): …/router-config.json → …/router-config.user.json
[router] Exclude rules removed N model(s): …
```
