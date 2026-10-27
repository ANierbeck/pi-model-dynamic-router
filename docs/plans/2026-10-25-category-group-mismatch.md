# Categories and groups do not line up

**Status:** owner decisions recorded (D1–D3 2026-10-25, D4–D7 2026-10-26);
one proposal still open (what separates `design` from `planning`). No code
before the behaviour-change list from Step 2 is approved.

**Verified against:** `origin/main` 6f4ac08 (`router-config.json`,
`src/content-classifier.ts` `CATEGORY_TO_GROUP`, `src/stream-orchestrator.ts`,
`src/routing.ts`, `src/delegation.ts`), the owner's
`router-config.user.json`, and the router / classifier-decision logs from
2026-10-15 (taxonomy v2 live) to 2026-10-25. Not verified: other users'
configs (unknown by nature).

**Re-checked 2026-10-27 on `laya-spike` `9f94cab`:** the 13 group names in
`router-config.json` and the category comment in `content-classifier.ts`
(`:89-99`). The mapping table and the selection counts were NOT re-measured.

**Replaces:** Phase 1.1/1.2 of the superseded
`docs/plans/2026-10-11-category-model-alignment.md` (planned there, never
implemented).

## Problem

The classifier answers with 7 categories; the shipped config has 13
groups. The names do not tell which category lands where, and two group
names belong to a *different* category than their name says:

- category `simple` → group `scout`; category `code_simple` → group
  `simple`;
- category `standard` → group `operational`; the group named `standard`
  is reached by no category;
- `code_complex` and `continue` → `tactical`; `design` and `planning` →
  `planning`.

