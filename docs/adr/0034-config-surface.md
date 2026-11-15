# 0034 — One config surface: a classifier block, a key table, validated writes, a generated reference

## Status

Proposed (2026-11-15). Written while executing
`docs/plans/2026-11-14-config-surface-and-ui.md`, which the owner asked to
execute; the plan's recommended options were applied. Acceptance is the
owner's decision at merge.

Builds on ADR 0032 (local-first chain) and ADR 0033 (opt-in escalation), which are not changed. Settles the
configuration shape those ADRs left as `classifier_*` keys on the `dynamic` group.

## Context

The classifier settings were flat keys on the `dynamic` model group
(`classifier_cloud_chain`, `classifier_cloud_model`, `classifier_fallback`, …),
and the decision log sat at the top level as `classifier_log`. Four problems
followed from that:

1. **Misleading names.** `classifier_cloud_chain` reads as an order, but it is an
   on/off switch. The order is fixed in code: Laya, local, cloud, static.
2. **No validation on the classifier keys.** A typo (`cloud.enable`) was ignored
   silently, and a cloud candidate that pi does not know was accepted.
3. **Hand-written documentation that drifted.** The same key was documented in
   about fifteen files.
4. **`/router config` only edited exclusions and compaction.** Changing a switch
   or a candidate list meant editing JSON.

## Decision Drivers

- **Candidates enter only through pi** (ADR 0025, ADR 0021): a model reference
  the user writes must be one pi's registry resolves, because a shipped list
  admitted on config presence alone put dead candidates into every cheap group
  (incident 2026-10-06).
- **Prompt privacy is a switch the user must be able to read.** Whether prompt
  text may leave the machine is the most consequential classifier setting; its
  name must say what it does.
- **No silent loss of a setting across the 2.0 rename.** A dropped cloud switch
  would change where prompts go without a word.
- **One source per fact.** The key list drifted across about fifteen documents;
  the same list must feed the command, the menu and the docs.
- **Every run mode works.** Print and RPC mode have no dialogs; a command must
  never wait for input there.
- **Small surface.** A single-user extension; the menu should not become a
  second editor for every setting.

## Options Considered

The config plan listed each choice with a recommended option; the recommended
options were applied, not confirmed by the owner one by one.

1. **Block shape.** A nested `classifier` block (chosen: one place, names read
   as a path, room for `local`/`cloud`/`log`) or flat keys with better names
   (smaller change, but the classifier stays scattered across the `dynamic`
   group and the top level).
2. **Migration.** Read the pre-2.0 names for one release with a warning (chosen:
   no setting is lost, the user sees what to rename) or a hard break at 2.0.0
   (less loader code, but an old cloud switch would be dropped silently).
3. **Switch name.** `classifier.cloud.enabled` (chosen: says on/off) or keep
   `classifier_cloud_chain` and only document it (no rename, but the name keeps
   reading as an order).
4. **Command shape.** Generic `set`/`unset` by path against the table (chosen:
   a new key needs a table entry, not a new subcommand) or one subcommand per
   key (more discoverable per key, but grows with every key and drifts from
   the table).
5. **Unknown model reference.** Refuse the write when pi does not know the
   model (chosen, driver one) or store it with a warning (accepts a typo, but
   the dead candidate surfaces only at call time).
6. **Menu scope.** Only keys marked `wizard` in the table (chosen: the cloud
   switch, cloud candidates, Laya on/off and mode) or every key (complete, but
   a second editor for settings that are rarely changed).
7. **Non-TUI mode.** Print the non-interactive usage and the reason, never
   block (chosen). The plan named no alternative: a dialog would leave print
   and RPC mode waiting for input. As built, the overview is printed; its
   command list holds the usage.
8. **Location of the overview.** Full detail in `/router config` and one summary
   line per integration in `/router status` (chosen). The plan named no
   alternative; the choice carries over from the superseded
   `docs/plans/2026-11-08-router-config-ui.md`.
9. **Scope.** Classifier, integrations, exclude and the compaction switch now
   (chosen); `providers` and the other `model_groups` keys in a separate plan,
   or all at once (complete, but a much larger rename).
10. **Timing.** The renames before the 2.0.0 tag (chosen: a 2.0 change belongs
    with the 2.0 breaking changes); the command, menu and reference phases
    could have followed the tag, and landed before it.

## Decision

1. **One block.** Classifier settings live in a `classifier` block:
   `classifier.local.{model,fallback}`, `classifier.cloud.{enabled,model,candidates,escalate_low_confidence}`,
   `classifier.log.{enabled,store_text,max_bytes,keep}`. Pre-2.0 names are read
   for one release, with a warning; a new-style key wins over an old one in the
   same layer. For these keys this replaces the "no read alias" Decision V2 of
   the fallback-naming plan (`docs/plans/2026-10-25-fallback-naming.md`) with a
   one-release read, because a dropped cloud switch would change where prompts
   go without a word. The shipped config names no model (ADR 0025).
2. **One key table** (`src/config-keys.ts`) describes every user-visible key:
   path, kind, allowed values, shipped value, meaning, pre-2.0 name, and how it
   may be changed (`set`, an alias subcommand, or hand-edit only). The block
   views, the guided menu and the generated reference read this table, and the
   command validates against it. The `/router config` usage and completions come
   from one subcommand list (`CONFIG_SUBCOMMANDS` in `src/commands.ts`), and the
   chain from `describeClassifierChain`.
3. **Validated writes.** `/router config set <path> <value>` and `unset <path>`
   write only `set`-keys and check the value against the table. A provider
   reference (`provider/id`) must resolve in pi's registry; an `ollama/<name>`
   reference is checked for its shape only. A write removes the pre-2.0 spelling of the
   same key from the user layer. The reply states the value in effect, a project
   layer that overrides it, and the classifier chain.
4. **The chain is computed, not described.** `describeClassifierChain(cfg)`
   returns the four legs in their fixed order. Static is never switched by
   config; it is reached only through `:use-static`.
5. **Guided menu in TUI mode only.** A bare `/router config` opens a menu over the
   keys the table marks `wizard`. Print and RPC mode never open a dialog; they
   print the overview and say why. Writes from the menu go through the same
   validation and write path as `set`, to the user layer only.
6. **Generated reference.** `docs/config-reference.md` is rendered from the table
   and the shipped config. A test fails when the committed file is stale. The
   prose documents keep the concepts (order, privacy, when cloud runs) and link
   to the reference for keys. The routing-flow diagram's node names are pinned
   to the chain step ids.

## Consequences

- Config keys are renamed once, in one place, with a warning for one release.
  The rename is a 2.0 change and lands before the 2.0.0 tag.
- Adding a key means adding a table entry. The table, the command, the menu and
  the reference then all follow; a key missing from the table cannot be set by
  the command.
- The guided menu covers only the `wizard` subset. Keys outside it are shown with
  their meaning and must be hand-edited, which is deliberate: the menu should not
  grow into a second editor for every setting.
- The generated reference covers the table keys. Non-classifier group keys and
  the rest of the top-level keys are still hand-documented in
  `docs/config-override.md` and are not in the table yet.

## Open

- The guided menu does not point to the Laya model artifact plan when no weights
  are installed (plan item 15, "may"). The integration reply already states when
  a switch is not in effect.
- Keys outside the classifier, integration and exclude scope (`providers`, group
  keys, `delegation`) are not in the table; they are out of scope of this ADR.
