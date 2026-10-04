# Test Suite Consolidation — Implementation Plan

> **EXECUTION PROTOCOL (2026-09-20, appended after completion):**
> The data-driven execution **partially inverted** the plan — the expected
> outcome of an audit:
>
> - **Task 1 (inventory):** The age criterion (>6 months) matches **ZERO**
>   files (oldest: 2026-06-13). Two plan candidates (`test/cache.test.ts`,
>   `test/scratch-slug-debug.test.ts`) **do not exist**.
> - **Task 2 (candidates):** All 4 existing candidates test **live features**
>   (HINT resolution, ghost purge, classifier cache, router cache refresh)
>   → **NO .skip justified**. → `docs/plans/candidates_consolidation.md`
> - **Tasks 5–8 (.skip removals): DROPPED** (data-based owner decision 2026-09-20:
>   merges only where actual duplication exists).
> - **Task 3 (redundancy):** Exactly ONE real merge candidate: the lookupGdp
>   describes in `refactor-golden-master.test.ts` duplicate
>   `metrics-selfheal.test.ts`. The wildcard and token-set fallback tests are
>   **unique** and were kept. → `docs/plans/redundancy-analysis.md`
> - **Phase-3 execution:** 5 exact duplicates surgically removed from
>   `refactor-golden-master.test.ts` (not whole-file .skip), with NOTE comments
>   at each location. Suite: 806 → **801 tests**, all green, tsc clean,
>   **zero unique-coverage loss**.
> - **Task 4 (flaky):** One intermittent failure (~3/17 runs, only under load,
>   name not capturable — an output-piping error of the orchestrator,
>   documented as a lesson). No deactivation. → redundancy-analysis.md §4
> - **Timeout tuning: REJECTED** (dead end per the analysis): the 10 slowest
>   files wait out **real production time windows** (rate-limit cooldowns,
>   penalty accumulation) — no artificial delays left to shorten.
> - **Tasks 11–12 (PR / final deletion): MOOT** — there was nothing to delete;
>   the consolidation landed as a direct commit on main (project convention).
>
> **Conclusion:** The suite is healthy — young, nearly redundancy-free, with
> deliberate multi-path coverage. The only real lever was the duplicate
> documentation of the same lookupGdp contract in two files (drift risk 1506
> vs. 1506.11 — now fixed).

> **REQUIRED SUB-SKILL:** Use `/skill:executing-plans` after this plan to work
> through the tasks step by step.

**Goal:** Reduce the ~800 tests to a maintainable, performant suite by
identifying and deactivating stale/unused tests, without losing functional
coverage. Keep reversibility via `.skip` instead of deletion.

**Architecture:**
- **No functional changes** — test cleanup only.
- **TDD principle:** Before deactivating/deleting, ensure the suite stays green
  and coverage does not drop.
- **Reversibility:** `.skip` instead of deletion; PR with rationale, review
  before final deletion.
- **Data-driven:** inventory via `vitest list`, `git log`, `rg`, and execution
  times.

**Tech Stack:**
- vitest 1.x
- TypeScript
- bash / Node.js
- git

---

## Preparation

### Task 0: Secure worktree and baseline
**Files:**
- Create: (no new files)
- Modify: `.gitignore` (optional)

**Steps:**
1. **Commit the current state** (if not already done):
   ```bash
   git add .
   git commit -m "chore: baseline before test consolidation"
   ```
2. **Measure baseline runtime and coverage:**
   ```bash
   npx vitest run --run --reporter=basic > /tmp/before_consolidation.txt
   npx vitest run --run --coverage --reporter=basic > /tmp/coverage_before.txt
   echo "Baseline saved in /tmp/before_consolidation.txt and /tmp/coverage_before.txt"
   ```

**Expected:**
- `before_consolidation.txt` contains the test results before changes.
- `coverage_before.txt` contains the code coverage before changes.

---

## Phase 1: Inventory (1–2 hours)

### Task 1: List and analyze all test files
**Files:**
- Modify: (no files, commands only)

