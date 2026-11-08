# Optional integrations: one contract, one config block, typo-safe user layers

**Status:** proposed 2026-11-08 — not started. Prerequisite for [`2026-11-08-external-usage-source-codexbar.md`](2026-11-08-external-usage-source-codexbar.md); touches the Laya config from [`2026-10-31-laya-sidecar-distribution.md`](2026-10-31-laya-sidecar-distribution.md) and [`2026-10-25-laya-sole-classifier.md`](2026-10-25-laya-sole-classifier.md) without changing their decisions.

## Problem

The router is growing optional external components: Laya today, CodexBar next. Each one is wired in by hand, and the configuration that switches them gives no protection against mistakes:

1. **Each optional component brings its own ad-hoc block and validator.** Laya has the top-level `classifier_laya` block and a hand-written `validateClassifierLaya()` in `src/config-loader.ts`, which checks the loopback endpoint, fills defaults and disables the stage instead of throwing. A second sidecar would copy the loopback check, the default filling and the fail-safe disable (duplication the `redundancy-baseline` ratchet already counts against).
2. **Health and status are per-feature special cases.** Laya has its own `layaAvailabilityState()` (`'ok' | 'down' | 'unknown'`) in `src/laya-classifier.ts` and its own branch in the `/router status` renderer (`src/commands.ts`, the `laya` input around lines 150–205). There is no common "integration X: enabled / mode / health / version" view.
3. **"Optional" is tested for Laya only.** `test/laya-chain.test.ts` pins "with the stage disabled or absent the chain is untouched" and "a down sidecar is transparent". There is no general invariant that the router with every integration off, or every sidecar down, routes exactly as the core does.
4. **The config surface is flat and unchecked.** `Config` in `src/types.ts` has 22 top-level keys; the shipped `router-config.json` sets 10. Only removed groups (`REMOVED_GROUPS`) and renamed classifier keys (`RENAMED_CLASSIFIER_KEYS`) are warned about. An unknown key — a typo such as `classifer_laya` in `~/.pi/agent/router-config.user.json` — is merged and silently ignored. No JSON Schema exists, so editors cannot help either.
5. **A project layer can switch integrations on.** `loadLayeredConfig()` merges `<cwd>/.pi/router-config.json` with the same rights as the user's global file. A cloned repository can therefore enable Laya in `active` mode or change its `timeout_ms`. The loopback check limits where prompts go, but the decision to run an optional component, and in which mode, belongs to the user, not to a repository.
6. **Sidecar lifecycle lives outside the repo** (`~/.pi/agent/extensions/laya-sidecar-manager`, hard-coded paths; see the Laya distribution plan). This plan does not move it. It only fixes the contract the router expects from any sidecar.

## Solution

1. **One integration contract** (`src/integration.ts`):
   - Base config: `{ enabled?: boolean (default false), mode?: 'observe' | 'shadow' | 'active' (per-integration allowed subset), endpoint?: string, timeout_ms?: number }`.
   - `validateIntegration(name, block, spec)`: loopback check (moved out of `validateClassifierLaya`), defaults filled, wrong types fall back with one warning each, and any fatal problem disables the integration without throwing.
   - A health registry: `ok | down | unknown`, last error (masked), version reported by the sidecar's `/health`, last-success timestamp. `layaAvailabilityState()` becomes a thin read of that registry.
   - One `/router status` section, "Integrations", that renders every registered integration the same way. `/router config integration <name> on|off|<mode>` writes the global user layer through `src/user-config-store.ts`, like `/router config compaction` does today.
