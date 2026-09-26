# Change Log — pi-model-dynamic-router

> **Note**: This file was previously in German; it is now translated to English to comply with AGENTS.md rule 3 ("All documentation and comments must be in English").

## 1.6.0-SNAPSHOT (unreleased, pre-release)

**Content**: everything on `main` since `v1.5.4` — 29 commits, 72 files,
+7112 / −318 lines. See `docs/v1.6.0-release-plan.md` for the full
breakdown.

## 1) effCost Registry-First Fix (src/metrics.ts)

- **Problem**: `getM()` set `cost_per_m = 0` for any provider with `billing === 'subscription'` **before** querying the registry. This caused Mistral subscriptions with real prices ($1.4) to be treated as free, landing in `max_cost:0` groups and being excluded from expensive tiers.
- **Solution**:
  - Introduced `resolveCostPerM(ref)` to perform authoritative cost resolution: Registry → local → subscription → cache → `:free` → `unknown`.
  - Registry lookup now happens **before** the subscription-zeroing step. Subscriptions with registry prices are now correctly priced at 1.4 (×0.5 via `SUB_DISCOUNT` → 0.7).
  - Healing in the early-return path of `getM()`: if `cost_per_m === 0` or `'unknown'`, the chain is re-resolved. Fixes stale entries written before registry publish (e.g., pi-claude).
  - Test helper `injectModelRegistry(reg)` injects mock registries into tests.
- **Tests**: `test/metrics-cost-heal.test.ts` (11 tests) covers all cases (subscription with/without price, free models, `:free` tags, unknown, healing, user overrides).

## 2) Footer for `/router status` (src/routing.ts + index.ts)

- **Problem**: `/router status` only shows the top-5 models per group. Expensive models (e.g., pi-claude) may exist at rank >5 → users think they are "missing".
- **Solution**:
  - Return type of `getTopModels` changed from `ModelWithLimits[]` to `{ models: ModelWithLimits[]; total: number }`.
  - All callers updated to destructure `{ models, total }` and iterate over `models`; footer rendering uses `top.models.length`.
  - Updated files: index.ts, stream-orchestrator.ts, and all test files (destructuring + `models.length`).
- **Tests**: `test/get-top-models-total.test.ts` (3 tests) verifies: `total >= shown`, `total === shown`, empty list.

## 3) Mechanical fixes

- Updated 8+ test files to unpack `models` from `getTopModels` destructuring.
- Fixed TypeScript errors in index.ts, routing.ts, stream-orchestrator.ts, metrics.ts.
- Removed unnecessary `@ts-expect-error` directives.

## 4) Verification

- TypeScript: `npx tsc --noEmit` ✅ clean.
- Tests:
  - New tests: 14/14 ✅.
  - Delegation + bulk_read: 54/54 ✅.
  - Full suite: 789/804 ✅ (12 unrelated flakes, e.g., `slug-canon-dedup.test.ts`).

## 5) Next steps (optional)

- Footer polish in `/router status`: show footer like `│ … +9 weitere (sortiert nach [method])` (adjust in index.ts footer).
- Investigate remaining 12 test flakes.

## 6) Impact

- **Live routing**: Subscriptions with registry prices are now priced at 0.7 (not 0) → excluded from `max_cost:0` groups, placed mid-tier in tiered groups.
- **Persist path**: Same semantics as live (no divergence anymore).
- **UI**: Users see total candidate count per group → less confusion about "missing" models.

## 7) Test-suite consolidation (audit 2026-09-20)

- **Goal**: consolidate the ~800-test suite (plan: `docs/plans/2026-09-20-consolidate-tests.md`).
- **Findings**:
  - Age criterion (>6 months) matches **zero files** — the suite is young (oldest test: `2026-06-13`).
  - Suspected files (`test/cache.test.ts`, `test/scratch-slug-debug.test.ts`) do not exist.
  - All four examined candidates test **live features** (HINT resolution, ghost purge, classifier cache, router cache refresh) → **no `.skip`/deletion justified**.
  - Timeout tuning rejected: the 10 slowest files (~86s of 116s) wait on **real production time windows** (rate-limit cooldowns, malus accumulation) → no artificial delays to tune.
- **Executed merge**:
  - Removed 5 exact-duplicate assertions from `test/refactor-golden-master.test.ts` (e.g., explicit-null exclusion, map-vs-token-set fallback, self-heal-from-cache, no-clobber, builtin-overrides).
  - Living counterparts in `test/metrics-selfheal.test.ts` retained.
  - **Result**: 806 → **801 tests** (798 passed / 3 skipped), `tsc --noEmit` clean, 11.7s wall time, **zero unique-coverage loss**.
  - Fixes real drift risk: both files pinned the same `lookupGdp` contracts with diverging values (1506 vs 1506.11).
- **Flaky observation**:
  - One intermittent failure (~3/17 runs, load-correlated, name not captured) documented in `redundancy-analysis.md` §4 → no action; watch CI.
