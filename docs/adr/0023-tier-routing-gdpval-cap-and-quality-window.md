# ADR-0023: Restoring tier routing — per-group GDPval cap and quality-equivalence window

## Status

Accepted (2026-10-04, owner decision)

## Context

The tier routing design intent: graded groups — the flat-fee Mistral
subscription ("free tank", zai-glm-5-3) carries the daily code_complex load,
Claude-bridge models are reserved for genuinely heavy work (strategic:
compaction, HINT escalation) and for days when the Mistral quota is exhausted.

Live evidence 2026-10-04 (router.log): 65 prompts routed to tactical, 0 to
strategic. Cause chain:

1. **GDPval compression at the top of the score range** — claude-opus-5-5
   (1900), claude-sonnet-5-5 (1844), zai-glm-5-3 (1644): a 3% gap between the
   two Claude models, 11% between opus and glm.
2. **The `best` group method converges on the maximum** — tactical
   (min_gdpval 600, `method: best`) sorts purely by score, so opus-5-5 won
   every non-trivial prompt. Sonnet was a failure-only fallback; glm was
   never picked for demanding tasks at all.
3. **The limiting unit is the PROVIDER, not the model** — all claude-bridge
   models share one 5h subscription window. On 2026-10-04 that window burned
   down by ~08:50 (shared across the owner's parallel sessions), leaving the
   container session with zero workable models while the flat-fee Mistral
   tank sat unused.

The same compression also makes cost-blind selection wasteful: within a
3% quality gap, picking the higher-tier model burns quota/tokens for no
practical quality gain.

## Decision

Two mechanisms, combined per the owner's request (a gdpval cap combined with
cost-awareness inside the group):

1. **`max_gdpval` (per group, hard upper tier boundary)** — symmetric to
   `min_gdpval`, including the strict null-fails semantics (an unscored
   model fails a positive cap). Shipped config caps `tactical` at 1700:
   glm-5-3 (1644) and mistral-medium-3.5 (933) stay; opus-5-5 and
   sonnet-5-5 stay in `strategic` only. On a Mistral-quota day (422s),
   tactical escalates through its `fallback_groups` into strategic — the
   intended elasticity.

2. **`best_quality_window` (global, default 0.05)** — inside a `best` group,
   candidates within the window fraction of the group's best score are
   treated as EQUALLY GOOD. The cheapest wins (unknown cost sorts to the end
   of the pool); cost ties break to the LOWER score (least overkill). Models
   outside the window keep pure score order behind the pool. In strategic:
   opus (1900) and sonnet (1844) are within 5%, both subscription-priced
   equal → sonnet first, opus as the escalation. The window is deliberately
   different from `min_cost` sorting's higher-score-first tiebreak: within an
   equivalence window, quality is equal BY DEFINITION, so the cheaper-tier
   model is the rational pick.

## Consequences

- tactical daily driver: zai-glm-5-3 (the free tank), mistral-medium-3.5 as
  in-group fallback, Claude via strategic escalation only.
- strategic daily driver: claude-sonnet-5-5; opus-5-5 reachable on failure —
  the 5h Claude window now serves both tiers only when actually needed.
- The `top_k` display and live resolution share `sortBy`, so `/router`
  reflects the new ordering.
- Cap values are landscape-tuned (1700 against the 2026-10 score range);
  new top-tier models may require retuning the cap, unlike the window, which
  adapts automatically. This trade-off was accepted for determinism.
- The window applies ONLY to `method: best` groups; `tiered`/`min_cost`
  groups keep their existing cost-first semantics.
