# ADR-0010: One group-filter rule set for persist, live and display

**Status**: Accepted and implemented (2026-09-26). The state below was found
during a test-suite analysis. The owner chose option B and decided that a
subscription model without a price drops out of `max_cost_per_m` groups.

## Context

A group's candidate list is computed on three paths:

| Path | Entry point | Filter function |
|---|---|---|
| Persist (scan → `router-config.dynamic.json`) | `generateDynamicConfig` (index.ts) | `filterModelsForGroup` (src/dynamic-config.ts) |
| Live (every request) | `Router.resolveGroup` (src/routing.ts) | `applyGroupFilters` (src/routing.ts) |
| Display (`/router`) | `Router.getTopModels` | `applyGroupFilters` |

The persisted `models` list of a group is an **allow-list** at resolve time:
`resolveGroup` only considers `allDiscoveredRefs()` that also appear in
`g.models`. Effectively, the live result is the **intersection** of both
pipelines.

Until 2026-09-26 the two code comments contradicted each other (the
`applyGroupFilters` doc comment has since been corrected). The doc comment on
`applyGroupFilters` says it is shared by all three paths, including
`generateDynamicConfig` ("A1 consolidation"). The comment at the call site in
`index.ts` (step 6 of `generateDynamicConfig`) says the persist path does
**not** use it, **deliberately**: the live path treats `max_cost: 0` like any
other cap and keeps unknown-cost subscription/local models, and adopting that
"would break the trivial/simple groups' free-only guarantee". The index.ts
comment matches the code. The persist path has its own implementation with
different semantics:

| Gate | Persist (`filterModelsForGroup`) | Live (`applyGroupFilters`) |
|---|---|---|
| `max_cost: 0` | `admitsZeroCostGroup`: only local providers, or free models on pay_per_token providers. Cloud subscription stays **out**. | `effCost ≤ 0`. A subscription model without a registry price resolves to cost 0 → **in**. |
| `max_cost > 0`, unknown cost | always out | out for pay_per_token, in for subscription/local |
| `max_cost_per_m` | every non-pay_per_token model **in** (no price needed) | unknown price → **out** for every billing type |
| `min_gdpval` | `gdpval ≥ min` on already-scored models (unscored non-static models are dropped earlier in `buildModelsWithMetadata`) | `≤ 0` = no gate; positive threshold drops unscored models |
| `min_gdpval_pct`, group-level `exclude_providers` / `exclude_models` | not applied (only the global `exclude` rules are) | applied |
| `min_context_length` | same rule, separate code | same rule, separate code |

Verified with a probe on 2026-09-26 (subscription model without registry
price, pay_per_token model with unknown price):

```
{max_cost: 0}        live: [sub-model]   persist: []
{max_cost: 1}        live: [sub-model]   persist: [sub-model]
{max_cost_per_m: 1}  live: []            persist: [sub-model]
```

