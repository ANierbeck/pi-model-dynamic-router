# Classifier configuration: consistent keys, one documentation source, editable via `/router config`

**Status:** proposed 2026-11-14 (revised the same day: the three goals are now the solution pillars) — not started; the open decisions at the end are waiting for the owner.

**Related plans (not this problem):** `2026-11-08-optional-integrations-config.md`
(done 2026-11-12) owns the `integrations.*` contract and the Laya block; this plan
reuses its mechanism (schema, unknown-key warnings, one-write command) and does
not change it. `2026-11-08-router-config-ui.md` (proposed) owns the interactive
UI; this plan makes the classifier part of the command surface that UI would
later edit. Context budget and compaction belong to Phase 5b of
`2026-10-05-task-type-balancing.md`.

## Problem

The classifier can be configured, but the configuration is inconsistent, documented
in several places by hand, and cannot be changed through the command the user already has.

1. **Inconsistent locations.** Classifier keys sit on `model_groups.dynamic`:
   `classifier_model`, `classifier_fallback`, `classifier_no_schema`,
   `classifier_cloud_model`, `classifier_cloud_candidates`, `classifier_cloud_chain`,
   `classifier_escalate_low_confidence` (`src/types.ts:175-213`). Logging is
   top-level (`classifier_log`, `src/types.ts:354`). Laya is under
   `integrations.laya` (`src/types.ts:360`).
2. **Misleading names.** `classifier_cloud_chain` reads as an order and is an
   on/off switch. The order is fixed in code: local, then cloud, then static
   (`classifyViaLlmChain`, `src/content-classifier.ts`). The owner had to ask
   what `true` means next to "local first".
3. **Hand-written documentation that drifts.** The same key is described in
   README, PI.md, `docs/routing-flow.md`, `docs/config-override.md`, the comments in
   `src/types.ts`, and CHANGELOG. Counted on 2026-11-14: `classifier_cloud_chain`
   appears in 15 files, `classifier_fallback` in 10, `classifier_cloud_model` in 12.
   The 2026-11-14 docs sync found the README describing the opposite of the code.
4. **`/router config` cannot change a classifier setting.** Its subcommands are
   `exclude`, `unexclude`, `compaction` and `integration`
   (`src/commands.ts:267-270`, `handleConfigCommand`). The user-layer store accepts
   only `exclude`, `context_budget.enabled` and `integrations`
   (`UserConfigDelta`, `src/user-config-store.ts:24-31`). `model_groups` is not
   writable at all. Changing the classifier means editing JSON by hand.
5. **Validation is uneven.** The integrations block has a schema check and
   `checkIntegrationPatch`. The classifier keys have neither: `cloud.enable` (typo)
   is silently ignored, and a cloud candidate that pi does not know is only
   skipped at call time.
6. **The chain the user gets is not shown anywhere.** `/router config` shows
   sources and exclude rules, not the resulting classifier chain.

## Solution

Three pillars, one mechanism. Every classifier key is described once, and the
command, the loader, the status line and the documentation all read that description.

### Pillar A — consistency: one `classifier` block, one description table

1. **Block.** `classifier: { local: { model, fallback, no_schema }, cloud: { enabled,
   model, candidates, escalate_low_confidence }, log: {…} }`. `classifier_log`
   moves into `log`. Laya stays under `integrations.laya`.
2. **One description table** `src/classifier-config-keys.ts`: for each key its path,
   type, allowed values, shipped default, a one-line meaning, whether the command
   may set it, and its legacy name. Schema, loader, status line, `/router config`
   and the documentation all read this table. A key that is not in the table does not exist.
3. **Migration.** Old keys map to the new paths with the existing
   `RENAMED_CLASSIFIER_KEYS` warning (`src/config-loader.ts:256`). Red first: a
   test that `classifier_cloud_chain: false` on the dynamic group sets
   `classifier.cloud.enabled: false` and prints the warning.
4. **Typos are reported.** Unknown keys inside `classifier` produce a warning,
   like the integrations block. Red first: `cloud.enable` warns.
5. **Shipped config.** `router-config.json` moves `classifier_cloud_chain: true`
   to `classifier.cloud.enabled: true`. No model name enters the shipped block
   (AGENTS §9). `cloud.candidates` stays empty.

### Pillar B — one documentation source

6. **Generated reference.** `scripts/classifier-config-doc.ts` renders the
   description table into `docs/classifier-config.md`. A test fails when the
   committed file is stale, the same pattern as the lint baseline and the format
   gate, so the table is the only place the key list is written down.
