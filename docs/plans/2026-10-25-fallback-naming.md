# "fallback" — one word, too many meanings

**Status:** approved 2026-10-26 with a reduced scope (owner decisions
below). Nothing is renamed yet. Opened 2026-10-25 as an owner request: the
many meanings of "fallback" are a code smell.

**Verified against:** `origin/main` 6f4ac08 and the laya-spike line
(`feat/laya-active-snapshot`) on 2026-10-25 — counts by `grep -i
fallback`; per-meaning classification by reading each use site.

**Related:** `docs/plans/2026-10-25-category-group-mismatch.md` decides
which groups exist; it removes the group `fallback` (meaning A below, its
decision D4). This plan only follows that decision.

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

## Owner decisions (2026-10-26)

The test for a name: "fallback" must mean *everything I tried failed, now
something else*. Where a name says exactly that, it stays.

| Meaning | Verdict |
|---------|---------|
| F — stream-level retry | honest, stays |
| B — failure cascade `fallback_groups` | honest, stays |
| C — local second classifier (`classifier_fallback`, `fallbackModel`, `fallbackTimeoutMs`) | honest, stays |
| C — static classifier (`allowStaticFallback`) | honest, stays |
| D — decision-log stage `fallback` (no classifier answered) | honest, stays |
| C — cloud chain (`classifier_cloud_fallback`, `allowCloudFallback`, `classifier-fallback-probe.ts`, `classifier_fallback_models`) | **dishonest**: main path since 2026-09-27, background comparator next to Laya since 2026-10-25 → rename |
| E — retired category `fallback` | **dishonest**: a label of a dead thing, not an event → delete the remnants |
| A — group `fallback` | **dishonest**: a pool, not an event → disappears: the group plan merges it into the cheapest group (its D4); the three exits (unresolved target, classification failure, unknown category) point there |
| G — ordinary English | untouched |

ADRs are immutable (AGENTS.md §12): this plan does not touch or annotate any
ADR, `docs/adr/0001` included.

## Solution

1. **Characterization tests** for the literal `'fallback'` exits (unresolved
   target, classification failure, unknown category, tool follow-up). They
   are Step 1 of the group plan; this plan does not duplicate them.
2. **Round 1 — dead vocabulary (E):** delete the category remnants in
   `src/`, tests and comments (`commands.ts` text included); the legacy
   label survives only in data tooling, named `legacy_fallback`. Red-first:
   a taxonomy test that fails while code still accepts `fallback` as a
   category.
3. **Round 2 — cloud chain (C):** rename the identifiers, the probe file and
   the two cache keys (read both, write new) and the config keys. Touches
   `content-classifier.ts`; sequence it after the Laya verdict, because the
   Laya branch changes the same file. Red-first: a test that the new key is
   read and the old string is handled per the alias decision (V2).
4. **Verification per round:** `npx tsc --noEmit`, `npx vitest run`,
   coverage thresholds unchanged, `npm run build`, plus a ratchet test: a
   new identifier containing `fallback` fails unless it belongs to an
   honest meaning above or to category G.

## Open decisions (owner)

- **V1:** the new name of the cloud chain. Proposal: config
  `classifier_cloud_chain`, `allowCloudChain`, file
  `classifier-cloud-probe.ts`, cache key `classifier_cloud_models`.
- **V2:** aliases for the renamed config keys. The group plan decided "no
  read-aliases in 2.0" for groups (its D3); confirm that this applies to the
  cloud-chain keys too, or ask for a warning alias.
- **V3:** when the rename ships (a release decision, AGENTS.md §1).

## Risks

- Python tooling in `~/.laya-ft` reads stage strings and the legacy
  category → update it in the same round as E, with its own test.
- Silent behaviour change if a literal `'fallback'` is renamed in one place
  and not another → the Step 1 pins plus the ratchet test.
- Merge conflicts with the Laya branch in Round 2 → sequencing above.

## Not in scope

The Laya/`continue` analysis (`docs/plans/2026-10-25-laya-sole-classifier.md`).
`continue` keeps its owner-defined meaning: the model cannot tell whether the
task changed, so the previous category stays.
