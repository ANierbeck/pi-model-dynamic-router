# Audit Plan: ~800 Tests (suspicion of stale/unused tests)

## Goal
Identify and clean up stale/unused tests to make the test suite leaner and
faster, without losing functionality.

## Criteria for "stale/unused"
- Tests unchanged for >6 months whose functionality is covered by newer tests.
- Tests that only exercise mocks/stubs, no router logic.
- Tests covered redundantly by other tests (e.g. several tests for the same
  function with slightly different mocks).
- Tests referencing outdated router architecture (e.g. pre ADR-0007, pre
  delegation, pre bulk-read).

## Tools & methods
- `vitest list` / `vitest list --exclude "**/node_modules/**"` → list all test files
- `git log --since="6 months ago" --oneline -- test/` → last changes per test file
- `rg "describe\(|it\(" test/*.test.ts | wc -l` → number of test blocks per file
- `npx vitest run --reporter=verbose` → which tests actually run (incl. time per test)
- `npx vitest list-unused` (if available) or manual analysis

## Step-by-step plan

### Phase 1: Inventory (1–2h)
1. **List all test files**
   ```bash
   find test -name "*.test.ts" -type f | sort > /tmp/all_tests.txt
   wc -l /tmp/all_tests.txt
   ```
   → Current: 93 test files (804 tests).

2. **Last change per test file**
   ```bash
   for f in $(cat /tmp/all_tests.txt); do echo -n "$f "; git log --oneline -n 1 -- "$f" 2>/dev/null || echo "no commits"; done | sort -k2
   ```
   → Focus on files without commits for >6 months.

3. **Count test blocks per file**
   ```bash
   for f in $(cat /tmp/all_tests.txt); do echo -n "$f "; rg "describe\(|it\(" "$f" | wc -l; done | awk '$2<5 {print}'
   ```
   → For files with <5 test blocks, check whether they are redundant.

4. **Measure runtime per test file**
   ```bash
   npx vitest run --reporter=verbose --no-coverage 2>&1 | grep "Test Files" -A 2
   ```
   → Identify the slowest files (e.g. >5s per file).

### Phase 2: Analysis (2–4h)
1. **Redundancy check**
   - For each test file, check whether the covered functionality is already
     covered by other tests (e.g. integration, routing.integration).
   - Example: `test/provider-shadow.test.ts` vs.
     `test/routing.integration.test.ts` (provider shadowing logic).

2. **Mock depth check**
   - Tests that only test mocks of mocks (e.g. `test/cache.test.ts` with pure
     cache behavior) can often be dropped, since the cache logic in
     `src/cache.ts` is checked indirectly by other tests.

3. **Architecture history check**
   - Tests created before ADR-0007 (delegation) or before bulk-read and not
     adapted since are consolidation candidates.

4. **Mark flaky tests**
   - Tests that often fail in CI and need manual reruns: document separately
     (don't delete — fix them).

### Phase 3: Cleanup (2–3h)
1. **Deactivate tests instead of deleting them**
   - Before deletion: change tests to `.skip` and create a PR with rationale.
   - Example:
     ```ts
     describe.skip('legacy: old architecture', () => { ... })
     ```

2. **Update documentation**
   - Add removed/skipped tests to `CHANGES.md` or
     `IMPLEMENTATION_SUMMARY.md`.
   - Commit message: `test: deactivate legacy tests for old architecture (no functional change)`

3. **CI verify**
   - After every batch: `npx tsc --noEmit && npx vitest run` — ensure nothing breaks.

### Phase 4: Validation (1–2h)
1. **Measure the new baseline**
   - After cleanup: compare the suite runtime.
   - Example:
     ```bash
     git stash
     npx vitest run --run --reporter=basic > /tmp/before.txt
     git stash pop
     npx vitest run --run --reporter=basic > /tmp/after.txt
     diff /tmp/before.txt /tmp/after.txt
     ```

2. **Check coverage**
   - Compare `npx vitest run --coverage` before/after: no new uncovered lines.

3. **Manual verification**
   - Test `/router status` and `/router model <name>` manually to avoid
     introducing a regression.

## Recommended initial candidates for deactivation/skipping

| Test file | Rationale | Alternative tests |
|-----------|-----------|-------------------|
| test/cache.test.ts | Tests cache objects only, no router logic | Covered indirectly by routing.integration.test.ts |
| test/model-matcher-batched.test.ts | Old model matching, pre GDPval reengineering | routing.integration.test.ts, apply-group-filters.test.ts |
| test/scratch-slug-debug.test.ts | Debug file, no tests | – |
| test/provider-shadow.test.ts (parts) | Shadowing logic, pre ADR-0007 | routing.integration.test.ts |

## Risks & trade-offs
- **Delete vs. skip:** prefer skip, to allow a fast revert when needed.
- **Coverage:** when in doubt, keep the file and only reduce tests.
- **CI flakes:** create a separate issue for flaky tests.

## Effort
- **Inventory:** 1–2h
- **Analysis:** 2–4h
- **Cleanup:** 2–3h
- **Validation:** 1–2h
- **Total:** ~8h (1 workday)

## Next steps
1. Run the inventory and create the candidate list.
2. Create a PR with the `.skip` changes and wait for review.
3. After approval: delete or finally skip.

---
**Open question (2026-08-28):** whether to start with the inventory, or first
verify the footer-polish changes in practice.
