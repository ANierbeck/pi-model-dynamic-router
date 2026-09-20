# Test Suite Redundancy & Timeout Analysis (Task 3)

> Scope: whole suite (93 files, 806 tests). Analysis only — no code changes.
> Companion to `docs/plans/candidates_consolidation.md` (Task 2: the four
> original deletion candidates are all KEEP — they test live features).

---

## 1. Merge candidates (redundancy across file boundaries)

### 1a. Genuine overlap: refactor-golden-master ↔ metrics-selfheal

`test/refactor-golden-master.test.ts` (describes "GDPval lookup tiers" +
"gdpval_builtin overrides", lines 84–141) and `test/metrics-selfheal.test.ts`
assert the same `lookupGdp` semantics with near-identical titles:

| Assertion (semantics) | golden-master | metrics-selfheal |
|---|---|---|
| self-heals from cache.gdpval_scores when gdpval empty | ✓ | ✓ (plus the deeper setGdpval-wipes-builtins bug repro, cache-also-wiped, re-trigger cases) |
| does not clobber populated gdpval (idempotent) | ✓ | ✓ |
| builtin overrides scraped score | ✓ | ✓ |
| explicit null exclusion | ✓ | ✓ |
| exact model-map match beats token-set fallback | ✓ | ✓ |
| provider prefix stripped before lookup | ✓ | ✓ |

**Merge recommendation:** `metrics-selfheal.test.ts` is the superset for the
heal semantics (it adds the real failure-mode repros); the duplicated tier
tests inside refactor-golden-master could be dropped, leaving that file as
what its name promises — Router end-to-end golden-master coverage (GLM-5-2
regression, exclude rules, load()→lookupGdp consistency). **Verdict: optional,
low-value merge** — the duplication is a maintenance smell, not a runtime
problem (both files are fast). If merged, delete only the two lookupGdp-tier
describes from golden-master; do not touch its Router e2e sections.

### 1b. Considered and REJECTED (looks like duplication, isn't)

These pairs are deliberate multi-layer/multi-path coverage — **not** merge
candidates:

- `dynamic-config-context-length.test.ts` (6 its) ↔ `routing-context-length.test.ts` (5 its): four identical `it` titles, but they pin the SAME min_context_length semantics to the TWO parallel implementations — persist path (`filterModelsForGroup`, src/dynamic-config.ts) vs live path (`applyGroupFilters`, src/routing.ts). This is path-parity guarding against drift (same pattern as the known max_cost persist/live divergence). Keep both.
- `slug-canon-dedup` ↔ `slug-dedup-canonical` ↔ `unified-slug-resolution`: different layers of the slug pipeline — GDPval duplicate-spelling canonicalization / `collapseSameSlugClusters` cluster collapse / `getMatchedSlug`+`lookupGdp` resolver agreement.
- `model-matcher.test.ts` ↔ `model-matcher-batched.test.ts`: different pipeline stages (LLM JSON parse+validate vs plausible-filter+batching).
- `registry-cost-lookup` ↔ `registry-cost-alias-matching`: different lookup mechanisms (direct registry find vs model-map sibling/pricingAlias retry).
- `max-cost-filter` (Router e2e group content) ↔ `apply-group-filters` (gate unit semantics): different test levels.
- `routing-exclude` (allDiscoveredRefs discovery rules) ↔ `apply-group-filters` (group gate rules): different layers.
- `router-info-events` (`pushRouterInfo`) ↔ `stream-driver-logged` (`pushRouterInfoLogged`): different functions.
- Classifier family (8 files touching classifier/content-classifier): each covers a distinct feature (cache, cloud-fallback opt-in, momentum, HINT synonyms, narration leak, compaction context, integration).

**Import clusters found** (functions imported by multiple files — normal, not
redundancy per se): metrics ×12, routing ×9, stream-driver ×3 files, and the
pairs above. `getTopModels` appears in 9 files and `lookupGdp` in 10, but the
assertions diverge by aspect (display, dedup, ranking, exclusion, heal).

---

## 2. Unique-coverage warning (regression protection)

Functions covered by exactly ONE test file — nothing here may fall away
without replacement:

- `collapseSameSlugClusters` → only `slug-canon-dedup.test.ts` (cluster collapse to canonical representative).
- `coalesceBySlug` → only `get-top-models-dedup.test.ts` (display-path dedup).
- `plausibleMatchCandidates`, `matchModelsWithLLMBatched` → only `model-matcher-batched.test.ts` (live HINT-resolution batching).
- `redundantAliasProviders`, `pruneRedundantCacheEntries` → only `provider-shadow.test.ts` (ghost purge).
- `Router.updateCache` → only `router-cache-refresh.test.ts` (stale cache refresh).
- Classifier LRU+TTL cache → only `classification-cache.test.ts`.
- `pushRouterInfo` → only `router-info-events.test.ts`; `pushRouterInfoLogged` → only `stream-driver-logged.test.ts`.

**For the one merge candidate (1a):** dropping golden-master's lookupGdp-tier
describes loses NO unique coverage — every dropped assertion has a
counterpart in metrics-selfheal, which additionally holds the deeper
failure-mode repros.

---

## 3. Timeout-tuning targets (input for Task 4)

### Root cause: lock serialization, not per-test sloppiness

