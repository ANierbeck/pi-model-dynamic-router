# Repo hygiene: clean up the layout and stop redundancy from growing back

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** A repository where every file has one obvious home and one owner, and where redundancy in code, docs and tests is measured and ratcheted down instead of noticed by eye.

**Architecture:** Measure first with one dependency-free script, then clean in small independent phases (each its own PR), and pin the result with a ratcheting gate (same pattern as `scripts/hardcoded-model-baseline.json`). The plan is written so a fresh session can run it cheaply — see "Execution protocol".

**Tech Stack:** TypeScript scripts run with `node scripts/*.ts`, vitest, the existing Stryker nightly JSON report. No new dependencies (AGENTS.md §10).

---

**Status:** approved in part 2026-10-29 (owner decisions 1–5 below; decision 6 open). No phase started. Tick the boxes below as phases land; do not append narrative (AGENTS.md §11).

**Verified against:** commit `f86846a` (branch `feat/five-groups`, not pushed), measured 2026-10-29. Checked: file counts, sizes, git-tracked status, the `files` list and build script in `package.json`, cross-references between root files (grep, excluding `node_modules`/`dist`/`.worktrees`), duplicate function names and test titles, repeated 6-line blocks across test files, full-suite runtime (13.8 s). **Not checked:** whether Pi really loads `CLAUDE.md` into every session (AGENTS.md says so; the session context shows only `AGENTS.md`), semantic overlap between `PI.md`, `SKILL.md`, `AGENT.md` and `README.md` (literal line overlap is low, 2–12 lines, so any overlap is topical and needs reading), whether the Stryker `mutation.json` carries `killedBy` per mutant in CI artifacts (config has `coverageAnalysis: perTest` and the `json` reporter, so it should).

## Problem

The repository has grown by accretion. Measured:

| Area | State |
|---|---|
| Root | 13 Markdown files at the top level, 9 of them beyond `README`/`AGENTS`/`CHANGELOG`/`RELEASE_CHECKLIST`-style essentials: `AGENT.md`, `CLAUDE.md`, `PI.md`, `SKILL.md`, `FINAL_SUMMARY.md`, `IMPLEMENTATION_SUMMARY.md`, `AUDIT_PLAN_800_TESTS.md`, `RELEASE_CHECKLIST.md`, `TODO.md` (835 lines). Three git-ignored leftovers sit next to them (`archive/`, a `.tgz`, `v1.6.0-changes-local.md`). Three of the tracked ones (`FINAL_SUMMARY`, `IMPLEMENTATION_SUMMARY`, `AUDIT_PLAN_800_TESTS`) are finished work reports referenced only by each other. |
| Shipped docs are stale | `package.json` `files` ships `PI.md` and `skills/`. `PI.md` still describes the old 13-group layout (`strategic`, `operational`, `scout`, `tactical`, `fallback group`: 21 lines); `skills/*/SKILL.md` has 17 such lines; `README.md` has 8 (some may be deliberate migration notes, to be classified). Users installing the package read documentation for groups that no longer exist. |
| Plans | 37 files in `docs/plans/`; 24 have no `Status` line (by a case-insensitive `^\*{0,2}status` match) although §11 requires one. Plus 11 loose files directly under `docs/` (three release plans, a log analysis, a review). |
| Tests | 205 files / 41.9k lines against 21.2k lines of `src` (ratio ≈ 2:1, up since mutation testing). Six `consolidated-*-pins` files hold 5.9k lines, one of them 3,017. 54 test files call `setConfig(`, 36 construct a `Router`, 24 repeat the same Ollama mock: set-up boilerplate, not logic. |
| Test titles | Only 4 titles are duplicated (9 tests of 2,147): literal duplication is *not* the problem. The 2026-09-20 consolidation found the same on 806 tests (5 real duplicates). Expect a low yield from title-level work. |
| Code | Real duplicates are small: `arg`, `isRecord`, `fmtTime`, `offsetOf`, `pct` redefined across scripts; five scripts each declare their own decision-log record type (`DecisionRecordLite`, `PairLogRecord`, `DecisionRecord`, `RawDecision`, `DecisionRow`) and their own JSONL reader. The three largest `src` files (1.4–1.5k lines) are a different problem, out of scope. |
| Nothing prevents regrowth | There is a ratchet for hard-coded models but none for stale docs, orphan files, duplicate helpers or test boilerplate. |

