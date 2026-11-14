# 0034 — One config surface: a classifier block, a key table, validated writes, a generated reference

## Status

Accepted (2026-11-15, owner decision, config plan
`docs/plans/2026-11-14-config-surface-and-ui.md`). Builds on ADR 0032 (local-first
chain) and ADR 0033 (opt-in escalation), which are not changed. Settles the
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

## Decision

1. **One block.** Classifier settings live in a `classifier` block:
   `classifier.local.{model,fallback}`, `classifier.cloud.{enabled,model,candidates,escalate_low_confidence}`,
   `classifier.log.{enabled,store_text,max_bytes,keep}`. Pre-2.0 names are read
   once for one release, with a warning; a new-style key wins over an old one.
   The shipped config names no model (ADR 0025).
2. **One key table** (`src/config-keys.ts`) describes every user-visible key:
   path, kind, allowed values, shipped value, meaning, pre-2.0 name, and how it
   may be changed (`set`, an alias subcommand, or hand-edit only). The
   `/router config` usage, its completions, its overview and the guided menu are
   generated from this table, so they cannot disagree.
3. **Validated writes.** `/router config set <path> <value>` and `unset <path>`
   write only `set`-keys, check the value against the table, and check a model
   reference against pi's registry. A write removes the pre-2.0 spelling of the
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