**Steps:**
1. **List all test files:**
   ```bash
   find test -name "*.test.ts" -type f | sort > /tmp/all_tests.txt
   wc -l /tmp/all_tests.txt
   ```
   **Expected:**
   ```
   93 /tmp/all_tests.txt
   ```

2. **Show the last change per test file:**
   ```bash
   for f in $(cat /tmp/all_tests.txt); do 
     echo -n "$f "; 
     git log --oneline -n 1 -- "$f" 2>/dev/null || echo "no commits"; 
   done | sort -k2 > /tmp/test_last_commit.txt
   head -20 /tmp/test_last_commit.txt
   ```

3. **Count test blocks per file (describe/it):**
   ```bash
   for f in $(cat /tmp/all_tests.txt); do 
     echo -n "$f "; 
     rg "describe\(|it\(" "$f" | wc -l; 
   done > /tmp/test_blocks.txt
   awk '$2<5 {print}' /tmp/test_blocks.txt | head -10
   ```
   **Expected:**
   - Files with <5 blocks are candidates for deactivation.

4. **Measure runtime per test file:**
   ```bash
   npx vitest run --run --reporter=verbose --no-coverage 2>&1 | tee /tmp/vitest_run.txt | grep "✓ test/" | awk '{print $2, $3}' | sort -k2 > /tmp/test_times.txt
   wc -l /tmp/test_times.txt
   head -20 /tmp/test_times.txt
   ```

**Result:**
- `/tmp/all_tests.txt` – list of all 93 test files
- `/tmp/test_last_commit.txt` – last commits per file
- `/tmp/test_blocks.txt` – block count per file
- `/tmp/test_times.txt` – runtimes per file

---

### Task 2: Identify consolidation candidates
**Files:**
- Create: `docs/plans/candidates_consolidation.md`

**Steps:**
1. **Apply criteria:**
   - **Age:** no commits for >6 months
   - **Mock depth:** mock objects only, no router logic

2. **Carry over and refine the initial candidates from the audit plan:**
   ```markdown
   ## Initial candidates (provisional)
   
   | File | Last commit | Blocks | Time (ms) | Rationale |
   |------|-------------|--------|-----------|-----------|
   | test/cache.test.ts | <6 months | 3 | 120 | Cache objects only, no router logic |
   | test/model-matcher-batched.test.ts | <6 months | 2 | 80 | Old model matching, pre GDPval reengineering |
   | test/scratch-slug-debug.test.ts | <6 months | 1 | 10 | Debug file, no tests |
   | test/provider-shadow.test.ts (parts) | <6 months | 8 | 450 | Shadowing logic, pre ADR-0007 |
   ```

3. **Verify manually:**
   - `test/cache.test.ts`: `rg "Router\|routing\|applyGroupFilters" test/cache.test.ts` → should have no hits
   - `test/model-matcher-batched.test.ts`: `rg "GDPval|slug" test/model-matcher-batched.test.ts` → should have no hits
   - `test/scratch-slug-debug.test.ts`: `cat test/scratch-slug-debug.test.ts` → should contain debug code only

**Result:**
- `docs/plans/candidates_consolidation.md` with a candidate table and rationales.

---

## Phase 2: Analysis (2–4 hours)

### Task 3: Check redundancy and coverage
**Files:**
- Modify: `docs/plans/candidates_consolidation.md`

**Steps:**
1. **Check redundancy across files:**
   ```bash
   # Example: provider-shadow vs. routing.integration
   rg "provider.*mistral|mistral.*provider" test/provider-shadow.test.ts test/routing.integration.test.ts | wc -l
   ```
   **Expected:**
   - provider-shadow.test.ts has shadowing logic (pre ADR-0007), routing.integration.test.ts has modern router tests → parts can be deactivated.

2. **Show the coverage report before consolidation:**
   ```bash
   npx vitest run --run --coverage --reporter=basic > /tmp/coverage_before.txt
   cat /tmp/coverage_before.txt | grep -A 20 "Coverage summary"
   ```

