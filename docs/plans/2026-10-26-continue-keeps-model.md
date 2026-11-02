# `continue` keeps the model, not only the category

**Status:** approved 2026-10-26 (owner decision, rationale: cache efficiency).
Not started. Step 1 (measurement) is open: the first run on 2026-10-27 is not
reproducible, see `docs/research/2026-10-27-continue-switch-measurement.md`.

**Verified against:** `laya-spike` at `492243f` — `src/stream-orchestrator.ts`
(`:332-358` tool follow-up, `:403-407` classifier context, `:604`
`lastDynamicModel` assignment) and `src/content-classifier.ts`
(`inheritPreviousCategory`, `:595-612`). Not verified: how often a
`continue` turn lands on a different model than the turn before it (Step 1
measures it).

**Related:** `docs/plans/2026-10-25-category-group-mismatch.md` (D6: the
catch-all group for `continue` without a predecessor);
`docs/plans/2026-10-25-laya-sole-classifier.md` (Step 6: whether the
`continue` inheritance is what the traffic needs).

## Problem

A `continue` prompt ("ok", "go on") means: nothing new, keep going. Today the
router honours that for the **category** only: `inheritPreviousCategory`
replaces `continue` by the previous category, the category selects a group,
and the group is **ranked again** on every turn. Health demotion, pacing, the
quality window and cost ties can move the ranking between two turns, so the
conversation can switch models although the user said nothing new. A model
switch starts from a cold cache — a prompt cache belongs to one model — so
the whole context is paid at the uncached price once. Cache efficiency is the
owner's stated reason for this plan; its size is not measured here (Step 1
measures the switch frequency, not the cost).

Tool follow-up steps already avoid this: `lastDynamicModel` is put first in
the candidate list (`stream-orchestrator.ts:352`). `continue` turns do not.

## Solution

On a `continue` turn that inherited a category, put `lastDynamicModel` first
in the candidate list when it is still a member of the inherited group's
candidates and is usable now (not rate-limited, breaker closed). The rest of
the list stays the group's ranking, so the failure cascade is unchanged. If
the previous model is not usable, or the group does not contain it, the
normal ranking applies.

Nothing else changes: a new category, a HINT or a compaction turn route as
today.

### Steps

1. **Measure** from the router log and the decision log: share of `continue`
   turns whose selected model differs from the previous turn's, split by
   cause (ranking change, limit, breaker). Result goes to `docs/research/`.
   If the share is negligible, say so and decide with the owner whether the
   change is still worth its code.
2. **Red-first test** with synthetic data: two consecutive turns, the second
   a `continue`, the group ranking flipped between them — the second turn
   must keep the first turn's model; and a limited previous model must not
   be kept.
3. **Implementation** next to the tool follow-up path, sharing the
   "usable now" check instead of copying it.
4. `npx tsc --noEmit`, `npx vitest run`, coverage thresholds unchanged,
   `npm run build`.

## Open decisions (owner)

- **S1:** only `continue`, or every turn that stays in the same group? The
  owner decided `continue`; the broader rule is noted only because the same
  cache argument applies.
- **S2:** a previous model that is `usable` but now ranks far below the
  group's best (the quality window moved): keep it anyway, or leave when the
  gap exceeds a limit? Proposal: keep — cache stability was the stated
  reason.
- **S3:** the first prompt of a session has no previous model; D6 of the
  group plan covers that case (`standard`).

## Risks

- A sticky model can outlive a quality reason to leave it (a better model
  appears mid-session). Accepted by the owner for cache's sake; S2 is where
  that is revisited.
- The `continue` turn must not hide a real topic change. That is the
  classifier's job (the `continue` precision question in the Laya plan, Step
  6), not this plan's.
