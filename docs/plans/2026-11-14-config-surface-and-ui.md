# Config surface and UI: one consistent model, documented once, editable through `/router config`

**Status:** in progress since 2026-11-15 — Phases 1–4 done (commits `e8491a1`, `4020910`, `6aadb02`, and the Phase 4 commit); Phase 5 open. Phase 4 does not yet point to the Laya model artifact plan when no weights are installed (item 15, "may"); the integration reply already says when a switch is not in effect. Replaces `2026-11-08-router-config-ui.md` (its wizard is Phase 4 here) and the earlier draft of this file from the same day (commits `4da0e33`, `bd37cd4`). The open decisions at the end are waiting for the owner.

**Related plans (reused, not changed):** `2026-11-08-optional-integrations-config.md` (done 2026-11-12) owns the `integrations.*` contract, the schema and the unknown-key warnings. This plan builds on it. `2026-10-25-laya-sole-classifier.md` owns the Laya release gate. Context budget and compaction belong to Phase 5b of `2026-10-05-task-type-balancing.md`; this plan only exposes the switch that already exists.

**Problem scope (AGENTS §11):** one problem — the user configuration is inconsistent, documented by hand in several places, and changeable only by editing JSON. The four phases below are its parts, not separate problems.

## Problem

1. **Inconsistent placement.** Classifier keys sit on `model_groups.dynamic` (`classifier_model`, `classifier_fallback`, `classifier_cloud_model`, `classifier_cloud_candidates`, `classifier_cloud_chain`, `classifier_escalate_low_confidence`; `src/types.ts:175-213`). Logging is top-level (`classifier_log`, `src/types.ts:354`). Laya is under `integrations.laya` (`src/types.ts:360`). Exclude and compaction are top-level or under `context_budget`.
2. **Misleading names.** `classifier_cloud_chain` reads as an order, but it is an on/off switch. The order is fixed in code: local, then cloud, then static (`classifyViaLlmChain`, `src/content-classifier.ts`). The owner had to ask what `true` means.
3. **Hand-written, drifting documentation.** Counted on 2026-11-14 with `grep -rl`: `classifier_cloud_chain` appears in 15 files, `classifier_cloud_model` in 12, `classifier_fallback` in 10. The 2026-11-14 docs sync found the README describing the opposite of the code.
4. **`/router config` edits little.** Its subcommands are `exclude`, `unexclude`, `compaction` and `integration` (usage at `src/commands.ts:267-270`, dispatch in `handleConfigCommand`, `src/commands.ts:585-588`). The user-layer store accepts only `exclude`, `context_budget.enabled` and `integrations` (`UserConfigDelta`, `src/user-config-store.ts:24-31`). No `model_groups` path exists (grep count 0). Every classifier change is a hand edit.
5. **Uneven validation.** The integrations block has a schema and `checkIntegrationPatch`. Classifier keys have neither: a typo such as `cloud.enable` is ignored, and a cloud candidate that Pi does not know is only skipped at call time.
6. **The effective chain is invisible.** Nothing shows which classifier chain the current config produces.
7. **Interactive UI unused.** `ctx.ui` offers `select`, `confirm`, `input` and `notify` (`@earendil-works/pi-coding-agent`, `dist/core/extensions/types.d.ts:85-91`). The run mode can be checked so that terminal-only dialogs are not opened in print or RPC mode.

## Solution

### Phase 1 — One model: a description table

1. **Block.** `classifier: { local: { model, fallback }, cloud: { enabled, model, candidates, escalate_low_confidence }, log: {…} }`. `no_schema` is not a config key: `classifier_no_schema` is a cache field (`cache.classifier_no_schema`, `src/classifier-local-probe.ts`), so the table does not list it. Corrected in the Phase 2 commit. `classifier_log` moves to `classifier.log`. Laya stays under `integrations.laya` unchanged. `exclude` and `context_budget` keep their place.
2. **One table** `src/config-keys.ts`. For every user-visible key: dotted path, type, allowed values, shipped default, one-line meaning, legacy name, whether the command may set it (and which subcommand), whether the wizard offers it, and a `file-only` flag for keys that stay hand-edited. The schema, the loader, the status line, `/router config`, the wizard and the generated reference (Phase 5) all read this table. A key that is not in the table does not exist.
3. **Migration.** Old keys map to new paths through the existing `RENAMED_CLASSIFIER_KEYS` mechanism (`src/config-loader.ts:256`) with a warning. Red first: `classifier_cloud_chain: false` on the dynamic group sets `classifier.cloud.enabled: false` and prints the warning.
4. **Typos are reported.** Unknown keys inside `classifier` produce a warning, as the integrations block does. Red first: `cloud.enable` warns.
5. **Shipped config.** `router-config.json` moves `classifier_cloud_chain: true` to `classifier.cloud.enabled: true`. No model name enters the shipped block (AGENTS §9). `cloud.candidates` stays empty.

### Phase 2 — Validated writes

6. **Store.** `UserConfigDelta` takes dotted paths from the table, not hand-written fields. Writes merge into the user layer and keep all other keys. Red first: setting one classifier key keeps `exclude` and the other keys in the file.
7. **Validation from the table.** Type, allowed values, on/off words. For `cloud.candidates` each entry must be `provider/id` and must resolve through pi's registry (`findModel`). An unknown ref is refused with "pi does not know this model", because candidates enter only through pi (AGENTS §6, §9). The 2026-10-06 bug came from exactly such a list.
8. **Reply states what is in effect.** As `setIntegration` does (`src/commands.ts:298-345`): after the write the config is reloaded and the reply shows the effective value and the chain, not the requested value.

### Phase 3 — Command surface

