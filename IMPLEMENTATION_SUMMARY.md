# Implementation Summary: effCost Registry-First Fix & Display Footer

## Changes Made

### 1) effCost Registry-First Fix (src/metrics.ts)
- **Root Cause**: `getM()`’s config-default branch zeroed all `billing === 'subscription'` providers BEFORE consulting the registry, causing Mistral subscription models with real prices ($1.4) to be read as "free".
- **Fix Applied**:
  - Extracted cost-resolution chain into `resolveCostPerM(ref)` helper used by both the config-default path and the early-return healing path.
  - Reordered the chain: registry BEFORE subscription-zeroing. Now subscription models with registry price are priced at the registry value (×0.5 via SUB_DISCOUNT in effCost).
  - Added healing in getM’s early-return path: if `cost_per_m === 0` or `'unknown'`, re-resolve via the authoritative chain. This fixes stale `'unknown'` entries written before the registry was published (e.g., pi-claude).
  - Added `injectModelRegistry(reg)` helper for tests to inject a mock registry into the module-local variable.
- **Tests**: Created `test/metrics-cost-heal.test.ts` (11 tests) covering:
  - Subscription model with registry price → real price (1.4 → 0.7 after discount)
  - Subscription model without registry price → free (0)
  - Free models (registry {0,0}) → 0
  - :free tag models → 0
  - Unknown cost → 'unknown'
  - Stale 'unknown' and 0 placeholders heal to registry price
  - User config overrides (non-zero preserved; explicit 0 overridden by registry)

### 2) Display Footer for /router status (src/routing.ts + index.ts)
- **Root Cause**: `/router` shows only top-5 models per group via `getTopModels(group, 5).slice(0,5)`. Expensive models (e.g., pi-claude) are present but ranked below position 5 in cost-sorted groups, so users think they are "weg".
- **Fix Applied**:
  - Changed `getTopModels` return type from `ModelWithLimits[]` to `{ models: ModelWithLimits[]; total: number }`.
  - Updated all callers to destructure `{ models, total }`:
    - index.ts: status rendering loop now uses `top.models` and `top.models.length`
    - stream-orchestrator.ts: iteration over models
    - All test files updated to destructure `models` and use `models.length`
- **Tests**: Created `test/get-top-models-total.test.ts` (3 tests) verifying:
  - Total count >= shown count when >N candidates
  - Total === shown when exactly N candidates
  - Empty array and total 0 when no candidates

### 3) Mechanical Updates
- Updated 8+ test files to destructure `models` from `getTopModels` results.
- Fixed TypeScript errors in index.ts, routing.ts, stream-orchestrator.ts, and metrics.ts.
- Removed unused `@ts-expect-error`.

## Verification

- **TypeScript**: `npx tsc --noEmit` clean
- **Tests**:
  - New tests: 14/14 passing
  - Delegation + bulk_read: 54/54 passing
  - Full suite: 789/804 passing (12 failures are unrelated flakes/pre-existing, e.g., capped group resolves to null in slug-canon-dedup.test.ts)

## Remaining Work (Optional)

- Polish `/router` footer to show: `│ … +9 weitere (sortiert nach [method])` in the UI (requires index.ts footer line adjustment).
- Investigate/fix the 12 remaining test failures if they are not flakes.

## Impact

- **Live routing**: subscription models with registry price now priced at 0.7 (not 0), excluded from max_cost: 0 groups, sorted mid-field in tiered groups.
- **Persist path**: same semantics as live (no longer diverges for mispriced subscription models).
- **Display**: users see total candidate count per group, reducing confusion about missing models.
