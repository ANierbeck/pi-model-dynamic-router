# Plan index

One row per plan in this directory, generated from the plan files themselves
(hygiene Phase 3, `docs/plans/2026-10-29-repo-hygiene.md`). **Status** is what
the plan declares, unless the state was verified against the code or the
shipped config on 2026-11-02/03 — then it says `done — <evidence>`. A plan
with no `Status` line shows `unknown — owner to confirm`; nobody has checked
it since.

Rules (AGENTS.md §11): one problem per plan, a `Status` line at the top, a
committed plan. Superseded plans are **not** edited — they keep their text and
this table records the successor. Two ratchets in
`test/redundancy-baseline.test.ts` keep the table honest: a plan added without
a `Status` line raises `plansWithoutStatus`, and a plan without a row here
raises `plansMissingFromIndex` — both pinned, so neither can grow.

| Plan | Title | Status | Problem (from the plan) | Successor |
|---|---|---|---|---|
| [`2026-09-18-use-case-model-groups.md`](2026-09-18-use-case-model-groups.md) | Use-Case Model Groups (`bulk_reader` / `code_writer`) Impl | done — bulk_reader/code_writer ship | Add a `min_context_length` group filter and two documented default |  |
| [`2026-09-20-consolidate-tests.md`](2026-09-20-consolidate-tests.md) | Test Suite Consolidation — Implementation Plan | done — consolidated-*-pins files | Reduce the ~800 tests to a maintainable, performant suite by | the execution protocol at the top: Tasks |
| [`2026-09-20-enforced-delegation-spike-and-design.md`](2026-09-20-enforced-delegation-spike-and-design.md) | Enforced Delegation in the Router — Spike Results & Module | approved — read-only scope |  |  |
| [`2026-09-20-latest-alias-slug-matching-design.md`](2026-09-20-latest-alias-slug-matching-design.md) | Design: `-latest` Aliases and Dated Snapshots — Newest-Ver | approved |  |  |
| [`2026-09-27-agent-capability-tier.md`](2026-09-27-agent-capability-tier.md) | Plan: Agent-Capability Tier — keep non-agent models out of | approved, implemented |  |  |
| [`2026-09-27-cloud-first-local-fallback-design.md`](2026-09-27-cloud-first-local-fallback-design.md) | Cloud-First Routing (Local Ollama as Last Resort) — Design | done — design superseded by its plan |  |  |
| [`2026-09-27-cloud-first-local-fallback-plan.md`](2026-09-27-cloud-first-local-fallback-plan.md) | Cloud-First Routing (Local Ollama as Last Resort) Implemen | done — cloud_first + cloud classifier chain | Stop the local Ollama daemon from being hit on nearly every |  |
| [`2026-09-27-hint-mechanism-repair-plan.md`](2026-09-27-hint-mechanism-repair-plan.md) | Plan: Repairing the HINT Mechanism (HINT/MHINT/MODEL-HINT  | done — HINT/MHINT shipped |  | that channel split |
| [`2026-09-27-router-cost-and-errors.md`](2026-09-27-router-cost-and-errors.md) | Plan: `/router cost` (audit depth) + `/router errors` (sta | approved, implemented |  |  |
| [`2026-09-27-stopReason-interception-design.md`](2026-09-27-stopReason-interception-design.md) | Design: Intercepting stopReason 'length' (max_tokens trunc | done — stopReason handling shipped |  |  |
| [`2026-09-27-wait-for-short-reset-plan.md`](2026-09-27-wait-for-short-reset-plan.md) | Plan: Bounded Wait-for-Short-Reset (ADR-0017) | done — ADR-0017 |  |  |
| [`2026-09-30-pi-0.99.1-update-and-mcp-migration.md`](2026-09-30-pi-0.99.1-update-and-mcp-migration.md) | Pi 0.99.1 Update and Built-in MCP Migration Runbook | done — runbook, Pi 1.4.0 now | Update Pi from 0.87.1 to 0.99.1, migrate the four MCP servers from the p |  |
| [`2026-09-30-router-0.99.1-hardening.md`](2026-09-30-router-0.99.1-hardening.md) | Router 0.99.1 Hardening — Typed-Model Preservation (Runboo | done — runbook |  |  |
| [`2026-09-30-router-virtual-models.md`](2026-09-30-router-virtual-models.md) | Router Virtual Models Migration Plan (Pi 0.99.x) — Hybrid  | done — groups register as providers | Expose the router's groups as Pi virtual models (`pi.registerVirtualMode |  |
| [`2026-10-02-index-ts-refactor.md`](2026-10-02-index-ts-refactor.md) | index.ts Refactoring Implementation Plan | done — index.ts 760 lines | Shrink `index.ts` (3749 lines) to a pure wiring file (<1200 lines) by ex |  |
| [`2026-10-04-aa-multi-benchmark-sourcing.md`](2026-10-04-aa-multi-benchmark-sourcing.md) | AA Multi-Benchmark Capability Sourcing — Implementation Pl | done — capability columns shipped | Feed the already-fetched Artificial Analysis per-benchmark columns |  |
| [`2026-10-04-mutation-survivor-triage.md`](2026-10-04-mutation-survivor-triage.md) | Mutation Survivor Triage Implementation Plan | done — docs/mutation-triage.md | Turn the first nightly mutation report (1670 mutants, 56.4% score, 468 s |  |
| [`2026-10-05-laya-classifier-integration.md`](2026-10-05-laya-classifier-integration.md) | Laya Classifier Integration Implementation Plan | done — src/laya-classifier.ts | Integrate Laya (Convai Innovations, Apache 2.0 — a local, non-LLM "Syste |  |
| [`2026-10-05-task-type-balancing.md`](2026-10-05-task-type-balancing.md) | Task-Type Balancing Implementation Plan | done — Phases 0–5b; 5d closed (measured), 5c deferred to 2.0.x | Spread routed work across subscription tanks by *task type* |  |
| [`2026-10-06-no-hardcoded-models.md`](2026-10-06-no-hardcoded-models.md) | Plan: No hardcoded models (ADR-0025) | done — baseline closed at 0 | make "no new hardcoded model" a failing test before removing the old |  |
| [`2026-10-06-provider-circuit-breaker.md`](2026-10-06-provider-circuit-breaker.md) | Plan: Provider circuit breaker (cloud + local, one mechani | done — src/provider-breaker.ts |  |  |
| [`2026-10-06-router-config-command.md`](2026-10-06-router-config-command.md) | Plan: `/router config` — live routing config without a res | done — /router config |  |  |
| [`2026-10-06-workround-master.md`](2026-10-06-workround-master.md) | Master Plan: Work Round 1.7.0 — Tracks 1–4 in One Pass | done — tracks landed individually | Land ADR-0025 Phase A, Circuit-Breaker Phase 1, `/router config` |  |
| [`2026-10-08-classifier-decision-log.md`](2026-10-08-classifier-decision-log.md) | Plan: classifier decision log — make "known vs. Laya" comp | done — ADR-0027 | For every classification the router makes, persist enough to answer |  |
| [`2026-10-08-laya-spike-brief.md`](2026-10-08-laya-spike-brief.md) | Laya spike — build brief (evening of 2026-10-08) | done — spike ran |  |  |
| [`2026-10-08-mutation-r2-summary.md`](2026-10-08-mutation-r2-summary.md) | Mutation Nightly R2 — result and wrap-up (2026-10-08, run  | done — result doc |  |  |
| [`2026-10-09-laya-tasks1-5.md`](2026-10-09-laya-tasks1-5.md) | Laya Integration — Tasks 1 to 5 (implementation-ready) | done |  |  |
| [`2026-10-11-category-model-alignment.md`](2026-10-11-category-model-alignment.md) | Category–Model Alignment Implementation Plan | superseded by 2026-10-25-category-group-mismat | Each classification category routes to a group whose *effective* |  |
| [`2026-10-15-laya-shadow-evaluation.md`](2026-10-15-laya-shadow-evaluation.md) | Laya shadow evaluation — protocol | proposed |  |  |
| [`2026-10-25-category-group-mismatch.md`](2026-10-25-category-group-mismatch.md) | Categories and groups do not line up | done — five-group layout shipped |  | D5 and D6 below |
| [`2026-10-25-fallback-naming.md`](2026-10-25-fallback-naming.md) | "fallback" — one word, too many meanings | approved, partly done |  |  |
| [`2026-10-25-laya-sole-classifier.md`](2026-10-25-laya-sole-classifier.md) | Laya as the sole classifier, chain as background comparato | in progress; hosts the 2.0.0 "everything Laya" release gate (owner 2026-11-08) |  |  |
| [`2026-10-26-continue-keeps-model.md`](2026-10-26-continue-keeps-model.md) | `continue` keeps the model, not only the category | approved, partly done |  |  |
| [`2026-10-26-live-uncertainty-labeling-design.md`](2026-10-26-live-uncertainty-labeling-design.md) | Live labeling of uncertain Laya decisions (design) | done |  |  |
| [`2026-10-29-repo-hygiene.md`](2026-10-29-repo-hygiene.md) | Repo hygiene: clean up the layout and stop redundancy from | done (2026-11-04) | A repository where every file has one obvious home and one owner, and wh | docs/plans/2026-09-20-consolidate-tests |
| [`2026-10-31-laya-sidecar-distribution.md`](2026-10-31-laya-sidecar-distribution.md) | Laya sidecar distribution: give every user a classifier th | in progress; 2.0.0 blocker (owner 2026-11-08); Linux/Windows latency waived |  |  |
| [`2026-11-04-orchestrator-mutation-triage.md`](2026-11-04-orchestrator-mutation-triage.md) | Mutation triage of the stream orchestrator after the Laya merge | in progress (slice 2 triage done 2026-11-05: 205 real gaps → test round open; slice 3 open). Owner 2026-11-07: open decision 1 — with no virtual-model migration the code stays, so the 205 gaps get full red-first tests; open decision 2 — pin the decision-naming log lines, ledger the rest as equivalent |  |  |
| [`2026-11-04-virtual-models-routing.md`](2026-11-04-virtual-models-routing.md) | Route through Pi's Virtual Models: evaluate whether the router's own turn-state machine can go | done 2026-11-07 — owner decided against the migration; re-evaluated on Pi host upgrades |  |  |
| [`2026-11-07-compaction-continuity.md`](2026-11-07-compaction-continuity.md) | Compaction continuity decides by context window | done 2026-11-07 — merged in PR #120 | Compaction continuity trusts any model whose id does not look small, so a free tier or meta-router gets the compaction HINT |  |
| [`2026-11-07-session-keyed-turn-state.md`](2026-11-07-session-keyed-turn-state.md) | Session-keyed turn state | done 2026-11-07 — merged in PR #120 | The router's turn state is per process, not per session, so subagent sessions in the same process share and overwrite it |  |
| [`2026-11-07-tool-follow-up-group.md`](2026-11-07-tool-follow-up-group.md) | Tool follow-up keeps the run's group | done 2026-11-07 — merged in PR #120 |
| [`2026-11-07-turn-latency-tool-time.md`](2026-11-07-turn-latency-tool-time.md) | Turn latency includes tool and sub-call time (M3) | approved 2026-11-07 — not started | `turn_end` books the whole turn (tools + sub-calls) as the model's latency sample, deflating tps and skewing the ranking's latency sort |  | A tool follow-up always falls back to the simple group, whatever group the run started in |  |
| [`2026-11-04-lint-gate.md`](2026-11-04-lint-gate.md) | Lint Gate Implementation Plan | in progress (gate live, burn-down open) | ESLint is installed but never runs: no `lint` script, no CI step, and the configured ruleset reports 1224 findings (862 errors) in 65 files — the release checklist line "No linting errors" is unsatisfiable |  |
| [`2026-11-05-prettier-formatting.md`](2026-11-05-prettier-formatting.md) | Prettier: format the code once, then keep it formatted | done 2026-11-05 (gate tool, dedupe rounds, reformat + CI/hook enforcement all landed; repeatedBlocks 45 → 30, lint baseline 919 → 915) | Prettier 3.8.4 and a `.prettierrc` exist and `eslint-config-prettier` keeps ESLint out of the way, but the config never ran: no `format` script, no CI step, no `.prettierignore`, and 371 files (264 of 309 tracked `.ts`/`.js`) do not match it |  |
| [`2026-11-08-external-usage-source-codexbar.md`](2026-11-08-external-usage-source-codexbar.md) | External usage source: provider quota and balance from CodexBar (optional) | proposed 2026-11-08 — not started | The router only sees its own counters: real quota windows, reset times and balances are unknown until a request fails (ADR-0003 Option C deferred) |  |
| [`2026-11-08-optional-integrations-config.md`](2026-11-08-optional-integrations-config.md) | Optional integrations: one contract, one config block, typo-safe user layers | proposed 2026-11-08 — not started; contract + rename are a 2.0.0 blocker (decision 1 decided: rename before 2.0.0) | Each optional component (Laya, CodexBar) is wired ad hoc; unknown config keys are silently ignored and a project layer can switch integrations on |  |
| [`2026-11-08-laya-model-artifact.md`](2026-11-08-laya-model-artifact.md) | Laya model artifact: versioned, verifiable, installable | in progress 2026-11-08 (manifest, head parity gate, installer done); 2.0.0 blocker (part of "everything Laya") | No artifact a user can install: `checkpoint` is a hand-typed HF path, the router never downloads weights, nothing verifies what arrived, and the head was not pinned to the router's head |  |
| [`2026-11-08-router-config-ui.md`](2026-11-08-router-config-ui.md) | Router config UI: a guided path for optional integrations | proposed 2026-11-08 — not started | `/router config` is read-mostly and has no integration path; enabling Laya needs six hand-edited keys, and a wrong value silently disables the stage while the interactive UI (`select`/`confirm`/`input`) sits unused |  |
| [`2026-11-11-onnx-sidecar-package.md`](2026-11-11-onnx-sidecar-package.md) | ONNX sidecar package: an installable Laya sidecar for Linux, Windows and macOS | proposed 2026-11-11 — waits for owner decisions D1–D6 | The ONNX backend has no sidecar; onnxruntime-node downloads CUDA libs unverified on Linux x64; no darwin/x64 binding; the spike runner is missing. | |
| [`candidates_consolidation.md`](candidates_consolidation.md) | Test Consolidation — Candidate Analysis | done — analysis for the consolidation |  |  |
| [`redundancy-analysis.md`](redundancy-analysis.md) | Test Suite Redundancy & Timeout Analysis (Task 3) | done — analysis for the consolidation |  |  |