9. **Subcommands.** `/router config` (overview: sources, blocks, one summary line per integration, effective chain summary). `/router config <block>` shows one block. `/router config set <path> <value>` and `/router config unset <path>` write one table key. The existing `exclude`, `unexclude`, `compaction` and `integration` stay as aliases. Nothing is removed.
10. **Discoverable.** The usage text, the `/router` help line and the completion list are generated from the same subcommand list. The top-level `/router` table exists since 2026-11-14 (`ROUTER_SUBCOMMANDS` in `src/commands.ts`); the `config` subcommands are added to it here, replacing the hand-written `CONFIG_USAGE_LINES`. Red first: a test that every subcommand in the usage text is handled by `handleConfigCommand`.
11. **Non-interactive form.** `set`/`unset`/`show` work in every mode. They never open a dialog.

### Phase 4 — Guided UI

12. **Menu.** `/router config` without arguments in TUI mode opens `ctx.ui.select`: block → key → value. Booleans use `confirm`, free text uses `input`, enumerations use `select`. Every value is validated before the write (Phase 2).
13. **Wizard scope.** The wizard offers only keys whose table entry is marked `wizard`. `file-only` keys show their path and the one-line meaning. This replaces the wizard of `2026-11-08-router-config-ui.md`.
14. **Print and RPC mode.** The wizard is not started. The command prints the non-interactive usage and says why. It never blocks waiting for input.
15. **Laya.** `integrations.laya` is one `wizard`-marked entry set (enable, mode). The wizard may point to `2026-11-08-laya-model-artifact.md` when no weights are installed; it never downloads.
16. **Project layer.** As decided on 2026-11-08 (the owner's decision), a project layer may enable an integration too. The wizard writes only the global user layer, which is its own choice and not a trust rule.

### Phase 5 — Documentation and chain from the table

17. **Generated reference.** `scripts/config-reference.ts` renders the table into `docs/config-reference.md`. A test fails when the committed file is stale (the same pattern as the lint baseline and the format gate). The table is the only place where the key list is written.
18. **Prose links to the reference.** README, PI.md, `docs/config-override.md` and `docs/routing-flow.md` keep the concepts (order, privacy, when cloud is used) and link to the reference for keys. Their hand-written key tables are removed. Red first: a test counts the keys that a document lists by hand and fails when it lists one the table does not have.
19. **The chain is computed.** `describeClassifierChain(cfg)` returns the ordered steps for the current config. `/router config classifier` and the reference show its output. The routing-flow diagram stays hand-drawn, but a test pins its node names to the step names the function emits.

## Scope

In: the classifier block, `integrations`, `exclude`, `context_budget.enabled` (the switch only, as today), and the `log` setting. Out: `providers`, the non-classifier `model_groups` keys and `delegation`. They stay file-only in the table and get their own plan later. The table and the store are built so that adding a block is one table entry per key.

## Sequencing and release gate

Phases 1 and 2 change user layers (key renames), so they land before the 2.0.0 tag. Phases 3–5 can follow the tag if the owner decides so. The tag, the release and the publish stay the owner's call (AGENTS §1).

## Test strategy

Red first for every behaviour change, with the red evidence named in the commit message. Mutation check for the validator and the writer (remove the check, the test turns red). Table-driven tests share one fixture, so the redundancy ratchet (`test/redundancy-baseline.test.ts`) does not grow. Full suite, `tsc` and the lint gate stay green.

## Open decisions (owner)

1. **Block shape.** Nested `classifier` (recommended) or flat keys with better names?
2. **Migration.** Read old keys for one release with a warning (recommended, the existing pattern), or hard break at 2.0.0?
3. **Switch name.** `classifier.cloud.enabled` (recommended) or keep `classifier_cloud_chain` and only document it?
4. **Command shape.** Generic `set`/`unset` by path against the table (recommended) or one subcommand per key?
5. **Unknown candidate.** Refuse the write when pi does not know the model (recommended, AGENTS §9), or store it with a warning?
6. **Wizard scope.** Only keys marked `wizard` in the table (recommended: classifier on/off, cloud candidates, integrations enable and mode), or every key?
7. **Non-TUI mode.** Print the usage and the reason, never block (recommended).
8. **Location of the overview.** Full detail in `/router config`, one summary line per integration in `/router status` (recommended, as in the superseded plan).
9. **Scope.** Blocks listed under Scope now; `providers` and the rest of `model_groups` as a separate plan (recommended). Say so if you want them in this plan.
10. **Timing.** Phases 1–2 before the 2.0.0 tag (recommended). Phases 3–5 before or after the tag?

**Out of scope, tracked in TODO.md:** whether cloud candidates should be limited to free models. That is an eligibility rule, not a configuration surface.

## Verified against

Commit `bd37cd4` on `docs/sync-with-behavior` (2026-11-14), read as follows:
- `/router config`: usage `src/commands.ts:267-270`, `handleConfigCommand` `:585-588`, `setIntegration` `:298-345`.
- Store delta fields `src/user-config-store.ts:24-31`; `model_groups` grep count 0.
- Classifier key occurrences: `grep -rl` over README, PI.md, `docs/`, `docs/adr/`, CHANGELOG, `router-config.json`, `src/*.ts`, `skills/`.
- `ctx.ui.select/confirm/input/notify`: `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:85-91`; the run-mode field used as the TUI guard is in the same file.
- Schema: `src/config-schema.ts` plus `test/config-schema.test.ts` (compares with `interface Config`).
- The old UI plan's decisions (wizard scope, print mode, overview location, project layer) were carried over from `2026-11-08-router-config-ui.md`, read on 2026-11-14.

**Not checked:** whether `ctx.ui` is reachable inside the existing `/router` command handler (the wizard depends on it; Phase 4 starts with that check); the owner's own user layer beyond the shipped file; the length limit of the `/router` completion list.
