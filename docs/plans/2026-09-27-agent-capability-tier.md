# Plan: Agent-Capability Tier — keep non-agent models out of routing groups

**Date:** 2026-09-27
**Status:** approved by owner (brainstorming answers 2026-09-27, evening);
REVISED same evening per owner follow-up: the curated family list must be
**configurable identically for all users** — moved from a code table to the
config key `non_agent_model_prefixes` (Config, src/types.ts), shipped by the
embedded router-config.json, overridable in every layer (user/project
REPLACE semantics), absent/empty = explicitly off. The whitelist in load()
resyncs it from the static layered config (same shadowing protection as
`exclude`).
**Scope:** Phase A of the A+B decision; Phase B (learned session-quality demotion)
is a separate round.

## Problem

Two live incidents on 2026-09-27 showed that GDPval floors cannot keep
small-but-benchmark-capable models out of MAIN-agent work:

1. **Afternoon (pi-model-router-fork session):** the burned candidate chain
   landed on `mistral/mistral-small-latest`, which then served 35+ garbage
   main-agent turns (0–220-char toolUse loops, one 11k-char repetition dump).
2. **Evening (a second live session, 14:36Z):** the RAI/wiki prompt was
   legitimately classified `standard → operational` (min_gdpval 300);
   `mistral/mistral-small-2603` (slug-resolved GDPval 349.39) passed the
   floor, streamed "successfully" and ended its final turn with 248 chars
   announcing "Jetzt liefere ich die Evaluation …" — the evaluation never
   came. No detection could fire: the stream finished normally
   (stopReason `stop`, non-empty, not truncated).

Root insight: **GDPval measures benchmark/economics performance, not agentic
reliability.** mistral-small resolves to 349–478 (passes `operational` 300),
`magistral-small` even to 665 (passes `tactical` 600) — while being garbage
for real agent work. On top, the free-first cost preference sorts the
free-tier mistral experiment models to the FRONT of every group they can
enter.

Owner decision: a curated, family-pattern-based **agent-capability tier**
(option A) now, plus a learned session-quality demotion (option B) in a
separate round. The prompt classifier chain KEEPS these models — small
models are good enough for classification (explicit owner requirement).

## Design

### Module `src/agent-capability.ts` + config key `non_agent_model_prefixes`

- The curated family prefixes live in the config key
    MODEL ID (any path segment — provider re-hosts covered). Shipped default:
  - `mistral-small-` (349–478 GDPval; 2026-09-27 incidents, both sessions)
  - `magistral-small-` (GDPval 665 despite being a small reasoner)
  - `ministral-` (3b/8b/14b tiny models)
  - `voxtral-` (audio models serving text turns)
  - `codestral-` (code-completion family; 2508 also 422-broken via the
    direct transport)
- `isAgentCapableRef(ref, prefixes)` / `segmentsMatchingPrefix(id, prefixes)`
  predicates; absent/empty prefix list = tier explicitly OFF.
- Evidence-backed doc comments (incident dates) — the list is routing
  DATA, not a blocklist of shame: additions/withdrawals go through normal
  config edits and review.

### Wiring: `applyGroupFilters` (src/routing.ts)

Filter non-agent models right after the exclude rules, BEFORE the gdpval
gate. This covers all three consumers consistently (live resolution,
display, and the dynamic-config persist path). The classifier chain does
NOT call `applyGroupFilters` (verified by grep) — classification keeps the
small models, per owner requirement.

Consequences (deliberate):
- Non-agent models disappear from EVERY group, including `trivial`,
  `simple` and `fallback`. In a total outage the router now fails honestly
  (narration + PAYG escalation) instead of serving garbage.
- Explicit user HINTs and manual setModel are NOT touched — explicit user
  intent always wins.
- GDPval stays the tier signal WITHIN the agent-capable pool.

### What this is NOT

- Not a replacement for the user-config `exclude.models` entries (those
  remain as the surgical per-ref safety net).
- Not the learned demotion (Phase B): a tool-loop observer + model_health
  strike will be designed separately.

## Tasks

1. TDD: `test/agent-capability-tier.test.ts` — red first on current code.
   - group resolution (operational AND trivial) drops mistral-small-2603,
     mistral-small-latest, magistral-small-latest, ministral-8b-latest,
     voxtral-small-latest, codestral-2508 — for every provider variant
     (incl. `openrouter/mistral/mistral-small-3-2`, the classifier's top
     suggestion in the incident).
   - agent-capable models (incl. unscored-but-not-matching) remain.
   - classifier chain unaffected (predicates exist; chain has no group
     filter dependency — assert the probe list code path does not import
     the predicate).
2. `src/agent-capability.ts` with evidence comments.
3. Wire into `applyGroupFilters` + update the filter-step doc comment.
4. Non-vacuity: disable the wiring → the new tests go red.
5. Full suite + `tsc --noEmit` + `npm run build`.
6. Conventional commit, English, body explains the incidents.

## Risks / Notes

- Families are matched by model-ID prefix — a FUTURE model named e.g.
  `mistral-small-5-pro-agent` would still be filtered until the table is
  revised. Accepted: the table is versioned and reviewable.
- If a legitimate use case emerges for main-agent small models (e.g.
  ultra-cheap bulk summarization group), the group config gains a bypass
  later — not built now (YAGNI).