Both sides are pinned by tests with **opposite intent**:
`test/dynamic-config.test.ts` ("applies max_cost_per_m: … keeps
subscription") vs. the `applyGroupFilters` INVARIANTS comment and
`test/apply-group-filters.test.ts` ("max_cost_per_m drops models with
unknown prices (always, regardless of billing)").

### Practical impact today

- **`max_cost: 0` groups (trivial, simple, scout, fallback, …): latent
  leak.** The persist rule wins as long as the persisted list is
  non-empty. But `resolveGroup` checks `g.models?.length`, so an **empty**
  persisted list (a scan that found no local or free model for the group)
  counts as "no list". Then the live filter runs over *all* discovered
  refs and admits cloud subscription models into a $0 group. This is the
  very case `admitsZeroCostGroup` was written to prevent.
- **`max_cost_per_m`: no effect with the bundled config**, because no
  bundled group uses it. It becomes live as soon as a user config sets it.
- `/router` (display) follows the live semantics, so it can show
  candidates the persisted list will never allow, and vice versa.

## Decision Drivers

- One rule per gate. Two implementations of the same gate drift, and they
  already have.
- `$0` groups must never admit a model that can bill money (the documented
  intent of `admitsZeroCostGroup`).
- Display must show what the live path will actually pick (the original A1
  motivation).
- The persist path has legitimately different needs: preserving pinned
  static models, token-signature dedup, cluster collapse before gates.
  Those must not be lost.

## Options Considered

**A — Leave as is, fix the doc comment.** Cheapest, and the divergence
was deliberate. But it keeps the empty-list leak, the display mismatch and
the contradictory tests. Rejected as a long-term state.

**B — One shared rule set that carries the persist semantics
(recommended).** Move `admitsZeroCostGroup` into `applyGroupFilters` as the
single `max_cost: 0` rule. The live path then enforces the free-only
guarantee too, instead of relying on the persisted allow-list for it. This
aligns live with persist and does not weaken the guarantee, which is what
the index.ts comment was worried about. Decide one `max_cost_per_m`
semantic for unknown prices. Then let the persist path call the shared
function, and keep persist-only steps (static-model preservation,
token-signature dedup, cluster collapse) in `dynamic-config.ts` around it.
Reconcile the contradicting tests to one intent.

**C — Drop the persisted allow-list and filter only live.** Removes the
intersection effect entirely, but the persisted list also carries
streamability checks (`hasRegistryModel`) and pinned static models, and
the 30-day scan cache is what keeps startup cheap. Larger change, not
needed to fix the divergence.

Independent of A–C: **treat an empty persisted list as "no candidates", not
as "no list"** in `resolveGroup` (distinguish `models: []` from
`models` absent). This closes the `$0` leak on its own.

## Decision

Option **B**, implemented on 2026-09-26:

1. **One rule set.** `applyGroupFilters` (src/routing.ts) is the only place
   the group gates are implemented. It takes an optional `lookups` argument
   (`GroupFilterLookups`: gdp, cost, price, contextWindow, isFree). Live and
   display use the metrics module (`liveGroupFilterLookups`). The persist
   path's `filterModelsForGroup` passes the values it already computed per
   model. The static-model loop in `collectGroupModels`, a third copy of the
   cost gates found during implementation, now calls `applyGroupFilters` as
   well.
2. **`max_cost: 0`**: the persist rule wins. `admitsZeroCostGroup` moved to
   routing.ts: local providers, or free models on explicitly pay_per_token
   providers. Cloud subscription models stay out on every path.
3. **`max_cost > 0`**: free models pass. Unknown cost is billing-aware
   (subscription/local kept, pay_per_token dropped). This was the live
   semantic. The persist path used to drop unknown-cost subscription models.
4. **`max_cost_per_m`** (owner decision): local and free token-based models
   pass. Everything else needs a concrete price under the cap, so a
   subscription model without a price **drops out**.
5. **No empty-list guard.** It was proposed above, but it was not adopted.
   Persisted groups can legitimately be empty (observed: `complex`,
   `strategic` and `tactical` with `models: []`), and those groups then
   route through all discovered refs. Treating `[]` as "no candidates" would
   switch them off. The guard is also no longer needed: the leak it targeted
   came from the live `max_cost: 0` rule, and that rule now keeps cloud
   subscription models out on its own.

Observed while implementing: the live install (`dist/`) had no
`router-config.dynamic.json` after a rebuild while the scan cache was still
valid. All groups therefore ran without persisted lists, and the `$0` leak
was active. The unified rule closes it regardless of whether a persisted
list exists.

## Consequences

- Display, live and persist agree by construction. The rule text lives in
  one doc comment (`applyGroupFilters` INVARIANTS). Guarded by
  `test/group-filter-parity.test.ts`, which compares both paths on the same
  data for `max_cost` 0/2, `max_cost_per_m`, `min_gdpval` and
  `exclude_providers`, and fails on the pre-change code.
- Behaviour changes:
  - Subscription models without a price leave `max_cost_per_m` groups
    (persist path). No bundled group uses `max_cost_per_m`.
  - Unknown-cost subscription models stay in positive `max_cost` groups
    (persist path).
  - Cloud subscription models leave `$0` groups (live and display paths).
  - Group-level `exclude_providers`, `exclude_models`, `min_gdpval_pct` and
    the registry-first context window now also apply at persist time.
  - Hand-listed group `models` now pass the same gates as discovered ones,
    including `min_context_length`. A pinned model whose context window is
    unknown in both the registry and the scan cache drops out of a group
    with `min_context_length`, following the strict null-fails rule. Before,
    the static loop only checked score and cost.
- The live "is free" check uses the same definition as the persist path:
  `:free` tag, `free_models` list, a $0/$0 price, or `effCost === 0` on a
  pay_per_token provider. It does **not** use the scan cache's
  `cost_per_m === 0`, so a scan placeholder never overrides a registry
  price. The first implementation got this wrong; a code review caught it
  on 2026-09-27.
- `test/dynamic-config.test.ts` and `test/apply-group-filters.test.ts` were
  reconciled to these rules.
