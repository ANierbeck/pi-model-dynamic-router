# Group quality floors relative to the scored pool instead of absolute GDPval numbers

**Status:** proposed — 2026-11-24. Depends on
`2026-11-24-gdpval-effort-variant.md` (comparable scores first); the two
may land in either order, but the shipped pct values should be calibrated
against variant-aware scores.

**Verified against:** `main` @ `d29f01c`; `src/routing.ts` `applyGroupFilters`
(min_gdpval L332, min_gdpval_pct L337–345, max_gdpval L356);
`src/types.ts:69–118` (GroupConfig fields); `router-config.json`
(shipped floors: standard 300, code_complex 1630–1700, design 1600);
`src/commands.ts:1795` (`/router config` shows both forms);
live evidence in `docs/plans/2026-11-24-gdpval-effort-variant.md` Problem
(code_complex collapsed to Opus-only / empty when AA re-scored the
competition).

## Problem

Group floors are absolute GDPval numbers calibrated on one snapshot of
AA's scale (2026-10-04, ADR-0023). When the scale moves — a re-scrape, a
new variant labelling, a model family change — the floors do not move
with it: `code_complex` went from 6 candidates (2026-11-12) to 1
(2026-11-21) to 0 (2026-11-24) without anyone touching the config, and
turns silently fell through to `planning`. The relative mechanism exists
but is half-wired:

- `min_gdpval_pct` is an `else if` after `min_gdpval` — setting both
  silently ignores the pct form (`src/routing.ts:337`).
- Its base is the **pre-gate** pool: `refs.map(L.gdp)` over the input list,
  including refs the exclude / non-agent / dedup gates drop later, so
  excluded models inflate the max the threshold is computed against.
- There is **no `max_gdpval_pct`**, so a relative upper bound (the
  `code_complex` "not above the planning tier" intent) still needs an
  absolute number.
- Empty result after gating is fail-closed (`resolveGroup` → null →
  `fallback_groups`), which is right — but it makes absolute floors the
  thing that breaks first.

## Solution

1. Add `max_gdpval_pct` (symmetric to `min_gdpval_pct`, same pool rule).
2. Make the pct gates independent of the absolute ones: absolute floor
   AND pct floor AND absolute cap AND pct cap may all apply; a ref must
   pass each configured gate. (Behaviour change: today absolute wins by
   `else if`. Shipped config uses only one form per gate, so no shipped
   behaviour changes except where both were set.)
3. Compute the pct base over the pool **after** exclude / non-agent /
   dedup / auth gates, before the quality gates — the pool the user
   actually chooses from.
4. Guard small pools: if fewer than N scored refs remain (N = 3,
   constant), skip the pct gates and keep the absolute ones only.
5. Switch the shipped `router-config.json` group floors to pct form
   (derived, no model names, §9-safe), calibrated on variant-aware scores:
   e.g. `code_complex` = coding column in the top band of the pool.
   Absolute values stay valid for the user layer and as fallback.
6. `/router config` prints both forms and which one is active.

## Open decisions

1. **The pct values per shipped group** — needs a measurement over the
   current scan cache (how many models sit in each band). Owner picks
   after seeing the distribution; placeholder: standard ≥ 40 % of pool
   max, code_complex top 15–25 %, design top 25 %, planning top 10 %.
2. **Upper bound for the top group:** `planning` has no cap today;
   should it get `max_gdpval_pct: 100` (i.e. none) explicitly, or stay
   uncapped by omission?
3. **Interaction with `best_quality_window`:** unchanged (it operates on
   scores within the already-gated pool).
4. **User configs that set absolute floors** (like today's
   `code_complex` in `router-config.user.json`): keep working unchanged;
   document the precedence in `docs/config-reference.md`.
5. **Timing:** 2.0.0 (ranking change for every install) or a later
   minor? Owner decides; recommended with 2.0.0, after plan
   `2026-11-24-gdpval-effort-variant.md`.

## Steps

- [ ] `max_gdpval_pct` gate + independent-gate refactor in
      `applyGroupFilters`, red-first tests (both forms set, small pool,
      pct base after exclude gates).
- [ ] Measurement of the band distribution over the current cache →
      `docs/research/` note; owner picks the shipped pct values.
- [ ] Shipped config switch + `/router config` output.
- [ ] Docs + CHANGELOG + AGENTS §4 count; migration note for user-layer
      absolute floors.