Five groups are reached by no category at all. The owner cannot tell from
config or log whether "reduce the number" was about categories (done:
9 → 7 in PR #70) or about groups (not done). That confusion is the
problem this plan solves.

## Current state (verified)

### Category → group

Selections from the `[router] <category> → <group>` lines since
2026-10-15. A second log line kind for the same event gives lower counts
(176 vs. 374 lines); that discrepancy is not reconciled, so read the
shape, not the numbers.

| category | group | group rule (shipped) | selections |
|---|---|---|---|
| `simple` | `scout` | tiered, min_gdpval 0, max_cost 0 | 75 |
| `code_simple` | `simple` | tiered, min_gdpval 0, max_cost 0 | 31 |
| `standard` | `operational` | tiered, min_gdpval 300, max_cost 2.0 | 166 |
| `code_complex` | `tactical` | best, min_gdpval 1630, max_gdpval 1700 (owner layer: 1900) | 51 |
| `continue` | `tactical` | same; only when there is no previous category to inherit | 11 |
| `design` | `planning` | best, min_gdpval 1700 | 26 |
| `planning` | `planning` | same | 14 |

### Groups no category reaches — and what still uses them

| group | used by |
|---|---|
| `trivial` | nothing in the shipped chains; only the global `FALLBACK_GROUP_ORDER` (`routing.ts:351`) and an explicit group hint. Effectively dead. |
| `standard` | failover chain of `operational` |
| `complex` | failover chains of `standard`, `strategic`, `tactical` |
| `strategic` | failover chains of `complex`, `tactical`, `planning`; start group for a model hint whose model scores ≥ 700 (`stream-orchestrator.ts:559`); `delegation.expensive_groups` |
| `fallback` | last link of 11 failover chains; default for an unknown category (`content-classifier.ts:1176`); classification failure and unresolvable target (`stream-orchestrator.ts:587, 610`); pool for tool follow-up steps (`stream-orchestrator.ts:340`) |

Group hints since 2026-10-15: none (all 35 hint records are model hints).

### Groups on a different axis (not categories)

| group | purpose |
|---|---|
| `dynamic` | the group the user selects: classifies every prompt and routes to a category group |
| `bulk_reader` | delegation (ADR-0007): an oversized `read`/`bash` result is summarized by a cheap model before the main model sees it — saves the expensive model's tokens. Shipped `delegation.enabled: true`; 8 replacements logged since 2026-10-15 (largest: a 51 343-character `bash` result → 2 206-character summary). Also addressable from subagents as `bulk_reader/bulk_reader`. |
| `code_writer` | no code path uses it; addressable from subagents only (`code_writer/code_writer`) |

### Why a rename is not cosmetic

Unreached groups still shape failover: `operational` fails over to
`standard` (min_gdpval 500, max_cost 5.0), `tactical` to `strategic` and
`complex`. Removing or renaming a group changes which model answers when
the first choice fails. The owner layer also references groups by name
(`tactical`, `scout`, `bulk_reader`, `code_writer`).

## Solution options

- **A — Rename only** (the 2026-10-11 Phase 1.1): the five category
  groups take the category names; old names stay as read-aliases. 13
  groups remain, 4 of them still unreached. Collision: `simple` names
  two different pools today, so it cannot be an alias.
- **B — Reduce, then rename:** keep one group per category target
  (renamed to the category name) plus the infrastructure groups
  (`dynamic`, `bulk_reader`, `code_writer`, `fallback`) and `strategic`
  (failover and hint start group). Remove `trivial`, `standard`,
  `complex` after their failover role is replaced by explicit chains.
- **C — Document only:** a category → group table in README and
  `/router status`; no config change.

**Recommendation: B, in two steps** — first remove the dead groups (with
a failover simulation), then rename with aliases. A leaves four dead
groups in place and with them the confusion; C changes nothing for
anyone reading a config. B is the largest change, which is why both
steps get a behaviour-change list for the owner before any code.

The earlier owner decisions "`design` + `planning` → `planning` (2:1)" and
"`continue` → `tactical`" are superseded by D5 and D6 below.

## Open decisions (owner)

- **D1 — decided 2026-10-25: B** (reduce, then rename).
- **D2 — decided 2026-10-25: remove the unreached groups, INCLUDING
  `strategic`** (owner: hints target models, not categories or groups —
  all 35 hint records since 2026-10-15 name a model). The four code uses
  of `strategic` are re-pointed, not kept:
  - hint start group for a model scoring ≥ 700 (`stream-orchestrator.ts:561`)
    → `planning`;
  - failover target of `complex`, `tactical`, `planning` → `planning` /
    `tactical` (exact chains decided in the replay, Step 2);
  - `delegation.expensive_groups` (`delegation.ts:75`) → `planning`,
    `tactical` (and the TODO entry about the missing `planning` is
    resolved by the same change);
  - escalation levels (`escalation.ts:10`: operational, tactical,
    strategic) → top level becomes `planning`.
  This changes top-tier behavior; the Step 2 replay must quantify it
  before code.
- **D3 — decided 2026-10-25: clean up, breaking changes allowed.** `main`
  is 1.6.1 and STAYS on 1.x (verified against `origin/main` 2026-10-25);
  the reduction/rename lands in 2.0. No read-aliases: the owner's answer
  reads as rename without an alias period in 2.0.
- **D4 — decided 2026-10-26: five groups, named like the categories.** The
  group a category selects carries the category's name: `simple`,
  `standard`, `code_complex`, `design`, `planning`. `bulk_reader`,
  `code_writer` and `dynamic` are special groups outside that count.
  Measured basis: `docs/research/2026-10-26-group-candidate-equivalence.md`
  — `trivial`, `simple`, `scout` and `fallback` list identical models, so
  they become the one cheap group `simple`; `operational` becomes
  `standard`, `tactical` becomes `code_complex`. The three exits of the
  group `fallback` (unresolved target, classification failure, unknown
  category) and the tool follow-up step point at `simple`. A group exists
  only if it leads to other models or a measured need is documented.
- **D5 — decided 2026-10-26: `design` and `planning` stay separate
  groups.** The mechanism (floor, `score_by`, quality window) is good; with
  Claude + Mistral their candidate lists are identical today
  (`claude-sonnet-5-5` leads both on the Briefcase column), but a larger
  pool (OpenAI models, other setups) separates them. **Not decided yet:**
  what separates them in the *shipped* config. Proposal for the Step 2
  replay: `design` takes the "second guard" of the top band (lower floor,
  cheaper-first inside the band), `planning` stays best-first.
- **D6 — decided 2026-10-26: `continue` without a predecessor →
  `standard`.** A catch-all for the first prompt of a session (today:
  `tactical`, 9 log cases). With a predecessor the previous category is
  inherited as today. Model stickiness for `continue` is its own plan:
  `docs/plans/2026-10-26-continue-keeps-model.md`.
- **D7 — decided 2026-10-26: five categories.** `simple` and `code_simple`
  merge; `continue` is a signal, not a category. The model-visible
  taxonomy changes only in the next Laya training round (existing labels
  `code_simple` 12 + `simple` 5 map to `simple`); until then both
  categories select the same group, so the router needs no extra step.
- Out of scope here: the names `fallback_groups`, the classifier keys and the
  stage names — decided in `docs/plans/2026-10-25-fallback-naming.md`.

## Steps

0. Pin the CURRENT main (post PR #74) as the 1.x end state: no group
   changes ship before 2.0 is deliberately opened.

1. Characterization tests that pin today's mapping and failover chains.
   They pass on today's code — no red expected, stated per AGENTS.md §4.
2. Offline replay of the target layout on the log since 2026-10-15:
   selections and failover paths, one behaviour-change list per group,
   plus a proposal for what separates `design` from `planning` (D5).
3. Owner nod on that list.
4. Red-first implementation: a warning for a removed or renamed group a
   config still references, new mapping pins. No aliases (D3).
5. Shipped config, README, `docs/routing-flow.md`, CHANGELOG; migration
   note for the owner layer (backup, mode 600).
6. `npx tsc --noEmit`, `npx vitest run`, coverage thresholds unchanged,
   `npm run build`.

## Found on the way — separate problems, tracked in TODO.md

- Compaction's reason text says "routing to strategic", but it returns
  `code_complex` → `tactical` (1 of 62 compaction decisions; the other 61
  reuse the last model via a model hint).
- Tool follow-up steps use the `fallback` pool (free, cheapest first)
  behind the last model, whatever group the turn started in (code
  reading; impact not measured).
- `delegation.expensive_groups` omits `planning`; the read block covers
  `planning` today only because its two models are also members of
  `strategic`.
