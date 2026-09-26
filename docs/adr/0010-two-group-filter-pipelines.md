# ADR-0010: Two group-filter pipelines (persist vs live) — current state and divergences

**Status**: Proposed (2026-09-26). This ADR records the current state, which
was found during a test-suite analysis, and proposes a fix. The fix needs the
owner's decision (see "Decision").

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

The two code comments contradict each other. The doc comment on
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

Pending owner confirmation. Recommendation: **B**, plus the empty-list
guard as a separate small fix. Open question for the owner: for
`max_cost_per_m` with an unknown price, should subscription/local models be
kept (persist semantics) or dropped (live semantics)?

## Consequences

If B is adopted:
- One implementation per gate; display, live and persist agree by
  construction.
- `test/dynamic-config.test.ts` and `test/apply-group-filters.test.ts`
  need one reconciled expectation for `max_cost_per_m`.
- The `applyGroupFilters` doc comment becomes true.

Until then, `/router` output and the persisted `router-config.dynamic.json`
may disagree for `max_cost`/`max_cost_per_m` groups, and an empty `$0`
group can leak cloud subscription models at request time.