3. **Identify functions covered only by candidate tests:**
   ```bash
   # Example: cache functions
   rg "setCache|getCache|cache" src/ | grep -v "test/" | cut -d: -f1 | sort -u
   ```
   **Decision:**
   - If there are no functional call sites in `src/` → the cache tests can be deactivated.

**Result:**
- `docs/plans/candidates_consolidation.md` extended with "functional coverage" and "risk of deactivation" columns.

---

### Task 4: Document flaky tests
**Files:**
- Modify: `docs/plans/candidates_consolidation.md`

**Steps:**
1. **Identify flaky tests:**
   ```bash
   npx vitest run --run --retry=3 --reporter=verbose 2>&1 | grep -i "flaky\|failed after retries" || echo "No flaky tests found"
   ```
   If flaky tests are found:
   ```bash
   npx vitest run --run --retry=3 --reporter=basic > /tmp/flaky_before.txt
   ```

2. **Create a separate issue:**
   - Title: `Issue: identify and fix flaky tests`
   - Content: list of flaky tests from `/tmp/flaky_before.txt`

**Result:**
- Flaky tests in `candidates_consolidation.md` as a separate chapter.

---

## Phase 3: Cleanup (2–3 hours)

> **SUPERSEDED by the execution protocol at the top:** Tasks 5–8 were
> dropped after the data-driven inventory — all 4 candidates test live
> features, so no `.skip` was justified. The steps below are the original
> plan text, kept for the record; do not execute them.

### Task 5: Deactivate tests (`.skip`) instead of deleting
**Files:**
- Modify: `test/cache.test.ts`, `test/model-matcher-batched.test.ts`, `test/scratch-slug-debug.test.ts`, `test/provider-shadow.test.ts`

**Steps per file:**

#### 5.1: test/cache.test.ts
**Steps:**
1. **Open the file:**
   ```bash
   code test/cache.test.ts
   ```
2. **Mark all `describe`/`it` blocks with `.skip`:**
   ```ts
   describe.skip('Cache tests (stale, mock objects only)', () => {
     it.skip('should cache available models', () => { ... })
     // ... all tests
   });
   ```
3. **Commit:**
   ```bash
   git add test/cache.test.ts
   git commit -m "test: deactivate stale cache tests"
   ```

#### 5.2: test/model-matcher-batched.test.ts
**Steps:**
1. **Open the file:**
   ```bash
   code test/model-matcher-batched.test.ts
   ```
2. **Mark all tests with `.skip`:**
   ```ts
   describe.skip('Legacy model matcher (pre GDPval reengineering)', () => { ... })
   ```
3. **Commit:**
   ```bash
   git add test/model-matcher-batched.test.ts
   git commit -m "test: deactivate legacy model-matcher tests"
   ```

#### 5.3: test/scratch-slug-debug.test.ts
**Steps:**
1. **Open the file:**
   ```bash
   code test/scratch-slug-debug.test.ts
   ```
2. **Mark the whole file with `.skip`:**
   ```ts
   describe.skip('Debug tests (no functional tests)', () => { ... });
   ```
3. **Commit:**
   ```bash
   git add test/scratch-slug-debug.test.ts
   git commit -m "test: deactivate debug tests"
   ```

#### 5.4: test/provider-shadow.test.ts (parts)
**Steps:**
1. **Open the file:**
   ```bash
   code test/provider-shadow.test.ts
   ```
2. **Mark only the shadowing-logic blocks with `.skip`:**
   ```ts
   describe.skip('Legacy provider shadowing (pre ADR-0007)', () => { ... });
   ```
3. **Commit:**
   ```bash
   git add test/provider-shadow.test.ts
   git commit -m "test: deactivate legacy provider-shadowing tests"
   ```

**Result:**
- 4 files marked with `.skip`
- 4 new commits

---

### Task 6: Update documentation
**Files:**
- Modify: `CHANGES.md`, `IMPLEMENTATION_SUMMARY.md`