## Solution

1. **Measure** with one script (`scripts/redundancy-report.ts`): deterministic, ≤ 60 lines of output, no file reading by the agent needed.
2. **Clean** in six small phases, cheapest and most visible first. Every deletion cites evidence (§4: zero unique-coverage loss for tests; zero references for files).
3. **Pin** the result with a ratchet test: ceilings only shrink; a new root file, a stale group name in a shipped doc, or a new duplicate helper fails the suite.

Out of scope (own plans, §11): splitting the three 1.4k-line `src` files; the CHANGELOG format (136 KB, release history, left alone); the Laya and five-group work.

## Open decisions (owner)

**Decided 2026-10-29** (owner's words, paraphrased):
- Decision 2: `CLAUDE.md` **stays where it is** (root, local). It is not moved to `docs/`.
- Decision 3: `PI.md` **stays and is adapted** (Phase 2). The other root files follow the proposal.
- Decision 4: **yes**. In `AGENTS.md` the incident narratives are trimmed to one line and linked; the rules stay verbatim.
- Decision 5: **scripts are not adapted much**. No `scripts/` subfolder split; only the shared-helper consolidation in Phase 5 Steps 1–3.
- Decision 1: the branch `feat/five-groups` was merged into `laya-spike` on 2026-10-29 (fast-forward, suite green). Phases 1–3 still wait for the `laya-spike` → `main` merge, because they start from `main`.
- **Release gate for the Laya tooling (owner, 2026-10-29):** the Laya training tooling must not ship. Located 2026-10-29: the `/laya-label`, `/laya-sidecar` and `/classifier-replay` commands are Pi extensions in `~/.pi/agent/extensions/` (`laya-labeler`, `laya-sidecar-manager`, `classifier-replay`), outside the repo. They are not in the package: `npm pack --dry-run` lists 10 files, only the two skills, and `dist/index.js` contains none of the command names. The Laya *classifier* stage (`src/laya-classifier.ts`) does ship, by design. Gate: `npm pack --dry-run` must list only `skills/content-based-router` and `skills/router-login` as skill files (see Phase 2 Step 3a).

**Still open:** decision 6 (test deletion appetite).

Original proposals, kept for the record:

1. **Sequencing.** Start only after `feat/five-groups` is merged? Phases 1–3 move/delete files and would conflict with that branch's doc edits. Recommendation: yes, wait for the merge; Phase 0 (a new script and a new test) can start earlier.
2. **`CLAUDE.md`.** Its content is Claude-bridge model support, not agent rules. If Pi loads it every session, ~0.8k tokens of irrelevant text ride along every time. Recommendation: move it to `docs/claude-bridge.md`, keep a one-line pointer in `AGENTS.md`. ADRs that mention `CLAUDE.md` stay untouched (§12) and dangle harmlessly.
3. **`AGENT.md` / `SKILL.md` / `PI.md`.** Recommendation: keep `PI.md` (shipped user doc, rewrite to the five-group layout), fold the still-true parts of `AGENT.md` into `docs/architecture.md` and delete it, delete root `SKILL.md` if `skills/` already covers it (Phase 2 decides on a read, not a guess).
4. **`AGENTS.md` size (18 KB ≈ 4.6k tokens, loaded every session).** Trim incident narratives to one line and link `docs/`? §2 says rules live there, so this is a deliberate trade: fewer tokens per session against less rationale inline. Recommendation: trim only text that is *history* (the "Incident …" paragraphs), never the rules.
5. **Layout.** `scripts/` split into `scripts/ci/` (secret-scan, forbidden-patterns, kpi audit), `scripts/mutation/` (5 files), `scripts/analysis/` (log tools, Laya, pool, failover)? Needs `package.json`, two workflows, the pre-push hook and docs updated in the same commit. `test/` stays flat (205 files, prefix families already cluster; moving breaks every `../src/` import for no redundancy gain); `src/` stays flat. Recommendation: split `scripts/`, leave the rest.
6. **Test deletion appetite.** The mutation-pin files exist because each pin kills a survivor. Deleting a pin re-opens a survivor. Recommendation: merge and de-boilerplate, delete only tests that the Stryker report proves redundant (Phase 4).

## Execution protocol (read this first in the fresh session)

Goal: finish with the least context spent.

- **Load only:** this plan and `AGENTS.md`. Do not open `CHANGELOG.md` (136 KB), `TODO.md` (49 KB), `README.md` (56 KB) or any `docs/plans/*` whole. Ask questions about them with `bulk_read` (answers without loading the file) or `grep -c` / `head -20`.
- **Script before read.** Each phase starts with a command whose output is capped (`| head -40`). Decide from that output, not from opening files.
- **One phase = one branch = one PR.** Branch from the current `main`. End each phase with: `npx tsc --noEmit && npx vitest run` (the suite takes ~14 s, run it freely), tick the box here, commit the plan, push only on the owner's word (§1, §8 apply unchanged).
- **Resume rule.** A new session reads the `Status` line and the first unticked box, runs `git log --oneline -5`, and continues there. No re-analysis of finished phases.
- **No parallel subagents for the edits.** The phases touch overlapping files (docs, `package.json`, AGENTS.md); coordination costs more than it saves. Use one subagent for the pre-PR review (§1 skill), nothing else.
- **Bulk moves are scripted.** `git mv` plus a Python replace over the referencing files, then `grep` for the old name must return nothing. The agent never edits 20 files by hand.
- **Stop conditions.** If a phase's report shows < 5 actionable items, close it as "nothing to do" in one line and move on. If a deletion cannot be justified with a reference count or a coverage check, keep the file.

## Phases

### Phase 0 — Measure and gate (new script + ratchet test)

- [ ] **Step 1: Write the failing test** `test/redundancy-report.test.ts` for a pure `analyze(inputs)` function. Inputs are plain arrays (`{path, text}` for src/scripts/tests/docs, `{path, tracked}` for root files); no file system in the unit under test. Cases: duplicate function names across files are reported once with both paths; a 6-line block in ≥ 3 test files is counted; a stale group name (`strategic|operational|scout|tactical|fallback group`) in a *shipped* doc is a finding while the same word in `docs/adr/` is not; a root file absent from the allowlist is a finding; a plan without a `Status` line is a finding.
- [ ] **Step 2: Run it, expect FAIL** (`Cannot find module '../scripts/redundancy-report.ts'`). Record the red evidence in the commit body (§4).
- [ ] **Step 3: Implement** `scripts/redundancy-report.ts` (`analyze` exported; thin CLI reads the file system and prints ≤ 60 lines, counts first, top-10 lists after). Shipped docs = the `files` list of `package.json` plus `README.md`. Historical dirs (`docs/adr`, `docs/plans`, `docs/research`, `CHANGELOG.md`) are exempt from the stale-name rule.
- [ ] **Step 4: Gate.** `scripts/redundancy-baseline.json` with the counts measured now (stale names in shipped docs, root files outside the allowlist, plans without status, duplicate function names, repeated test blocks, test files with the Ollama-mock boilerplate). `test/redundancy-baseline.test.ts` fails when any count exceeds its baseline; the shipped-docs stale-name ceiling and the root-allowlist ceiling are pinned at the *target* (0) from Phase 2 and Phase 1 on, the others only ratchet. Never add an entry to make a PR green (same rule as §9).
- [ ] **Step 5: Commit** `feat: redundancy report and ratchet gate`. Suite green, ratchet in AGENTS.md §4 bumped.

### Phase 1 — Root and loose files

- [ ] **Step 1: Inventory** — `node scripts/redundancy-report.ts --root`. For each root file the report shows tracked/ignored, size, inbound references.
- [ ] **Step 2: Delete finished reports** (tracked, referenced only by each other): `FINAL_SUMMARY.md`, `IMPLEMENTATION_SUMMARY.md`, `AUDIT_PLAN_800_TESTS.md` (superseded by `docs/plans/2026-09-20-consolidate-tests.md`). `git rm`; history keeps them.
- [ ] **Step 3: Local leftovers** (`archive/`, the `.tgz`, `v1.6.0-changes-local.md`; all git-ignored): list them to the owner, delete only after a yes (outside version control, not recoverable).
- [ ] **Step 4: Decide the doc roots** per open decisions 2 and 3; `git mv` + scripted reference update; `grep` for the old names returns nothing outside ADRs/CHANGELOG.
- [ ] **Step 5: `docs/` top level.** Move the three `v1.x-release-plan.md`, `ollama-crash-prevention-plan.md`, `review-cloud-classification-2026-09-02.md`, `router-log-analysis-2026-10-08.md` to `docs/archive/` (history, not deleted); keep `architecture.md`, `config-override.md`, `routing-flow.md`, `mutation-triage.md`, `router-config.example.json`. Add the allowlist of root files to the gate.
- [ ] **Step 6: Commit** `chore: tidy repo root and docs top level`.

### Phase 2 — Shipped docs tell the truth

- [ ] **Step 1: List** the stale-name hits in shipped docs (`--stale`): `PI.md`, `skills/content-based-router/SKILL.md`, `skills/router-login/SKILL.md`, `README.md`.
- [ ] **Step 2: Rewrite `PI.md`** to the five-group layout. Take the facts from `router-config.json` and `docs/routing-flow.md` (already updated), not from memory; keep it short and link instead of copying (single owner per fact, see "Ownership map").
- [ ] **Step 3: Fix the skills** (group names only; skill behaviour unchanged).
- [ ] **Step 3a: Release gate for skills.** Pin the list of shipped skill directories to the two known ones (`content-based-router`, `router-login`) in `test/package-contents.test.ts`. Any other skill file in the `npm pack` list fails the gate.
- [ ] **Step 4: Pin** the stale-name ceiling at 0 in the gate. A `package-contents` style check already exists (`test/package-contents.test.ts`); extend it rather than adding a new file.
- [ ] **Step 5: Commit** `docs: shipped documentation matches the five-group layout`.

### Phase 3 — Plans, TODO, ownership map

- [ ] **Step 1: Plan index.** `docs/plans/README.md`: one table, one row per plan (file, status, one-line problem, successor). Built from a script that reads each plan's first 30 lines; the agent fills in statuses it can verify from code/git and marks the rest `unknown — owner to confirm`. Do **not** edit 30 old plans (§11: superseded plans stay untouched). New rule enforced by the gate: every *new* plan has a `Status` line.
- [ ] **Step 2: Ownership map** (`docs/README.md`, ≤ 40 lines): for each kind of fact the single document that owns it — routing flow → `docs/routing-flow.md`; decisions → ADRs; config keys → `router-config.example.json` + README table; release steps → `RELEASE_CHECKLIST.md`; history → CHANGELOG. Everything else links, never copies. This is the redundancy concept for docs.
- [ ] **Step 3: `TODO.md` (835 lines).** Script: list checkbox lines marked done and sections titled "Completed"; move completed sections to `docs/archive/TODO-completed.md`. Open items stay; items older than the five-group layout that mention removed groups are flagged, not silently dropped.
- [ ] **Step 4: Commit** `docs: plan index, ownership map, TODO split`.

### Phase 4 — Test redundancy

- [ ] **Step 1: Boilerplate report.** `--tests` prints the 10 most repeated set-up blocks (Ollama mock, `setConfig`+`new Router`, temp-home set-up) with file counts. `test/helpers/` already holds two helpers; add `makeRouter(cfgOverrides)` and `mockOllama()` there only for blocks repeated in ≥ 5 files.
- [ ] **Step 2: Migrate in batches of ~10 files**, suite green after each batch, repeated-block ceiling lowered in the baseline after each batch. Mechanical rewrites by script; behaviour of every test unchanged (no assertion edits).
- [ ] **Step 3: Mutation evidence.** Download the latest nightly `mutation.json` artifact (CI), compute per test: the set of mutants it is the *only* killer of. Tests with an empty set *and* no unique line coverage are candidates. Cap the output at 30 candidates. If the report has no `killedBy`, stop here and record "needs a perTest run" in this step instead of guessing.
- [ ] **Step 4: Delete or merge candidates one file at a time**; each needs (a) the Stryker evidence, (b) the suite green, (c) coverage thresholds unchanged. Keep a one-line `NOTE:` where a test was removed (the 2026-09-20 convention). Expect single-digit removals.
- [ ] **Step 5: Naming convention for pin files.** `consolidated-<topic>-pins.test.ts` stays, but a file over 1,000 lines is split by `describe` block into `<topic>-pins-<part>.test.ts` (navigation only, no content change). Only `consolidated-stream-error-pins` (3,017) and `consolidated-routing-cache-pins` (1,366) qualify now.
- [ ] **Step 6: Commit(s)** `refactor(test): shared router/ollama helpers` and `test: remove mutation-redundant tests`.

### Phase 5 — Code and scripts

- [ ] **Step 1: One decision-log reader.** `scripts/lib/decision-log.ts` exports `readDecisionLog(file, bounds)` returning `DecisionRecord` (the type from `src/classifier-decision-log.ts`) and re-exports `NON_ROUTING_STAGES`. Red-first test with a synthetic JSONL (malformed line skipped, bounds honoured, pool records without `input` handled).
- [ ] **Step 2: Migrate** `turn-decision-join`, `failover-walk`, `pool-replay`, `laya-pair-stats`, `laya-shadow-stats`, `classifier-replay` one script at a time; delete their local record types and readers; their existing tests stay green unchanged.
- [ ] **Step 3: Shared CLI helpers** (`arg`, `fmtTime`, `isRecord`, `pct`, `offsetOf`) into `scripts/lib/cli.ts`; same migration.
- [ ] **Step 4: Stale names in `src` comments** (44 hits of `tactical|strategic|operational|scout`). Classify with a script: migration warnings and history comments stay; comments describing current behaviour with removed names are fixed (Boyscout, §7).
- [ ] **Step 5: `scripts/` layout** per open decision 5, if approved: `git mv`, scripted update of `package.json`, both workflows, `.githooks/pre-push`, docs; the grep for the old paths must be empty.
- [ ] **Step 6: Commit(s)** per step.

### Phase 6 — Close

- [ ] Final report run: all baseline counts, before → after, in `docs/research/2026-10-29-repo-hygiene-result.md` (numbers only, §11).
- [ ] `npx tsc --noEmit`, `npx vitest run`, `npm run test:coverage` (thresholds unchanged), `npm run build`, `npm audit` summary in the PR body.
- [ ] Review per AGENTS.md §1 before the PR is proposed; all three PR review endpoints read before merge (§8). Status → `done`.

## What "redundancy control" means here (the concept)

| Where | Rule | How it is enforced |
|---|---|---|
| Code | A helper exists once. A second definition of the same function name in `src`/`scripts` is a finding. A record type for a log file is declared next to the writer and imported, never re-declared. | `analyze()` duplicate-name check, ratchet ceiling |
| Tests | Set-up that appears in ≥ 5 files lives in `test/helpers/`. A pin that kills no mutant uniquely is a candidate for removal; a pin that kills one is kept even if it looks repetitive. Pin files are named by topic and stay under 1,000 lines. | repeated-block ceiling, Stryker uniqueness report (nightly artifact), naming check |
| Docs | Every fact has one owning document (ownership map). Shipped docs contain no removed group names. Historical documents (ADRs, old plans, CHANGELOG) are never edited for tidiness (§12). Every new plan has a `Status` line. | stale-name ceiling 0, plan-status check, root-file allowlist |
| Process | A new top-level file needs an allowlist entry in the same PR, which forces the question "where does this belong". | root allowlist in the gate |

## Risks

- **Deleting a pin re-opens a Stryker survivor.** Mitigation: only the evidence path in Phase 4 Step 3–4; nothing is deleted on a hunch.
- **Moving `scripts/` breaks CI or the pre-push hook silently.** Mitigation: Phase 5 Step 5 is the last step, behind a green local `node scripts/secret-scan.ts --pre-push` dry run, and optional.
- **The yield may be small.** The 2026-09-20 audit found 5 real duplicates in 806 tests. The honest expectation is that most of the benefit is in Phases 1–3 (what users and agents *read*) and in the gate, not in line counts of tests.
