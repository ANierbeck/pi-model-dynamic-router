# Mutation triage of the stream orchestrator after the Laya merge

**Status:** in progress 2026-11-04. Slice 1 done 2026-11-04: `groupStream`, 272 undetected mutants → 257 killed by `test/orchestrator-hint-wiring.test.ts`, 15 ledgered as equivalent. Slices 2–3 open (391 undetected mutants).

AGENTS.md §11: one problem per plan. This is the owner-mandated round of 2026-10-15 ("do this first after laya-spike merges", TODO.md): the most consequential selection code in the router has the weakest mutation coverage. The verdict ledger stays `docs/mutation-triage.md`; the numbers of this round are in `docs/research/2026-11-04-orchestrator-mutation-r4.md`.

## Problem

Nightly R4 (run 41817385588, `main` at `fde54f8`, the first nightly after the merge and the hygiene PRs): `src/stream-orchestrator.ts` has 1084 mutants, 420 killed, **663 undetected** (449 survived, 214 without any test coverage), score 38.7 %. `src/metrics.ts` (76) and `src/routing.ts` (77) are the already-triaged remainders (equivalents, ledgered). The 663 split into:

| region | lines | undetected |
| --- | --- | --- |
| `groupStream` (classification wiring, explicit HINT group/model, escalation, tool follow-up) | 305–643 | 272 |
| `driveStream` (candidate cascade, wait guards, collapse, breaker probe, failure observation) | 644–1347 | 337 |
| helpers (`openCandidateAttempt`, `extractContextWindowFromError`, breaker narration) | 49–180 | 49 |

The explicit `HINT:` the owner uses every day (`HINT: <model>`, `HINT: <group>`) had no test that drove it through the orchestrator: lines 423–580 were almost entirely `NoCoverage`.

## Solution

Red-first-by-mutant, region by region, through the real `StreamOrchestrator` (no mutant-by-mutant micro tests). Every slice: tests first, then `scripts/mutation-recheck.ts --tests <new files>` against the pristine report tree (`fde54f8`, a git checkout) so each claimed kill is observed on the mutated tree and confirmed alone; survivors get a verdict in the ledger (equivalent with a reason, dead code removed per §7, or a follow-up).

1. **Slice 1 — `groupStream`** (done). Explicit HINT (group, model), the classifier call wiring, escalation, the tool follow-up, group-name parsing. `test/orchestrator-hint-wiring.test.ts`.
2. **Slice 2 — `driveStream` cascade.** Wait-for-reset guards, observeFailure branches, collapse and breaker-probe narration, context-overflow skips. Scope depends on the outcome of `docs/plans/2026-11-04-virtual-models-routing.md`: behaviour that plan would replace is pinned by characterisation only, not polished.
3. **Slice 3 — helpers and residue.**

## Open decisions (owner)

1. **Slice 2 depth.** The cascade is also the code the Virtual Models spike may replace. Proposal: slice 2 only pins the behaviours the spike's inventory needs (they double as its test set) and does not chase equivalents.
2. **Log-text mutants.** Router log lines are observability, not behaviour. Proposal: pin the log lines that name a decision (`HINT group not found`, `[escalation] Using escalated group`, `skipping unusable refs`, `HINT fallback candidates`) and ledger the rest as equivalent.

## Verified against

`main` at `fde54f8` (report and pristine tree), nightly R4 report downloaded 2026-11-04. Checked: the undetected-mutant inventory by region and line (this plan's table is computed from `mutation.json`), the `groupStream` source lines 305–643, the recheck tooling (`scripts/mutation-recheck.ts`), existing coverage of the HINT path (none in the orchestrator).

**Not checked:** the 49 helper mutants and the 337 `driveStream` mutants individually; whether a full-suite recheck (not just the new file) finds additional false survivors in `groupStream` (R3 found 8 of 743); the interaction of these tests with the sub-call scope fix, which changes a few lines of the same file on a branch.