7. **Prose points to the reference.** README, PI.md, `docs/config-override.md`
   and `docs/routing-flow.md` keep the concepts (order, privacy, when cloud is
   used) and link to the generated reference for the key list. The duplicate key
   tables are removed. Red first: a test counts the classifier keys that a
   document lists by hand and fails when it lists one the table does not have.
8. **The chain is rendered from config, not written by hand.** One function
   `describeClassifierChain(cfg)` returns the ordered steps for the current
   config. `/router config classifier` shows it, and the generated reference
   includes its output for the shipped config. The routing-flow diagram stays
   hand-drawn, but a test pins its node names to the step names the function emits.

### Pillar C — editable via `/router config`

9. **Command.** `/router config classifier` shows the current block and the
   chain. `/router config classifier set <key> <value>` writes one key to the user
   layer through the same store as `integration`. `/router config classifier unset <key>`
   removes it from the user layer. Only keys whose table entry says
   "command-settable" can be set; the others print the file path to edit instead.
10. **Validation before the write.** The value is checked against the table (type,
    allowed values, on/off words). For `cloud.candidates` each ref must be
    `provider/id` and must resolve in pi's registry (`findModel`). An unknown ref is
    refused with the hint "pi does not know this model", because the owner rule
    admits candidates only through pi (AGENTS §6, §9). The 2026-10-06 bug came from
    exactly such a list.
11. **Store.** `UserConfigDelta` gets a `model_groups.dynamic.<key>` path, limited
    to the classifier keys, merged into the existing user layer with the other keys
    kept. Red first: a delta that sets one classifier key keeps `exclude` and the
    other keys in the file.
12. **Reply states what is in effect.** As `setIntegration` does: after the write
    the config is reloaded and the reply shows the effective value and the resulting
    chain, not the value asked for.
13. **Discoverable.** The command help line and the `/router` completion list
    (`src/commands.ts:650-668`) get the new subcommands. A test pins that each
    subcommand in the usage text is also handled by `handleConfigCommand`.

## Scope

This plan covers the classifier block and nothing else. The mechanism (the
description table, the store delta, the reference generator) is built so that
other blocks can be added by one table entry each. Moving the rest of the config
(`providers`, `model_groups` non-classifier keys, `exclude`, `delegation`) into
the same surface is a **separate plan**, to be written after this one lands.

## Open decisions (owner)

1. **Shape.** Nested `classifier` block (recommended) or flat keys with better names?
2. **Scope of the block.** One global block (recommended: only the `dynamic` group
   classifies today) or one per group?
3. **Migration.** Read the old keys for one release with a warning (recommended, the
   existing pattern), or hard break at 2.0.0?
4. **Switch name.** `classifier.cloud.enabled` (recommended) or keep
   `classifier_cloud_chain` and only document it?
5. **Command shape.** Generic `set <key> <value>` for command-settable keys
   (recommended, one code path, validated by the table) or one subcommand per key?
6. **Unknown candidate.** Refuse the write when pi does not know the model
   (recommended, owner rule §9), or store it with a warning?
7. **Timing.** Before the 2.0.0 tag (recommended, user layers would break after
   release). The tag itself stays the owner's call (AGENTS §1).
8. **Generated reference.** Generate `docs/classifier-config.md` (recommended,
   the stale-file test enforces it) or write it by hand and test only the key count?

**Out of scope, tracked in TODO.md:** whether cloud candidates should be limited
to free models. That is an eligibility rule, not a configuration surface.

## Verified against

Commit `4da0e33` on `docs/sync-with-behavior`, read on 2026-11-14:
- `/router config` subcommands: `src/commands.ts:267-270` (usage), `:585-588`
  (`handleConfigCommand`), `setIntegration` at `:298-345` (the pattern reused).
- Store delta fields: `src/user-config-store.ts:24-31`; no `model_groups` path exists
  (grep count 0).
- Classifier key occurrences in documents and code (counts above) were taken with
  `grep -rl` over README, PI.md, `docs/`, `docs/adr/`, CHANGELOG, `router-config.json`,
  `src/*.ts` and `skills/`.
- Key list in `docs/config-override.md`: 7 classifier table rows.
- Schema test: `test/config-schema.test.ts` already compares `src/config-schema.ts`
  with `interface Config`, so the new block is covered once the type exists.

**Not checked:** the owner's own user layer beyond the shipped file; whether the
`/router` completion UI has a length limit for the new subcommands; the exact text
of the Laya and CodexBar docs that reference the same mechanism.