2. **One config namespace:** `integrations.laya`, `integrations.codexbar`, and later others. Specific fields (Laya: `checkpoint`, `confidence_threshold`, `compare_in_background`, `observe_momentum`; CodexBar: `poll_s`, `stale_after_s`, `provider_map`) live inside the block. How `classifier_laya` reaches the new key is Open decision 1.
3. **Trust per layer:** integrations can be enabled and their mode or endpoint raised only in the global user layer. A project layer may only disable them or lower their mode (`active` → `shadow`/`observe` → off). Anything else is dropped with one warning naming the file. This follows the `exclude`-union reasoning of ADR-0009: a safety property survives layering.
4. **Unknown-key warnings:** the known-key set comes from one source (Open decision 2). Unknown keys in the user and project layers are warned about once per file, with the closest known key suggested. Warn, never throw: a typo must not break routing.
5. **Core-only invariant test:** run a fixed set of routing scenarios once with all integrations absent, once with all enabled but unreachable, and once with all timing out. All three must give identical routing decisions to the core baseline. Every new integration joins this test by registering, so "optional" is enforced, not promised.

## Open decisions

1. **Rename `classifier_laya` → `integrations.laya` before 2.0.0?** 2.0.0 is not released yet (Laya labeling is its release gate, commit `5b343af`), so renaming now costs one break instead of a later one. The fallback-naming plan chose "no read aliases, but warn" for 2.0 (V2), and the same pattern (`RENAMED_*` + warning) applies here. Alternative: keep `classifier_laya` and use the contract only internally. Recommendation: rename before 2.0.0, with a warning and no alias.
2. **Source of the known-key set / schema:** (a) a JSON Schema generated from `src/types.ts` (adds a devDependency, so AGENTS.md §10 applies), shipped as `router-config.schema.json` for editors (`"$schema"`) and used for the runtime check; (b) a hand-maintained schema with a test that it matches `Config`; (c) a runtime-only known-key list derived from the defaults. Recommendation: (b). No new dependency, and the test keeps it honest.
3. **Project-layer trust rule (Solution 3):** is "disable or lower only" right, or should a project be allowed to enable an integration the user has globally allowed (`integrations.<name>.allow_project_enable: true`)?
4. **Should the router ever manage sidecar lifecycles?** Recommendation: no. Integrations stay pure HTTP consumers, and starting them stays with the owning tool (CodexBar app, Laya sidecar package). That keeps the Laya distribution plan's decision 3 independent of this plan.

## Verified against

Commit `a9dc015` (`main`, 2026-11-08): `src/types.ts` (`Config`: 22 top-level keys; `ClassifierLayaConfig`; other `enabled?` switches in `BreakerConfig`, `ClassifierLogConfig`, `ContextBudgetConfig`, `DelegationConfig`), `src/config-loader.ts` (layer order, `deepMergeConfig`, `REMOVED_GROUPS`, `RENAMED_CLASSIFIER_KEYS`, `validateClassifierLaya`; no unknown-key check, no per-layer restriction), shipped `router-config.json` (10 top-level keys, `classifier_laya: {enabled: false}`), `src/laya-classifier.ts` (`layaAvailabilityState`), `src/commands.ts` (`/router status` Laya branch, `/router config` subcommands), `test/laya-chain.test.ts` (lines 168 and 220), `docs/config-override.md` (sections). No JSON Schema file in the repo.

**Not checked:** how many existing tests construct `classifier_laya` directly (the rename's test churn); whether `src/user-config-store.ts` can write nested keys generically or only the existing switches; the owner's current `router-config.user.json` (its Laya settings come from the Laya sole-classifier plan's "State" section, not read here).

## Steps

- [ ] Owner decides 1–3.
- [ ] Red-first: core-only invariant test (absent / unreachable / timing out), at first with Laya only.
- [ ] Red-first: unknown-key and project-layer-trust tests in the config-loader test file.
- [ ] `src/integration.ts`: contract, `validateIntegration`, health registry; `validateClassifierLaya` and `layaAvailabilityState` reimplemented on top of it, behaviour-preserving (existing Laya tests stay green unchanged).
- [ ] Schema / known-key source per decision 2, plus unknown-key warnings.
- [ ] Project-layer trust rule per decision 3.
- [ ] `/router status` "Integrations" section; `/router config integration …` subcommand.
- [ ] Rename per decision 1 (`RENAMED_*` warning), config docs, CHANGELOG entry under 2.0.0.
- [ ] CodexBar plan continues on this contract.
