# Plan: `/router config` — live routing config without a restart

> Backlog item registered 2026-10-06 (TODO.md "Owner backlog"). Target line:
> 1.7.0. All phases follow AGENTS.md §4 (red-first, tsc + suite green), §5,
> §8. **No release action is part of this plan (§1).**
>
> Related: [ADR-0009](../adr/0009-exclude-union-merge-and-config-classifier-model.md)
> (union-merge of `exclude` arrays — the constraint that shapes un-exclude),
> [ADR-0025](../adr/0025-no-hardcoded-models.md) Phase B3 (empties the shipped
> `exclude.models` — removes the same constraint), task-type-balancing plan
> Phase 5b (the compaction flag this command exposes).

## Goal

Change routing behaviour from a running session, without editing JSON and
without a restart:

```
/router config                          # show effective settings + their origin
/router config exclude <ref|glob>       # exclude a model/pattern from routing
/router config unexclude <ref|glob>     # remove a user-layer exclusion
/router config compaction on|off        # 5b cache-aware auto-compaction flag
```

Principles (same separation the repo already uses everywhere): changes are
**personal preferences**, so they are persisted to the **user layer**
(`<piAgentDir>/router-config.user.json`), never to the shipped defaults; and
they are **generic** — the command edits config keys that already exist, it
does not add per-model special cases (ADR-0025 alignment).

## What exists today (verified 2026-10-06)

- Config layering: shipped `router-config.json` → user override
  (`router-config.user.json`, `PI_CODING_AGENT_DIR`-aware) → project override
  (`<cwd>/.pi/router-config.json`), deep-merged (`src/config-loader.ts`);
  `exclude` arrays are **union-merged** across layers (ADR-0009).
- `rt.load()` re-reads the layered config on every session_start and in the
  `/router` handler (`src/commands.ts:203`) — the proven reload path.
- Exclusion is applied in the live resolve pipeline, not only at generation
  time (ADR-0010: one rule set for persist, live and display), so an added
  exclusion takes effect on the very next turn.
- `update_model_metrics` (`src/tools.ts:156`) is the precedent for live config
  mutation + delta-only persistence; its v1.6.0 review (I1) documented the
  one hazard: never persist the layered runtime config — only a delta.
- Live config state: `rt.cfg` / `metricsModule` — mutated in place by
  `update_model_metrics` without a reload, so in-place mutation is effective.

## Design decisions

**D1 — Write target: the user layer only.** The command writes deltas to
`<piAgentDir>/router-config.user.json`. Never the shipped file: an npm update
overwrites it, and persisting layered runtime state clobbers other layers
(v1.6.0 review I1). Project overrides are read-only for the command (single
write target, no ambiguity; owner can still hand-edit `.pi/router-config.json`).

**D2 — Write discipline.** Read → parse → apply delta → validate → pretty
write. Refuse to write when the existing file is unreadable or not an object
(same "losing one edit is the lesser harm" logic as `update_model_metrics`);
first write backs up the previous file to `.bak`; write via temp file + rename.

**D3 — Live effect.** After persisting: mutate `rt.cfg` in place (immediate)
and call `rt.load()` (authoritative re-read, same as session_start). An added
exclusion is visible next turn. An un-exclusion is visible next turn for the
live pipeline; persisted dynamic-group candidate lists regenerate at the next
scan cycle (`generateDynamicConfig`) — same bounded rollout latency as PR
#39, stated in the command output ("takes full effect at next scan").

