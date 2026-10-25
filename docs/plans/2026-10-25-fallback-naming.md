# "fallback" — one word, too many meanings

**Status:** proposed 2026-10-25 (owner request: the many meanings of
"fallback" are a code smell — investigate separately). Nothing is renamed
yet; Step 1 needs the owner's vocabulary decision.

**Verified against:** `origin/main` 6f4ac08 and the laya-spike line
(`feat/laya-active-snapshot`) on 2026-10-25 — counts by `grep -i
fallback`; per-meaning classification by reading each use site.

**Related:** `docs/plans/2026-10-25-category-group-mismatch.md` decides
which groups exist and what they are called; the group `fallback` and
`fallback_groups` (meanings A and B below) are named here, not there.

## Problem

`fallback` appears 334 times in `src/` + `index.ts`, 28 times in the shipped
`router-config.json`, 698 times in `test/`, 648 times in `docs/` + README. It
names at least six different things. The collisions have already cost us
twice: the shadow evaluation had to exclude legacy `fallback` records by hand
(they are not a category any more), and "60 % of turns = fallback" in the
2026-10-05 analysis meant the retired *category*, while the owner read it as
"the model of the last round".

## Inventory (measured 2026-10-25)

| # | Meaning | Where it lives | Names |
|---|---------|----------------|-------|
| A | **Model group** `fallback`: "Any available, cheapest first", `max_cost: 0`, last-resort pool | `router-config.json`; literals in `stream-orchestrator.ts` (follow-up group, unresolved target, classification-failure route), `routing.ts` (`FALLBACK_GROUP_ORDER` tail, tier scan), `content-classifier.ts:1306` (default group for an unknown category), `tools.ts` (tool description) | group name `'fallback'` |
| B | **Failure cascade between groups**: the next group to try when every candidate of a group failed | `fallback_groups` (37 uses; 11 of 13 shipped groups list the group `fallback` in it), `FALLBACK_GROUP_ORDER`, `getFallbackGroup`, `computeFallbackGroups` (its own doc calls it "escalates before it degrades"), `hintFallbacks` | config key + 5 identifiers |
| C | **Classifier's extra candidates**: three different things under one word — the local second model (`classifier_fallback`, `fallbackModel`, `fallbackTimeoutMs`), the cloud chain (`classifier_cloud_fallback`, `allowCloudFallback`, `callCloudFallback`, probe cache `classifier_fallback_models`), and the static keyword classifier (`allowStaticFallback`) | `types.ts`, `content-classifier.ts` (60 hits), `classifier-fallback-probe.ts`, `classifier-local-probe.ts`, `local-llm.ts`, `commands.ts`, `index.ts` | ~25 identifiers, 3 config keys, 1 file name, 2 cache keys. The file is called "fallback probe" although the cloud chain has been the *primary* path since 2026-09-27 |
| D | **Decision-log source** `fallback`: no classifier answered (`continue`, confidence 0); also the default stage when no source was noted | `content-classifier.ts:563, 1097`, doc comments, `classifier-decision-log.ts`, the shadow-eval tooling | stage string |
| E | **Retired category** `fallback` (replaced by `continue` in v2-r3, 2026-10-13) | remnants: tests (`fallback-inherits-category.test.ts`, 11 test files mention it), `docs/adr/0001`, comments, `commands.ts` ("60 % fallback"), legacy decision-log records, `~/.laya-ft` label mapping (`fallback → None`) | dead vocabulary |
| F | **Stream-level retry**: try the next candidate / cascade on rate limit or empty response | `stream-proxy.ts`, `stream-orchestrator.ts` (`tryFallback`, `fallbackCandidates`, `fallbackError`) | local identifiers |
| G | **Ordinary English** "fall back to X" for lookups and defaults | `metrics.ts` (GDPval token-set fallback, `SUBSCRIPTION_FALLBACK_COST`), `model-matcher.ts`, `scan-runner.ts`, `positiveInt(v, fallback)`, `ollama-utils.ts` | prose / parameter names — mostly fine |

A, B and F are the same idea at three scales (group, cascade, candidate);
C is a different idea (classifier candidates) that borrowed the word; D and E
are *labels about a classification* that borrowed it; G is harmless.

## Solution

### Principles

1. One word, one meaning. After the round `fallback` must not name an entity
   (group, config key, stage, category, file) in two senses.
