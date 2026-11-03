# Plan index

One row per plan in this directory. The **Status** column is what the plan
itself says, shortened — where it says `unknown — owner to confirm`, the plan
has no `Status` line and nobody has verified its state since. Rows marked
`done — <evidence>` were verified against the code or the shipped config on
2026-11-02 (hygiene Phase 3, `docs/plans/2026-10-29-repo-hygiene.md`).

Rules (AGENTS.md §11): one problem per plan, a `Status` line at the top, a
committed plan. Superseded plans are **not** edited — they keep their text and
this table records the successor. The ratchet in
`test/redundancy-baseline.test.ts` fails when a new plan arrives without a
`Status` line.

| Plan | Title | Status |
|---|---|---|
| [`2026-09-18-use-case-model-groups.md`](2026-09-18-use-case-model-groups.md) | Use-Case Model Groups (`bulk_reader` / `code_writer`) Implemen | done — bulk_reader/code_writer ship |
| [`2026-09-20-consolidate-tests.md`](2026-09-20-consolidate-tests.md) | Test Suite Consolidation — Implementation Plan | done — consolidated-*-pins files |
| [`2026-09-20-enforced-delegation-spike-and`](2026-09-20-enforced-delegation-spike-and-design.md) | Enforced Delegation in the Router — Spike Results & Module Des | unknown — owner to confirm |
| [`2026-09-20-latest-alias-slug-matching-de`](2026-09-20-latest-alias-slug-matching-design.md) | Design: `-latest` Aliases and Dated Snapshots — Newest-Version | unknown — owner to confirm |
| [`2026-09-27-agent-capability-tier.md`](2026-09-27-agent-capability-tier.md) | Plan: Agent-Capability Tier — keep non-agent models out of rou | unknown — owner to confirm |
| [`2026-09-27-cloud-first-local-fallback-de`](2026-09-27-cloud-first-local-fallback-design.md) | Cloud-First Routing (Local Ollama as Last Resort) — Design | unknown — owner to confirm |
| [`2026-09-27-cloud-first-local-fallback-pl`](2026-09-27-cloud-first-local-fallback-plan.md) | Cloud-First Routing (Local Ollama as Last Resort) Implementati | done — cloud_first + cloud classifier chain |
| [`2026-09-27-hint-mechanism-repair-plan.md`](2026-09-27-hint-mechanism-repair-plan.md) | Plan: Repairing the HINT Mechanism (HINT/MHINT/MODEL-HINT pref | done — HINT/MHINT shipped |
| [`2026-09-27-router-cost-and-errors.md`](2026-09-27-router-cost-and-errors.md) | Plan: `/router cost` (audit depth) + `/router errors` (status- | unknown — owner to confirm |
| [`2026-09-27-stopReason-interception-desig`](2026-09-27-stopReason-interception-design.md) | Design: Intercepting stopReason 'length' (max_tokens truncatio | unknown — owner to confirm |
| [`2026-09-27-wait-for-short-reset-plan.md`](2026-09-27-wait-for-short-reset-plan.md) | Plan: Bounded Wait-for-Short-Reset (ADR-0017) | unknown — owner to confirm |
| [`2026-09-30-pi-0.99.1-update-and-mcp-migr`](2026-09-30-pi-0.99.1-update-and-mcp-migration.md) | Pi 0.99.1 Update and Built-in MCP Migration Runbook | done — runbook, Pi 1.4.0 now |
| [`2026-09-30-router-0.99.1-hardening.md`](2026-09-30-router-0.99.1-hardening.md) | Router 0.99.1 Hardening — Typed-Model Preservation (Runbook Ta | done — runbook |
| [`2026-09-30-router-virtual-models.md`](2026-09-30-router-virtual-models.md) | Router Virtual Models Migration Plan (Pi 0.99.x) — Hybrid with | unknown — owner to confirm |
| [`2026-10-02-index-ts-refactor.md`](2026-10-02-index-ts-refactor.md) | index.ts Refactoring Implementation Plan | done — index.ts 760 lines |
| [`2026-10-04-aa-multi-benchmark-sourcing.m`](2026-10-04-aa-multi-benchmark-sourcing.md) | AA Multi-Benchmark Capability Sourcing — Implementation Plan | done — capability columns shipped |
| [`2026-10-04-mutation-survivor-triage.md`](2026-10-04-mutation-survivor-triage.md) | Mutation Survivor Triage Implementation Plan | done — docs/mutation-triage.md |
| [`2026-10-05-laya-classifier-integration.m`](2026-10-05-laya-classifier-integration.md) | Laya Classifier Integration Implementation Plan | done — src/laya-classifier.ts |
| [`2026-10-05-task-type-balancing.md`](2026-10-05-task-type-balancing.md) | Task-Type Balancing Implementation Plan | proposed |
| [`2026-10-06-no-hardcoded-models.md`](2026-10-06-no-hardcoded-models.md) | Plan: No hardcoded models (ADR-0025) | done — baseline closed at 0 |
| [`2026-10-06-provider-circuit-breaker.md`](2026-10-06-provider-circuit-breaker.md) | Plan: Provider circuit breaker (cloud + local, one mechanism) | done — src/provider-breaker.ts |
| [`2026-10-06-router-config-command.md`](2026-10-06-router-config-command.md) | Plan: `/router config` — live routing config without a restart | done — /router config |
| [`2026-10-06-workround-master.md`](2026-10-06-workround-master.md) | Master Plan: Work Round 1.7.0 — Tracks 1–4 in One Pass | unknown — owner to confirm |
| [`2026-10-08-classifier-decision-log.md`](2026-10-08-classifier-decision-log.md) | Plan: classifier decision log — make "known vs. Laya" comparab | done — ADR-0027 |
| [`2026-10-08-laya-spike-brief.md`](2026-10-08-laya-spike-brief.md) | Laya spike — build brief (evening of 2026-10-08) | done — spike ran |
| [`2026-10-08-mutation-r2-summary.md`](2026-10-08-mutation-r2-summary.md) | Mutation Nightly R2 — result and wrap-up (2026-10-08, run 3776 | done — result doc |
| [`2026-10-09-laya-tasks1-5.md`](2026-10-09-laya-tasks1-5.md) | Laya Integration — Tasks 1 to 5 (implementation-ready) | done |
| [`2026-10-11-category-model-alignment.md`](2026-10-11-category-model-alignment.md) | Category–Model Alignment Implementation Plan | proposed |
| [`2026-10-15-laya-shadow-evaluation.md`](2026-10-15-laya-shadow-evaluation.md) | Laya shadow evaluation — protocol | proposed |
| [`2026-10-25-category-group-mismatch.md`](2026-10-25-category-group-mismatch.md) | Categories and groups do not line up | done — five-group layout shipped |
| [`2026-10-25-fallback-naming.md`](2026-10-25-fallback-naming.md) | "fallback" — one word, too many meanings | approved, partly done |
| [`2026-10-25-laya-sole-classifier.md`](2026-10-25-laya-sole-classifier.md) | Laya as the sole classifier, chain as background comparator | in progress |
| [`2026-10-26-continue-keeps-model.md`](2026-10-26-continue-keeps-model.md) | `continue` keeps the model, not only the category | approved, partly done |
| [`2026-10-26-live-uncertainty-labeling-des`](2026-10-26-live-uncertainty-labeling-design.md) | Live labeling of uncertain Laya decisions (design) | done |
| [`2026-10-29-repo-hygiene.md`](2026-10-29-repo-hygiene.md) | Repo hygiene: clean up the layout and stop redundancy from gro | in progress — phases 0-2 |
| [`2026-10-31-laya-sidecar-distribution.md`](2026-10-31-laya-sidecar-distribution.md) | Laya sidecar distribution: give every user a classifier they c | in progress |
| [`candidates_consolidation.md`](candidates_consolidation.md) | Test Consolidation — Candidate Analysis | unknown — owner to confirm |
| [`redundancy-analysis.md`](redundancy-analysis.md) | Test Suite Redundancy & Timeout Analysis (Task 3) | unknown — owner to confirm |
