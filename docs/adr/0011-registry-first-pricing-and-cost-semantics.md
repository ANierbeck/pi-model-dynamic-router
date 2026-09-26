# ADR-0011: Registry-first pricing, the free definition, and unknown-cost semantics

**Status**: Accepted (documented retroactively 2026-09-26). The decisions
were made in the 1.5.x line (registry-cost fixes 1.5.2 / 1.5.3, 2026-09-10)
and in the A1 consolidation. Sources: `src/metrics.ts` (`resolveCostPerM`,
`getM`, `registryCost`, `lookupPrice`, `effCost`, `isFreeModelRef`,
`billingTier`), and the tests listed below.

## Context

Routing needs a price for every candidate: `max_cost` / `max_cost_per_m`
gates, `min_cost` sorting, billing-preference ordering, the display. Prices
come from several sources of very different quality: Pi's model registry,
the router's scan cache (with placeholder zeros for custom providers),
user config, OpenRouter's pricing cache, provider-level estimates. Before
the registry-first change, any provider that Pi registered through another
channel (extensions, `models.json`, CLI flags) fell through the router's own
fallbacks to `'unknown'`. `min_cost_if_all_priced` groups then fell back to
best-GDPval ordering and picked the most expensive model in `trivial`.

## Decision Drivers

- Pi's `modelRegistry` is the only source that is guaranteed to exist for
  every streamable model. `Model.cost` is a required field there. The
  router must use Pi's public API, never read Pi's config files directly.
- A `$0` price is ambiguous: free, subscription (sunk cost), local, or just
  "not priced yet". The system must not read "not priced" as "free".
- Every place that asks "is this free / which billing tier?" must give the
  same answer (display, budget check, routing).

## Options Considered

- **Keep the router's own price chain as primary** (config → pricing
  cache → OpenRouter backfill → provider estimate). This was the state
  before 1.5.2. Rejected: it misses every provider Pi registered through
  other channels.
- **Registry-first, own chain as fallback (accepted).**
- **Treat `cost_per_m: 0` as "forced free".** Rejected: scan placeholders
  and unpriced models are also 0. The `:free` tag and `free_models` list
  are the explicit escape hatch instead.

## Decision

1. **Resolution order** (`resolveCostPerM`, `lookupPrice`):
   registry `Model.cost`, including the `:free`-stripped id,
   model-map.yaml sibling ids, and the provider's `pricingAlias`
   (e.g. `mistral-zai → mistral`) → local provider = 0 → subscription
   without a registry price = 0 → cache placeholder 0 → `:free` tag /
   `free_models` = 0 → `'unknown'`.
2. **A registry `{0, 0}` means "let the caller decide"**, not "free".
   `registryCost` returns `null` for it, so the local/subscription/free
   detection applies.
3. **`0` is "unpriced", not "forced free".** A user `cost_per_m: 0` does not
   pin a model as free, and the registry price wins. A non-zero user value is
   real and is never overwritten.
4. **Placeholder healing** (`getM`): stale `'unknown'` and `0` entries are
   re-resolved once the registry is published. Resolved non-zero values are
   never touched.
5. **Single free definition** (`isFreeModelRef`): local provider, `:free`
   tag, `free_models` entry (any normalization), or discovered
   `cost_per_m === 0`. `billingTier` (0 free, 1 subscription, 2 local,
   3 payg) builds on it. Local models are free in the cost sense but form
   their own tier for ordering.
6. **Unknown cost in gates**: one rule set for all paths, see ADR-0010.
   `max_cost: 0` admits only local and free token-based models;
   `max_cost > 0` keeps unknown-cost subscription/local models;
   `max_cost_per_m` needs a concrete price except for local and free
   token-based models.

## Consequences

- Pricing works for any provider Pi knows, without per-provider router
  code.
- A model can be "free" for `paid_models_from` (cost sense) and
  "local" for ordering (tier sense). Both are intended.
- Every new price source must slot into this order, not bypass it.

Tests pinning this: `metrics-cost-heal`, `registry-cost-lookup`,
`registry-cost-alias-matching`, `unified-free-definition`,
`min-cost-unknown-sort`, `billing-preference`, `max-cost-filter`,
`apply-group-filters`.