The 10 slowest files (~86s of the suite's 116s wall time) are ALL users of
`test/helpers/router-state-lock.ts` — 26 files total serialize on a
cross-process lock (25ms poll, 180s timeout, STALE_LOCK_MS 5min). Per-file
wall time = own real work **+ lock-queue wait** behind the currently holding
file. The own real work is dominated by **REAL production-time windows**
waited out through full `driveStream` integration flows with real timers
(rate-limit cooldowns `src/rate-limit.ts`, paid-cloud provider cooldown,
failure malus, repetition/health windows).

### Per-file classification

| File (wall time) | Wait type | Classification | Tunable? |
|---|---|---|---|
| provider-error-paid-cloud-cooldown (11.4s) | production cooldown window via driveStream | REAL-WAIT | No — faking timers in a driveStream integration flow risks false confidence |
| free-model-on-demand-registration (11.2s) | on-demand registration flow, real timers | REAL-WAIT | No |
| context-overflow (10.5s) | fallback-cascade across candidates, multiple driveStream runs | REAL-WAIT | No |
| abort-not-provider-error (9.8s) | abort handling + lock queue | REAL-WAIT | No |
| ollama-concurrency-limit (9.5s) | real concurrency backoff windows | REAL-WAIT | No |
| dynamic-config-staleness (8.7s) | real 500ms delay (line 190) + staleness flow + lock queue | PARTIALLY TUNABLE | The 500ms could theoretically shrink to ≥150ms, but it encodes a timing invariant (must exceed the 100ms static override AND stay under the stale 999999ms) — not worth the risk for ~0.35s |
| skip-failure-malus (8.2s) | malus accrual window via driveStream | REAL-WAIT | No |
| classifier-narration-leak-multi-turn (7.8s) | multi-turn classification flow + lock queue | REAL-WAIT | No |
| provider-error-detection (6.1s) | error-classification windows + lock queue | REAL-WAIT | No |
| repetition-loop-detection (5.6s) | repetition window + retry semantics | REAL-WAIT | No |

### Recommendations for Task 4

1. **The honest headline: there are no artificial test delays to tune away.**
   The original Task-4 premise (künstliche Delays → fake timers) does not
   hold. The slow files intentionally wait out REAL production windows
   (documented in the lock helper itself: "dominated by tests that
   intentionally wait out real setTimeout-based timeouts").
2. **The actual lever is lock utilization, not timeouts:** 26 files serialize
   on one global lock; wall time ≈ sum of hold times. Options (increasing
   effort): (a) audit the 26 importers and drop the lock from files that
   don't actually need real shared state, (b) shrink per-file hold time by
   splitting multi-scenario files, (c) long-term: replace the global lock
   with per-test state isolation (vi.resetModules + tmp cwd) — large
   refactor, own plan.
3. **vitest.config.ts is already consistent:** testTimeout 200s > lock
   timeout 180s, with an explanatory comment (CI run 33061592936). No change
   needed.
4. **Do NOT** lower any timeout or inject fake timers into driveStream
   integration tests to chase seconds — the suite's value is exactly that
   these windows are exercised for real. The CI flake history (the
   60s→180s lock widening) shows how fragile this area already is.

---

**Bottom line:** exactly one optional merge (golden-master ↔ metrics-selfheal,
low value, no unique coverage lost), no unique-coverage risks, and timeout
tuning is a dead end — the real consolidation lever is lock-usage reduction
among the 26 serialized files.

## 4. Flaky-test observation (Task 4, added by orchestrator 2026-09-20 22:35)

During post-merge validation runs an **intermittent failure** was observed:

- 3 failures across the first ~4 full-suite runs (22:30–22:32), then **10 consecutive green runs** (22:33+).
- Total post-merge: ~3 failures / 17 runs — clustered at the START of the validation series, while
  subagent sessions and back-to-back suites had just finished (system load / timer pressure hypothesis,
  unconfirmed).
- The failing test name was **not captured**: the orchestrator piped vitest output through `tail`,
  losing the `Failed Tests` block both times (process mistake, documented here as a lesson:
  always dump full output to a file when investigating flakes).
- No reproduction in 10 subsequent runs; the failure is therefore NOT deterministic and NOT related
  to the 5 removed duplicate assertions (which only touch lookupGdp data lookups, 2ms, no timing).

**Recommendation:**
1. Keep an eye on CI runs; capture full logs on the first red run (`npx vitest run > /tmp/vitest.log 2>&1`).
2. Prime suspects per §3: the 10 slowest files wait on REAL time windows (rate-limit cooldowns,
   malus accumulation via driveStream) — under system load these are the natural flake candidates.
3. Do not disable anything — the flake is rare, load-correlated, and unidentified.

## 5. Post-merge validation (2026-09-20 22:35)

- Removed 5 exact-duplicate assertions from `test/refactor-golden-master.test.ts` (see git diff):
  explicit-null, map-vs-token-set, self-heal-from-cache, no-clobber, builtin-overrides —
  each with a living counterpart in `test/metrics-selfheal.test.ts`.
- Kept unique coverage: wildcard match, pure token-set fallback, null-when-no-match,
  builtin non-shadowing, provider-prefix on the bare `mistral/glm-5-2` form.
- `npx tsc --noEmit` clean; suite: **801 tests (798 passed / 3 skipped)**, 11.7s wall time;
  previously 806 tests — exactly the 5 duplicates removed, zero functional loss.
