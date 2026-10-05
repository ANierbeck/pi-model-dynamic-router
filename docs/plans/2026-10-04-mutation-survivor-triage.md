# Mutation Survivor Triage Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Turn the first nightly mutation report (1670 mutants, 56.4% score, 468 survivors + 260 no-coverage in the decision core) into (a) a repeatable operating model for every future nightly run and (b) concrete test/code cleanups — then decide Phase 2 scope on evidence.

**Architecture:** Triage is time-boxed and class-driven, not survivor-by-survivor guilt. Every survivor gets one of four verdicts (REAL GAP → red-first test; EQUIVALENT → ledger; DEFENSIVE/FAILOPEN → document; DEAD CODE → remove). The score is never the KPI — "real vacuity found per triage hour" is. Report-only stays report-only; no break threshold until the cleaned baseline exists.

**Tech Stack:** Stryker HTML/JSON report (nightly artifact), vitest, the existing spot-campaign for invariant-level regression.

---

## Data baseline (report #1, 2026-10-04, run 125.5 min)

| File | Score | Killed | Survived | NoCoverage |
|---|---|---|---|---|
| src/metrics.ts | 55.7% | 389 | 219 | 91 |
| src/routing.ts | 57.0% | 553 | 249 | 169 |

Survivor hotspots (line buckets): routing 600–750 (77 — cooldown/cost-window
region), routing 1000–1099 (30), metrics 900–1000 (42 — registryCost/
lookupPrice region), metrics 100–350 (86 — model-map / alias index).
Mutator classes: ConditionalExpression 263, EqualityOperator 93,
StringLiteral 84, BlockStatement 64, LogicalOperator 51.

**Interpretation:** the spot campaign (9/9 invariant kills) and this report
agree — invariants are pinned, branch detail is not. This is normal for a
suite grown red-first incident-by-incident; the survivors are the long tail.

---

## Part A — Operating model (how every future nightly run is handled)

### A1. Morning triage routine (10 min, only when decision-core code changed)

1. Check the run summary (job summary shows score + per-file survivors;
   the incremental cache makes no-change nights near-free — skip triage
   when nothing in `src/metrics.ts`/`src/routing.ts` changed).
2. New survivors vs. the ledger (Task 1) are the ONLY work items — a
   survivor already in the ledger with a verdict stays parked.
3. New REAL-GAP survivors become §4 work: red-first test, PR, merge. Batch
   them with whatever feature branch is open (§5) or a dedicated
   `test/mutation-gap-<topic>` branch.

### A2. Verdict rules (a survivor is classified, never ignored)

| Verdict | Meaning | Action |
|---|---|---|
| REAL GAP | flipping the mutant changes behavior a user or routing decision could observe | red-first test (§4) |
| EQUIVALENT | mutant is behavior-identical (e.g. `?? ''` where `''` is already the fallback) | ledger entry, one-line rationale |
| DEFENSIVE/FAILOPEN | error path whose exact wording/shape no caller depends on | ledger, unless it masks a REAL GAP behind it |
| DEAD CODE | no test reaches it because nothing can | remove it (§7) — never leave it |

Ledger: `docs/mutation-triage.md` — table per survivor id (or tight line
cluster), verdict, one-line rationale. Committed in the triage PRs.

### A3. Standing rules

- **The score is not a KPI to game.** No wholesale `excludedMutations` to
  inflate it; StringLiteral survivors get looked at once (the sample shows
  real ones exist: `roundrobin` handling), then bulk-ledgered.
- **No break threshold** until the post-cleanup baseline exists (Task 5).
  Then optionally set `break` just under the cleaned score so regressions
  scream while equivalent-mutant noise does not.
- **Nightly stays report-only** — findings never gate PRs (pinned by
  contract test).
- Timeout budget stays generous (0 timeouts in run #1 at 30 s — correct).

---

## Part B — Triage of report #1 (the executable work)

### Task 1: Create the triage ledger

**Files:** Create `docs/mutation-triage.md`; reference this plan.

Steps: create ledger with the four verdict sections and the report-#1
baseline numbers; commit on a `mutation-triage` branch. (~15 min)

### Task 2: Hotspot batch 1 — routing 600–750 (cost window / cooldown, 77 survivors)

**Files:** Test: `test/consolidated-routing-cache-pins.test.ts` or a new
`test/mutation-gap-cost-window.test.ts` (one topic file per batch,
consistent with PR #16 policy).

Steps: open the local report (`/tmp` artifact copy or re-download) for
lines 600–750; classify each of the 77 survivors per A2; for every REAL
GAP write the red-first test FIRST (it must fail against the mutant —
verify by temporarily applying the mutation, mirroring
`scripts/mutation-spot-campaign.sh`), then commit test + ledger entries.
Budget: one 90-minute session; park the rest in the ledger as UNTRIAGED.
(~90 min)

### Task 3: Hotspot batch 2 — metrics 900–1000 (pricing lookup, 42 survivors)

Same steps as Task 2, focused on `registryCost`/`orFallbackPrice`/
`lookupPrice`/`lookupListPrice` fallback branches. Expected: many
EQUIVALENT (defensive `typeof` guards), some REAL GAP in the OR-backfill
matching (`norm` variants). (~60 min)

### Task 4: Hotspot batch 3 — metrics 100–350 (model-map / alias index, 86 survivors)

Same steps. Expected: alias/twin-slug branches (`scores[twin] ===
scores[key]` showed up in the sample) — mostly REAL GAP, small tests. (~90 min)

### Task 5: No-coverage sweep (260 mutants)

**Files:** src only where DEAD CODE verdicts land.

Steps: list the no-coverage clusters by enclosing function
(`detectGroup` 42, `applyGroupFilters` 26, `effCost` 25, `updateMetrics`
24, `resolve` 24, `getTopModels` 23 …); for each cluster decide: untested
branch → test if cheap, ledger as DEFENSIVE if the branch is a documented
fail-open; unreachable → remove (§7). Do NOT chase 260 individually —
cluster verdicts cover whole branches at once. (~2 sessions à 90 min)

### Task 6: Re-measure and close report #1

Steps: trigger the workflow via `workflow_dispatch` (or wait for the
nightly); compare score; record the post-triage baseline in the ledger;
estimate remaining UNTRIAGED; if the remaining density is low (score ≥ ~80%
after cleanup), report #1 is closed. (~15 min + run)

### Task 7: Phase 2 decision (owner gate)

Present to the owner: real-gaps found per triage hour, remaining
equivalent-mutant share, post-cleanup score, runtime cost (125 min cold /
near-free warm). Decision: (a) extend `mutate` to the next core file
(`src/stream-orchestrator.ts` is the natural candidate), (b) stay at
decision core + spot campaign, or (c) stop nightly and keep the spot
campaign. Any extension updates `test/mutation-nightly-config.test.ts`
red-first.

---

## Success criteria

- Every survivor of report #1 carries a verdict (ledger), and every REAL
  GAP has a red-first test that kills its mutant.
- The operating model (Part A) is in the ledger header — future runs are
  triaged by routine, not by archaeology.
- Phase 2 decision is made on measured yield, not vibes.
