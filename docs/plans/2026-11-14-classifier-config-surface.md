# Classifier configuration: one surface, names that say what happens

**Status:** proposed 2026-11-14 — not started; waiting for the owner decisions below.

**Related plans (not this problem):** `2026-11-08-optional-integrations-config.md`
(done 2026-11-12) owns the `integrations.*` contract and the Laya block; this plan
does not touch it. `2026-11-08-router-config-ui.md` (proposed) owns the interactive
UI; this plan only provides the shape it would edit. The context budget and
compaction settings belong to Phase 5b of `2026-10-05-task-type-balancing.md`.

## Problem

The classifier is configured from several places, and its key names state the
wrong order.

1. **Three locations for one component.** The classifier keys sit on
   `model_groups.dynamic`: `classifier_model`, `classifier_fallback`,
   `classifier_no_schema`, `classifier_cloud_model`, `classifier_cloud_candidates`,
   `classifier_cloud_chain`, `classifier_escalate_low_confidence` (`src/types.ts:175-213`).
   The logging is top-level (`classifier_log`, `src/types.ts:354`), and Laya is
   under `integrations.laya` (`src/types.ts:360`).
2. **The name `classifier_cloud_chain` reads as an order and is an on/off switch.**
   The order is fixed in code: local first, then cloud, then static
   (`src/content-classifier.ts`, `classifyViaLlmChain`). On 2026-11-14 the owner
   asked what `classifier_cloud_chain: true` next to "local first" means. The
   answer had to be given in prose, and the README needed a paragraph to say it.
3. **Each new knob adds a flat key.** Since 2026-11-14 three more were added
   (`classifier_cloud_candidates`, `classifier_escalate_low_confidence`, and the
   pin `classifier_cloud_model` before them). Nothing shows a user the chain that
   results from these keys.
4. **Renames have a migration path, new keys do not.** `RENAMED_CLASSIFIER_KEYS`
   (`src/config-loader.ts:256`) maps old names to new ones with a warning. The
   integrations block gets unknown-key warnings from its schema; the classifier
   keys get neither check.
5. **The only copy of the chain is prose.** The README privacy section, PI.md,
   `docs/routing-flow.md` and `docs/config-override.md` each describe the order
   by hand. They already drifted once (2026-11-14 docs sync).

## Solution

One `classifier` block, read by the same loader rules as `integrations`.

```jsonc
"classifier": {
  "local":  { "model": "…", "fallback": "…", "no_schema": false },
  "cloud":  { "enabled": true, "model": "…", "candidates": [], "escalate_low_confidence": false },
  "log":    { … }                         // moved from top-level classifier_log
}
```

1. **Schema and types.** Add the `classifier` block to `Config` and to the
   hand-maintained schema. The existing test that the schema matches `Config`
   must cover it. Red first: a test that loads the block and expects `cloud.enabled`.
2. **Loader.** Map each old key to its new place with the existing warning
   mechanism (`RENAMED_CLASSIFIER_KEYS`). Add unknown-key warnings for the
   `classifier` block, so a typo is reported, not ignored. Red first: a typo
   `cloud.enable` warns; `classifier_cloud_chain` maps to `cloud.enabled` and warns.
3. **Wiring.** `stream-orchestrator.ts` and `commands.ts` (the status line at
   `src/commands.ts:197`) read the block. The existing wiring tests in
   `test/orchestrator-hint-wiring.test.ts` are the pattern. Mutation check: a
   reader still on an old key must turn a test red.
4. **Shipped config.** `router-config.json` moves its one key
   (`classifier_cloud_chain: true`) to `classifier.cloud.enabled: true`. No model
   name enters the shipped block (AGENTS §9); `cloud.candidates` stays empty.
5. **One chain description.** The chain is generated from the config, once, for
   `/router config`. The prose in README, PI.md and the routing docs keeps the
   order and points to `/router config` for the live view. Drift becomes a test
   failure, not a review finding.
6. **Docs and CHANGELOG.** The breaking-looking rename is documented as a
   migration, with the warning text quoted.

## Open decisions (owner)

1. **Shape.** Nested `classifier` block (recommended) or keep flat group keys
   with better names?
2. **Scope.** One global `classifier` block (recommended: only the `dynamic`
   group classifies today), or one per dynamic group?
3. **Migration.** Read the old keys for one release with a warning
   (recommended, the existing pattern), or fail hard at 2.0.0?
4. **Name of the switch.** `classifier.cloud.enabled` (recommended) or keep
   `classifier_cloud_chain` and only document it?
5. **Timing.** Before the 2.0.0 tag (recommended: user layers would break after
   release, the same reasoning as the integrations rename). The tag itself stays
   the owner's call (AGENTS §1).
6. **Live chain view.** Ship the generated `/router config` view in this plan
   (recommended, it is what makes the chain visible), or leave it to the config UI plan?

**Out of scope, tracked in TODO.md:** whether cloud candidates should be limited
to free models (eligibility rule, not configuration surface).

## Verified against

Commit `3f243cb` on `docs/sync-with-behavior`. Checked by reading the code:
the classifier keys and their line numbers in `src/types.ts`, the rename map in
`src/config-loader.ts:256`, the shipped `dynamic` group (`router-config.json`:
`{method, classifier_cloud_chain: true}`), and the readers in
`src/stream-orchestrator.ts` and `src/commands.ts:197`. Not checked: a full list
of every reader of the flat keys, and the state of the owner's user layer
beyond the shipped file. Step 3 starts with that grep.
