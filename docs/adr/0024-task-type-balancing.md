# ADR-0024: Task-type balancing — continuations inherit, category mapping configurable

## Status

Proposed (2026-10-05) — awaiting owner approval. Amends the *Consequences*
of [ADR-0023](0023-tier-routing-gdpval-cap-and-quality-window.md); the
`max_gdpval` cap and the quality window themselves stay.

## Context

ADR-0023 made the mid-tier subscription model (zai-glm-5-3) the
`tactical` daily driver on the assumption that its tank was effectively
free, with Claude reserved for strategic escalation. Live data
(2026-10-02..05) shows three problems with the result:

1. **The mid-tier tank is not free.** Capped subscriptions consume a
   finite monthly allowance; nearly all routed work landing on one such
   model can exhaust it early in the period while a flat-fee tank with
   no cost cap sits idle.
2. **Continuations lose their task type.** The classifier defines
   `fallback` as "ambiguous, or a short continuation/confirmation of
   previous work" and `fallback` always maps to `tactical`. About 60% of
   turns were continuations — a design discussion's "ok, continue" drops
   to the mid tier.
3. **Opus outranks sonnet in top-tier groups**, contrary to ADR-0023's
   stated consequence, because claude-sonnet-5-5 has no cost entry and
   the quality window sorts unknown cost to the end of the pool.

## Decision (proposed)

1. **Continuations inherit the previous turn's category.** A `fallback`
   classification with an available previous category routes like that
   category; without history, the configured default applies.
2. **The category→group mapping becomes configurable** (user/project
   config layer, merged over the built-in table). Shipped defaults are
   unchanged — pay-per-token users see no cost increase; users with flat
   subscriptions can, for example, route `code_complex` to the top tier.
3. **Subscription bridge models are priced consistently** so the quality
   window's least-overkill tiebreak works as ADR-0023 intended (sonnet
   before opus).
4. **Generic budget pacing** is deferred; if added, it is provider-level,
   unit-agnostic (USD or tokens), and off by default.

## Consequences

- Demanding work and its continuations reach top-tier models; routine
  work stays on the mid tier. The mid tier remains the overflow target
  when a subscription window is exhausted (existing `fallback_groups`).
- Personal routing policy moves into configuration instead of code.
- Top-tier models via the bridge are slower (~77 vs ~393 tokens/s
  measured), so the split deliberately limits them to demanding tasks.
- Inheritance adds session state to classification; it must not override
  HINT or compaction routing and needs a clear reset rule.

## Plan

[docs/plans/2026-10-05-task-type-balancing.md](../plans/2026-10-05-task-type-balancing.md)