2. Public surface is a contract: `fallback_groups`, `classifier_fallback`,
   `classifier_cloud_fallback` and the group name `fallback` appear in users'
   `router-config.user.json` files. A rename ships with a read-alias that
   warns, and the owner decides when the alias is dropped.
3. Characterize before renaming (§4): the literal `'fallback'` paths are
   behaviour (unresolved target → pool, classification error → pool, unknown
   category → pool). Pin them with tests that pass on today's code, then
   rename and keep them green.
4. Old data stays readable: decision-log records and the scan cache keep
   their old strings; readers accept both.
5. Category G is left alone except where a name collides with A–F.

### Proposed vocabulary (proposal — see Open decisions)

These are proposals, not decisions.

| Today | Proposal | Reason |
|-------|----------|--------|
| group `fallback` (A) | `last_resort` | says what it is: any available model, cheapest first |
| `fallback_groups` (B) | `failover_groups` | "what comes next after failure"; `escalation` is taken by the session escalation module |
| `classifier_fallback` (C, local 2nd model) | `classifier_local_backup` | only the local second model |
| `classifier_cloud_fallback` / `allowCloudFallback` (C) | `classifier_cloud_chain` / `allowCloudChain` | it is the primary path now, not a fallback |
| `classifier-fallback-probe.ts`, `classifier_fallback_models` (C) | `classifier-cloud-probe.ts`, `classifier_cloud_models` | |
| `allowStaticFallback` (C) | `allowStaticClassifier` | |
| decision-log stage `fallback` (D) | `unclassified` | no classifier answered |
| category `fallback` (E) | delete remnants; legacy label only in data tooling, named `legacy_fallback` | |

Open sub-question: should `fallback_groups` and the group `fallback` keep
their names because they are the one honest "fallback" in the system? The
alternative is to keep exactly those two and rename C–E. Smaller change,
less user-config churn.

### Steps

1. **Vocabulary decision** (owner). Output: the table above, amended.
2. **Characterization tests** for the literal paths (A): unresolved target,
   classification failure, unknown category, follow-up group, tier scan. They
   must pass on today's code (no red expected: nothing changes yet; stated
   explicitly per §4).
3. **Round 1 — dead vocabulary (E, D)**: delete or rename the remnants,
   stage `fallback` → `unclassified` with both readers accepting both
   strings (log analysis in `~/.laya-ft` and `scripts/laya-shadow-stats.ts`).
   Red-first: a test that the new stage string is written, and one that old
   records still parse.
4. **Round 2 — classifier names (C)**: internal identifiers, the probe file,
   the two cache keys (read both, write new), and the three config keys with
   warning aliases. Touches `content-classifier.ts`, which the Laya branches
   also change — sequence after `fix/classifier-paid-guard-429-body` and
   `feat/laya-active-snapshot` have landed or been dropped.
5. **Round 3 — group and cascade (A, B)**: only if the vocabulary decision
   renames them. Group rename needs a config migration for user layers
   (backup, mode 600) and alias handling in `model_groups` lookup.
6. **Docs sweep**: README, ADRs (historical ADRs get a pointer, not an edit),
   CHANGELOG with an explicit "renamed" section.
7. **Verification per round**: `npx tsc --noEmit`, `npx vitest run`,
   coverage thresholds unchanged, `npm run build`, and a grep gate: a test
   that fails when a new identifier containing `fallback` appears outside
   category G's allow-list (ratchet, like `no-hardcoded-models`).

## Open decisions (owner)

- **V1:** the target vocabulary (table above), amended as the owner sees fit.
- **V2:** keep `fallback` (group) and `fallback_groups` as the one honest
  "fallback" and rename only C–E — or rename A and B too.
- **V3:** when read-aliases for renamed public config keys are dropped
  (a release decision, AGENTS.md §1).

## Risks

- Config breakage for installed users → read-aliases with warnings; release
  note; the release itself stays the owner's decision (§1).
- Merge conflicts with the Laya branches (Round 2) → sequencing above.
- Python tooling in `~/.laya-ft` reads stage strings and the legacy
  category → update in the same round as D, with its own test.
- Silent behaviour change if a literal `'fallback'` is renamed in one place
  and not another → Step 2 characterization tests plus the grep gate.

## Not in scope

The Laya/`continue` analysis (`docs/plans/2026-10-25-laya-sole-classifier.md`
on branch `feat/laya-active-snapshot`).
`continue` keeps its owner-defined meaning: the model cannot tell whether the
task changed, so the previous category stays.
