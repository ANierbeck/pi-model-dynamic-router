# Model use in long agentic turns

**Status:** proposed — 2026-11-21. Phase 0 (measurement) is the only step
that may start now. Phases 1 and 2 wait for its result and the owner's go.

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

- **Phase 0 — measure (may start now).** For each turn in the decision log:
  steps, the share of steps whose tool calls are reads, searches or shell
  runs, cost share per model, cache-hit share. Use the turn join
  (`scripts/turn-decision-join.ts`, `docs/research/2026-10-27-turn-decision-join.md`).
  Output: `docs/research/2026-11-21-long-turn-profile.md`. First check whether
  the decision log records individual tool steps at all. If it does not, the
  minimal logging change is part of Phase 0 and follows red-first.
- **Phase 1 — widen delegation, only as far as Phase 0 shows.** Candidates:
  shell output above `min_chars`, a wider `tools` list. Each change is a
  config or code change with its own red test.
- **Phase 2 — a worker step (owner decision).** A tool the expensive model
  calls to hand a fully specified mechanical task to the cheap group. The
  result returns into the turn, as `handleReadDelegation` already does for
  reads. This adds a tool surface, so it needs the owner's go.
- **Rejected:** a mid-turn switch of the main model (see the research note).
- **Standing rule (AGENTS.md §13, added with this plan).** The expensive model
  plans, decides and judges (design, review, final verification). Mechanical
  steps go to cheap workers when delegation is authorised for the task.
  The rule is that authorisation.

## Open decisions

1. **Phase 0 data source.** Does the decision log cover tool steps, or does
   Phase 0 need a logging change first? Decided by the first Phase 0 step.
2. **Phase 2 tool.** Authorise a worker tool at all? Recommended: decide after
   the Phase 0 profile, not before.
3. **Which group is the worker.** Derived from `delegation.group` (no model is
   named in code, ADR-0025). Confirm that the default is the right cheap group.
