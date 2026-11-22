# Model use in long agentic turns

**Status:** done — 2026-11-21. Owner decision: do all phases. Phase 0
measured (`docs/research/2026-11-21-long-turn-profile.md`), Phase 1
measured-no-change, Phase 2 shipped as the `worker_step` tool.

**Verified against:** `origin/main` @ `03274c1`: `src/delegation.ts`
(`DEFAULTS`, `handleReadDelegation`), `src/bulk-read.ts` (the block message at
line 250), `router-config.json` (the `delegation` block, lines 150–156),
`docs/research/2026-11-20-mid-session-model-switch.md`.

## Problem

A long turn on an expensive group runs hundreds of steps on the expensive
model. Many of them are mechanical: running gates, reading logs, searching,
applying an edit that is already specified. Each one costs as much as a step
that needs judgment. The shipped config makes `planning` and `code_complex`
the expensive groups (`router-config.json:150–156`).

- **Switching the main model mid-turn does not pay.** The 2026-11-20 research
  note found that a switch costs one full cold re-read of the context. It
  recommends a suggestion at turn boundaries only, and downgrades only.
- **Existing cover is partial.** Full-file reads by members of
  `expensive_groups` are blocked with a pointer to `bulk_read`
  (`src/bulk-read.ts:250`). Oversized tool results are delegated to the cheap
  group (`src/delegation.ts`, enabled in the shipped config). Neither covers
  bash output or the step choices the agent makes itself.
- **Not measured.** No number exists for how many steps of a long turn are
  mechanical, or what they cost.
- **Precondition.** None of this applies to a session that runs a concrete
  model rather than `router/dynamic`. The 2026-11-21 session did that and
  stayed on one expensive model all session.

## Solution (phased)

- [x] **Phase 0 — measure (done 2026-11-21).** For each turn in the decision log:
  steps, the share of steps whose tool calls are reads, searches or shell
  runs, cost share per model, cache-hit share. Use the turn join
  (`scripts/turn-decision-join.ts`, `docs/research/2026-10-27-turn-decision-join.md`).
  Output: `docs/research/2026-11-21-long-turn-profile.md`. First check whether
  the decision log records individual tool steps at all. If it does not, the
  minimal logging change is part of Phase 0 and follows red-first.
- [x] **Phase 1 — widen delegation. Measured, no change warranted**
  (2026-11-21). `read` and `bash` are already in `tools`, and 95 % of the
  large bash output in long turns is piped/grep (the shunt exemption).
  Shrinking ALL big bash results would bound the saving at 5.6 % of context
  re-reads in long turns; capping only the exempt results above 12k chars
  would touch 35 of 890 results. Below ~3.5k chars the delegation latency
  exceeds the saving (shunt rationale). Numbers:
  `docs/research/2026-11-21-long-turn-profile.md`.
- [x] **Phase 2 — worker step, implemented 2026-11-21** (owner go: "do all
  phases"). New tool `worker_step` (`src/worker-step.ts`): one fully
  specified mechanical task per call, answered by the configured delegation
  group as a text-only sub-call (sub-call scope, so the turn model is
  unaffected). The worker has no tools, so the task must carry all material.
  Fails closed when delegation is off.
- **Rejected:** a mid-turn switch of the main model (see the research note).
- **Standing rule (AGENTS.md §13, added with this plan).** The expensive model
  plans, decides and judges (design, review, final verification). Mechanical
  steps go to cheap workers when delegation is authorised for the task.
  The rule is that authorisation.

## Open decisions

1. **Phase 0 data source.** Does the decision log cover tool steps, or does
   Phase 0 need a logging change first? Decided by the first Phase 0 step.
2. **Phase 2 tool.** Decided 2026-11-21: yes, shipped as `worker_step`.
3. **Which group is the worker.** Derived from `delegation.group` (no model is
   named in code, ADR-0025). Confirm that the default is the right cheap group.
