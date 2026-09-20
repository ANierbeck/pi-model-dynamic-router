# Test Consolidation — Candidate Analysis

## Inventory facts (from Task 1)
- 93 test files, 806 tests (803 passed / 3 skipped), 11.72s wall time
- Age criterion (>6 months) matches **ZERO** files — oldest: routing.test.ts (2026-06-13); distribution: 1× June, 1× July, 35× Aug, 56× Sep 2026
- The original audit plan named `test/cache.test.ts` and `test/scratch-slug-debug.test.ts` as candidates — **NEITHER EXISTS**. Closest real files: `classification-cache.test.ts`, `router-cache-refresh.test.ts`.

---

## Candidate analysis

| File | Tests | Wall time | Last commit | What it tests (src functions) | Mock depth | Redundancy | Recommendation (why) |
|------|-------|-----------|-------------|-------------------------------|------------|------------|----------------------|
| **test/model-matcher-batched.test.ts** | 12 | 4ms | 263b2a6 (2026-09-20) | `plausibleMatchCandidates`, `matchModelsWithLLMBatched` (src/slug-matcher.ts) — live HINT resolution pipeline | High (LLM caller mocked) but tests real logic | 0 other files test these functions | **KEEP** — tests live router feature (HINT resolution) introduced in 263b2a6; no redundancy |
| **test/provider-shadow.test.ts** | 6 | 2ms | 5ff46e6 (2026-09-20) | `redundantAliasProviders`, `pruneRedundantCacheEntries` (src/provider-shadow.ts) — ghost purge / alias normalization | Mocks PROVIDER_MAP; tests shadowing logic | 0 other files test these functions | **KEEP** — tests live ghost-purge feature (5ff46e6); no redundancy |
| **test/classification-cache.test.ts** | 3 | 2ms | c4bb172 (2026-08-28) | `classifyPrompt` (src/classifier.ts) — LLM classification cache (LRU + TTL) | Mocks LLM caller; tests cache logic | 0 other files test classifyPrompt | **KEEP** — tests live classifier cache feature; no redundancy |
| **test/router-cache-refresh.test.ts** | 3 | 2ms | aed3855 (2026-08-15) | `Router.updateCache` — stale router cache refresh | Mocks Cache; tests Router.updateCache | 0 other files test Router.updateCache | **KEEP** — tests live cache refresh behavior; no redundancy |

> **Mock depth key:**
> - **High** = heavy mocking of external calls (LLM, Cache) but tests real internal logic
> - **Low** = minimal mocking, tests integration

---

## Honest conclusion

All four candidate files test **live, current architecture features** introduced in 2026-08/09. There is **no redundancy** and **no obsolete test code** in this set. Therefore:

- **No `.skip` or deletion is justified on the basis of age or obsolescence.**
- The real consolidation levers are elsewhere:
  1. **Timeout tuning** for the 10 slowest files (5.6–11.4s driveStream tests, ~86s of 116s total wall time) — these dominate runtime and are unrelated to the candidate files above.
  2. **File merges for redundancy** — to be confirmed in Task 3 (e.g., merge `model-matcher-batched.test.ts` with `slug-matcher.test.ts` if coverage overlaps).

**Recommendation:** Close this candidate list as "no deletions; focus on timeout tuning and merge opportunities". The plan in `docs/plans/2026-09-20-consolidate-tests.md` should be updated in Phase 3 to reflect this finding.

---

**File created:** `docs/plans/candidates_consolidation.md`
**Language:** English (project convention)
**Next:** Task 3 (Redundancy and coverage check) can now focus on merge candidates and timeout tuning.