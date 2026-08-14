# Changelog

## [Unreleased] — Model matching & config overhaul

### Added
- **LLM-assisted model matching** (`src/model-matcher.ts`): when the
  deterministic model-map + token-set fallback can't resolve a model, a local
  LLM matches it to a known GDPval slug. Batched (40/batch) with plausibility
  pre-filtering. Results cached in `scan-cache.json`.
- **Provider-agnostic local LLM caller** (`src/local-llm.ts`): discovers the
  local provider (Ollama OR LM Studio) generically. Falls back to free
  OpenRouter cloud models on local failure. Model ranking prefers capable
  but fast models (gemma4:12b > qwen3.5 > gemma2:2b-last-resort).
- **Personalized exclude rules** (`src/exclude.ts`): `exclude.providers`,
  `exclude.models` (glob), `exclude.paid_models_from` in `router-config.json`.
  Applied to all groups before per-group filtering.
- **Layered configuration** (`src/config-loader.ts`): deep-merge embedded
  defaults → global user override (`~/.pi/agent/router-config.user.json`) →
  project-local override (`<cwd>/.pi/router-config.json`).
- **Cross-family hallucination guard** (`isPlausibleMatch`): rejects LLM
  matches across different vendors (mistral→claude, qwen→gpt).
- **TAB-completion** for `/router` sub-commands and group names.
- **Architecture docs** (`docs/architecture.md`, `docs/config-override.md`).

### Changed
- **Single source of truth for `lookupGdp`**: removed the duplicated closure
  implementation in `index.ts`. All GDPval lookup now goes through
  `metrics.ts`. This eliminates the "dynamic config has GLM but TUI table
  doesn't" class of bugs.
- **`getM(ref)` no longer caches `gdpval`**: always recomputed from current
  `lookupGdp` state. Prevents stale scores after config reloads.
- **`loadModelMap` logs parse errors loudly** (was silently swallowed, which
  hid duplicate-YAML-key bugs).
- **`/router` sub-commands simplified**: removed `reload`, `sync`, `reset`
  (overlapping with automatic session-start behaviour). Only `scan` remains.
- **Prompt is now generic** — vendor, version, and size-tier rules are
  conveyed to the LLM as principles, not hardcoded to specific model names.

### Fixed
- GLM-5-2 missing from router table (two `lookupGdp` implementations drifted)
- `mistral-medium-2604` matched to `claude-opus-5` (cross-family hallucination)
- `ministral-3b-latest` matched to `mistral-medium-3-5` (size-tier mismatch)
- `model-map.yaml` duplicate keys silently disabling all map overrides
- `gdpval` scores lost during `load()` race-condition (self-healing added)
- `metrics.ts` `modelMap` never loaded (only the closure version was)
- Exclude rules not applied to live TUI table (only to dynamic config)
- `/router reset` deleting GDPval scores (command removed)
