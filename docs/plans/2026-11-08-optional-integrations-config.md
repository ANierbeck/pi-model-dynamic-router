# Optional integrations: one contract, one config block, typo-safe user layers

**Status:** proposed 2026-11-08 — not started. **Decision 1 is DECIDED
(2026-11-08): rename `classifier_laya` → `integrations.laya` before 2.0.0
— the contract + rename + migration warning therefore land before the
release** (part of the "everything Laya" release gate,
`2026-10-25-laya-sole-classifier.md`). Decisions 3 and 4 are DECIDED too
(2026-11-08, see Open decisions); decision 2 remains open and does not block
2.0.0. The core-only invariant test (Solution 5) exists for Laya
(`test/laya-chain.test.ts`). Prerequisite for
[`2026-11-08-external-usage-source-codexbar.md`](2026-11-08-external-usage-source-codexbar.md); touches the Laya config from [`2026-10-31-laya-sidecar-distribution.md`](2026-10-31-laya-sidecar-distribution.md) and [`2026-10-25-laya-sole-classifier.md`](2026-10-25-laya-sole-classifier.md) without changing their decisions.

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
3. **No per-layer trust restriction (owner decision 2026-11-08).** A project
   layer may enable an integration, like the global user layer. The reason is
   structural: an integration that is not there leaves the default chain in
   charge, and the core-only invariant test (Solution 5) pins exactly that, so
   a project enabling one costs nothing. What keeps it safe is that validation
   runs on the MERGED config, so the loopback rule binds every layer; both
   facts are pinned in `test/config-loader.test.ts`. Residual risk, accepted by
   the owner: a project can name any loopback port, and prompt text would go to
   whatever listens there on this machine. (The first draft of this plan
   proposed "disable or lower only" for project layers; it is withdrawn.)
4. **Unknown-key warnings:** the known-key set comes from one source (Open decision 2). Unknown keys in the user and project layers are warned about once per file, with the closest known key suggested. Warn, never throw: a typo must not break routing.
5. **Core-only invariant test:** run a fixed set of routing scenarios once with all integrations absent, once with all enabled but unreachable, and once with all timing out. All three must give identical routing decisions to the core baseline. Every new integration joins this test by registering, so "optional" is enforced, not promised.
   **Delivered for Laya (2026-11-08):** `test/laya-chain.test.ts`
   compares a fixed scenario list against the absent-integration baseline for
   the states disabled, connection refused, HTTP 500, timeout, unparseable
   answer, and the realistic late failures (healthy probe, then 500 or garbage),
   each with `compare_in_background` and in shadow mode; `observe_momentum` has
   a routing-only test because its detached observations may spend a chain call
   by design. The next integration adds rows to the state table.

## Open decisions

1. **Rename `classifier_laya` → `integrations.laya` before 2.0.0?** DECIDED
   2026-11-08: yes — rename before 2.0.0, with a `RENAMED_*` warning and no
   read alias (the fallback-naming pattern, V2).
2. **Source of the known-key set / schema:** (a) a JSON Schema generated from `src/types.ts` (adds a devDependency, so AGENTS.md §10 applies), shipped as `router-config.schema.json` for editors (`"$schema"`) and used for the runtime check; (b) a hand-maintained schema with a test that it matches `Config`; (c) a runtime-only known-key list derived from the defaults. Recommendation: (b). No new dependency, and the test keeps it honest.
3. **Project-layer trust rule (Solution 3):** DECIDED 2026-11-08: no
   restriction. A project layer may enable an integration; "if it is not
   there, the default chain applies". Laya ships only from 2.0, so no released
   version ever had the question.
4. **Should the router ever manage sidecar lifecycles?** DECIDED 2026-11-08:
   yes, the router gets a way to start the sidecar — but later, not a 2.0.0
   blocker. This reverses the first recommendation ("integrations stay pure
   HTTP consumers"). It needs its own plan (AGENTS.md §11) when scheduled; the
   user-level sidecar manager that exists today (outside the repository:
   health-first adoption, cross-process start lock, last-client shutdown) is
   the prototype, and the model artifact plan
   (`2026-11-08-laya-model-artifact.md`) supplies what it would start.

## Verified against

Commit `a9dc015` (`main`, 2026-11-08): `src/types.ts` (`Config`: 22 top-level keys; `ClassifierLayaConfig`; other `enabled?` switches in `BreakerConfig`, `ClassifierLogConfig`, `ContextBudgetConfig`, `DelegationConfig`), `src/config-loader.ts` (layer order, `deepMergeConfig`, `REMOVED_GROUPS`, `RENAMED_CLASSIFIER_KEYS`, `validateClassifierLaya`; no unknown-key check, no per-layer restriction), shipped `router-config.json` (10 top-level keys, `classifier_laya: {enabled: false}`), `src/laya-classifier.ts` (`layaAvailabilityState`), `src/commands.ts` (`/router status` Laya branch, `/router config` subcommands), `test/laya-chain.test.ts` (lines 168 and 220), `docs/config-override.md` (sections). No JSON Schema file in the repo.

**Not checked:** how many existing tests construct `classifier_laya` directly (the rename's test churn); whether `src/user-config-store.ts` can write nested keys generically or only the existing switches; the owner's current `router-config.user.json` (its Laya settings come from the Laya sole-classifier plan's "State" section, not read here).

## Steps

- [x] Owner decides 1, 3, 4 (2026-11-08); decision 2 (known-key source) is open.
- [x] Core-only invariant test for Laya (`test/laya-chain.test.ts`, 26 cases; green at birth by nature — it pins existing behavior — so its strength was proven by five hand-applied mutations in `src/`, each driving it red).
- [x] Project-layer pins in `test/config-loader.test.ts`: a project layer may enable Laya; the loopback rule binds it (two mutations, both red).
- [ ] Red-first: unknown-key tests in the config-loader test file.
- [ ] `src/integration.ts`: contract, `validateIntegration`, health registry; `validateClassifierLaya` and `layaAvailabilityState` reimplemented on top of it, behaviour-preserving (existing Laya tests stay green unchanged).
- [ ] Schema / known-key source per decision 2, plus unknown-key warnings.
- [ ] `/router status` "Integrations" section; `/router config integration …` subcommand.
- [ ] Rename per decision 1 (`RENAMED_*` warning), config docs, CHANGELOG entry under 2.0.0.
- [ ] CodexBar plan continues on this contract.