**Steps:**
1. **Update CHANGES.md:**
   ```markdown
   - test: deactivate stale tests (cache.test.ts, model-matcher-batched.test.ts, scratch-slug-debug.test.ts, provider-shadow.test.ts parts) — .skip instead of deletion for reversibility
   ```
2. **Update IMPLEMENTATION_SUMMARY.md:**
   ```markdown
   - Test consolidation: 4 test files deactivated, baseline preserved, reversibility via .skip
   ```
3. **Commit:**
   ```bash
   git add CHANGES.md IMPLEMENTATION_SUMMARY.md
   git commit -m "docs: update after test consolidation"
   ```

---

## Phase 4: Validation (1–2 hours)

### Task 7: Measure the baseline after consolidation
**Files:**
- Modify: (no files)

**Steps:**
1. **Run tests and save results:**
   ```bash
   npx vitest run --run --reporter=basic > /tmp/after_consolidation.txt
   npx vitest run --run --coverage --reporter=basic > /tmp/coverage_after.txt
   ```
2. **Show the diff:**
   ```bash
   diff /tmp/before_consolidation.txt /tmp/after_consolidation.txt
   diff /tmp/coverage_before.txt /tmp/coverage_after.txt
   ```
   **Expected:**
   - No new failures
   - Coverage unchanged (or minimally improved from less mock overhead)

3. **Compare runtimes:**
   ```bash
   echo "Before: $(grep "Test Files" /tmp/before_consolidation.txt | awk '{print $4}')"
   echo "After: $(grep "Test Files" /tmp/after_consolidation.txt | awk '{print $4}')"
   ```

**Result:**
- `/tmp/after_consolidation.txt` and `/tmp/coverage_after.txt` show no regression.

---

### Task 8: Create a PR and wait for review
**Files:**
- Modify: (no code changes, PR creation only)

**Steps:**
1. **Create the PR:**
   ```bash
   git push origin HEAD:test-consolidation
   gh pr create --title "test: consolidate stale tests" --body "$(cat docs/plans/candidates_consolidation.md)" --label "test"
   ```
2. **Wait for review:**
   - Reviewers can comment on changes
   - On objections: `.skip` → `.only` or adapt tests
   - On approval: next phase

---

### Task 9: Final deletion or further adjustment
**Files:**
- Modify: `test/cache.test.ts`, `test/model-matcher-batched.test.ts`, `test/scratch-slug-debug.test.ts`, `test/provider-shadow.test.ts`

**Steps (after review approval):**
1. **Check `.skip` → `.only`:**
   If `.only` was set, revert it.
2. **Delete the tests for good:**
   ```bash
   git rm test/cache.test.ts test/model-matcher-batched.test.ts test/scratch-slug-debug.test.ts
   git commit -m "test: remove stale cache tests"
   ```
3. **Or keep the tests and reduce further:**
   ```bash
   # Example: keep only 1 test
   git checkout HEAD~1 -- test/cache.test.ts
   # ... reduce manually
   git add test/cache.test.ts
   git commit -m "test: keep only one cache test"
   ```

---

## Summary of expected results

| Phase | Duration | Result |
|-------|----------|--------|
| Preparation | 10 min | Baseline saved |
| Inventory | 1–2 h | Candidate list in `candidates_consolidation.md` |
| Analysis | 2–4 h | Risk analysis and coverage check |
| Cleanup | 2–3 h | 4 files with `.skip`, documentation updated |
| Validation | 1–2 h | No regression, PR created |
| Final deletion | 30 min | Optional after review |

**Total:** ~8 hours (1 workday)

---

## Risks & trade-offs

- **Reversibility:** `.skip` instead of deletion allows a fast revert.
- **False-positive candidates:** when in doubt, keep the file and reduce tests.
- **Flaky tests:** create a separate issue, do not treat in this consolidation.
- **Coverage:** before/after comparison ensures no functional coverage is lost.

---

## Next steps after this plan

1. **Execute the plan** with `/skill:executing-plans` (this plan as guide).
2. **Create a PR** and wait for review.
3. **After approval:** final deletion or further adjustment.
4. **Treat flaky tests separately** (create an issue).

---

**Done.**