**D4 — Un-exclude vs the union merge.** Because `exclude` arrays are
union-merged, a **shipped** default entry cannot be removed via the user
layer — `unexclude` can only remove entries the user layer itself carries.
ADR-0025 Phase B3 empties the shipped list in the same 1.7.0 line, which
resolves this cleanly. Until B3 lands: the display marks each pattern's
origin (`shipped`, `user`, `project`) and `unexclude` on a shipped pattern
answers honestly ("part of the shipped defaults — removable after the
no-hardcoded-models change; use a tighter user pattern to route around it").
No new `include` override mechanism — two exclusion semantics would be worse
than a temporary, honest limitation.

**D5 — Validation.** A pattern must be a plausible ref or glob
(`provider/...` with optional `*`; also allow bare `provider` = the existing
provider form). Before applying, the command shows how many currently
discovered models the pattern matches (informational, not a blocker —
owner confirmation question Q2).

**D6 — Compaction flag is gated on 5b.** `/router config compaction on|off`
sets `context_budget.enabled` — the exact key Phase 5b of the
task-type-balancing plan defines. If the command lands first, the subcommand
exists and answers "not implemented yet (Phase 5b)"; once 5b lands it flips
the real flag. No separate key, no drift between plan and command.

## Phases

### Phase 1 — Read-only display
- `/router config` (bare) prints: contributing config sources (the loader
  already returns them), every effective `exclude` rule with origin marker
  and the number of currently matching models, the effective
  `context_budget` state (or "Phase 5b pending"), and a usage hint.
- Autocomplete entries for `config`, `config exclude`, `config unexclude`,
  `config compaction` in `getArgumentCompletions`.
- **Red-first:** command-render test asserting the origin markers and the
  shipped-entry hint; fails on the pre-change handler (no such output).

### Phase 2 — Exclude / unexclude
- Handler: parse → validate (D5) → show match count → persist delta to the
  user file (D1/D2) → mutate `rt.cfg` + `rt.load()` (D3) → confirm output
  including the scan-cycle note.
- `unexclude`: exact-match search in the user layer's `exclude.models`;
  remove, persist, reload; shipped/project patterns → honest answer (D4).
- **Red-first (selection):**
  - write test: user file gains the pattern and **keeps** every key it had;
    shipped `router-config.json` is byte-identical;
  - live test: `rt.cfg.exclude` updated after the call, next resolve skips
    the model;
  - un-exclude test: user-layer entry removed, shipped entry refused with
    the documented message;
  - corrupt-file test: existing-but-unparseable user file → no write, error
    surfaced;
  - glob validation test: junk patterns rejected.

### Phase 3 — Compaction flag (blocked by task-type Phase 5b)
- Flips `context_budget.enabled` through the same persist path; until 5b
  lands, answers "not implemented yet (Phase 5b)". No separate work beyond
  the already-planned 5b implementation.

### Phase 4 — Docs & closure
- README `/router` usage section; CHANGELOG (1.7.0, "Added"); TODO.md tick;
- full-range code review per §1 before any release is proposed.

## Sequencing proposal

Phase 1+2 can land independently of 5b and of ADR-0025 (they only read the
layering that exists today). Best order for 1.7.0: **ADR-0025 Phase B3 →
this Phase 2**, so un-exclude is fully free from the start; if B3 slips,
Phase 2 still works with the D4 limitation.

## Open questions for the owner

1. **Q1 — project override:** global user file as the only write target (D1),
   or should `/router config` also write `<cwd>/.pi/router-config.json` when
   one exists? Proposal: global only.
2. **Q2 — confirmation:** broad globs that match many models — informational
   match count (applies immediately) or an explicit confirm step
   (`/router config exclude 'openrouter/*'!`)? Proposal: informational only,
   the match count is visible before the pattern is persisted.
3. **Q3 — scope v1:** exclude/un-exclude + compaction flag only, as the
   backlog item says? (Not: group edits, pinning, budgets — those stay in
   hand-edited config until asked for.)

## Review follow-ups (Lane C round, 2026-10-07)

- **Bare provider pattern (review Minor 1 — product decision, deferred):**
  `/router config exclude openrouter` passes validation but lands in
  `exclude.models`, where it matches only the exact (nonexistent) ref
  `openrouter` — match count 0, reversible, visible. Options: reject bare
  patterns that look like provider ids, or map them to
  `exclude.providers`. Needs an owner call; not a routing risk.
- Provider-level coverage of unexclude notes (review Minor 2) and the
  README alignment (Minor 3) were fixed in the round.
