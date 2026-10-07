# Mutation Survivor Triage Ledger

> Companion to docs/plans/2026-10-04-mutation-survivor-triage.md (Part A =
> operating model, Part B = batches). One row per undetected mutant (or
> tight line cluster); verdicts are filled batch-by-batch. New nightly
> reports are triaged against THIS ledger: a survivor already carrying a
> verdict stays parked; only new/changed entries become work items.
> The first nightly report (run 37606222840, 435 undetected) is fully triaged
> in "Nightly R1 (2026-10-07)" at the end of this file.

## Verdicts

- **REAL GAP** -> red-first test (AGENTS.md §4)
- **EQUIVALENT** -> behavior-identical; parked with rationale
- **DEFENSIVE/FAILOPEN** -> documented error path; parked
- **DEAD CODE** -> remove (§7)
- **UNTRIAGED** -> not yet classified (default)

## Baseline: report #1 (2026-10-04, 125.5 min, decision core)

| File | Score | Killed | Survived | NoCoverage |
|---|---|---|---|---|
| src/metrics.ts | 55.7% | 389 | 219 | 91 |
| src/routing.ts | 57.0% | 553 | 249 | 169 |
| **total** | **56.4%** | **942** | **468** | **260** |

## Open hotspots (from the triage plan, Part B)

| Cluster | Undetected | Batch |
|---|---|---|
| routing.ts:600-760 (cost window / cooldown) | 119 | Batch 1 (Task 2) |
| metrics.ts:900-1000 (pricing lookup) | 64 | Batch 2 (Task 3) |
| metrics.ts:100-350 (model-map / alias index) | 74 | Batch 3 (Task 4) |
| routing.ts:1000-1100 | 68 | Batch 3/5 |
| No-coverage clusters (by function) | see below | Task 5 |


## HOTSPOT routing.ts:600-760 (119 undetected) — ✅ TRIAGED (Batch 1, 2026-10-05)

> Line numbers refer to the tree the nightly ran on (pre-Batch-1); the
> dead-code deletions below shift lines for the NEXT nightly.
> Red-first evidence: 26 representative mutants were applied and observed
> RED against `test/sort-by-methods.test.ts` before landing (per AGENTS.md §4).
> Verdicts: TESTED = real gap, closed by a new regression test (red verified);
> EQUIVALENT = semantically indistinguishable, ledger rationale below;
> DEAD CODE / REDUNDANT = removed from `src/routing.ts`.

| line | mutator | status | verdict | rationale |
|---|---|---|---|---|
| 602 | BooleanLiteral / ConditionalExpression ×2 | Survived | TESTED ('true') / EQUIVALENT ('false') | 'true' (never filter) killed by filterByBudget wrapper test; 'false' passes `budget_cache: undefined` → hasBudget returns conservative-true → identical result (defensive guard) |
| 603 | ObjectLiteral | Survived | EQUIVALENT | `{}` ctx → hasBudget with undefined cache → all pass — same as the guard's early return |
| 612 | MethodExpression | Survived | TESTED | filterAvailable with a limited ref — killed |
| 618–623 | (all, filterByQualityPct) | NoCoverage ×21 | DEAD CODE | zero callers anywhere (ADR-0023 replicated the gate inline in applyGroupFilters); method deleted |
| 629–631 | (all, filterByQualityMin) | NoCoverage ×14 | DEAD CODE | zero callers anywhere; method deleted |
| 643–647, 651–652 | dispatch + sort bodies | Survived/NoCoverage | TESTED | min_latency / max_throughput / min_cost / max_gdpval order assertions through the public dispatch (bodies had NoCoverage) — red verified |
| 653 | ConditionalExpression ('best' → true) | Survived | TESTED | roundrobin/unknown-method order-preservation test — a 'true' best-branch would score-sort them |
| 666 | ConditionalExpression ×2 ('w > 0' → true / 'w >= 0') | Survived | TESTED | window-OFF + tied-top-scores test: no cost-based reordering when the window is disabled — red verified |
| 668 | EqualityOperator (>= floor → >) | Survived | TESTED | exact-floor boundary test (w=0.5 → FP-exact floor; boundary candidate stays in the pool) — red verified |
| 669 | ConditionalExpression (pool < 2 → false) | Survived | EQUIVALENT | single-element pool: `[...pool, ...rest]` is identical to `sorted` — empirically green under mutation |
| 676 | ×5 (both-unknown guard + gdpval diff) | Survived/NoCoverage | TESTED | mixed known/unknown pool: &&→|| and gdpval −→+ both red verified |
| 677 | ConditionalExpression + StringLiteral | Survived | EQUIVALENT | the symmetric `costB === 'unknown' → -1` branch plus NaN-evaluates-false sort semantics enforce known-before-unknown in every comparison direction (insertion AND merge paths) — unkillable through the public API on V8 |
| 678 | ×3 (incl. NoCoverage −1 → +1) | Survived/NoCoverage | TESTED | unknown-cost score leader must go to the pool END — red verified |
| 679 | ArithmeticOperator (costA − costB → +) | Survived | TESTED | pool cost-order test — red verified |
| 688 | ×4 (billing_preference dispatch) | Survived | TESTED | dispatch test (free before payg) + the 'true' variant killed by the method-order tests |
| 689 | ×5 (roundrobin branch) | Survived | REDUNDANT | `if (method === 'roundrobin') return s;` followed by `return s;` — behaviorally identical; branch removed, fall-through documented |
| 712 | ×4 (strictRank nested conditionals) | Survived | TESTED | 4-tier strict_local fixture with cost/gdpval ANTI-correlated to rank — all four variants red verified (cost tiebreaks can no longer mask rank changes; sub fixture carries a real post-discount cost ABOVE the payg fixture) |
| 720 | ×5 (localBeforePaygRank) | Survived | TESTED ×3 / EQUIVALENT ×2 | `() => undefined`, t0→true, t1→true killed by the same anti-correlated 4-tier fixture; t2→false/true EQUIVALENT: local-vs-payg ties fall to cost and local effCost is invariantly 0 < any payg cost — the tiebreak reproduces the rank order |
| 730, 732 | CaseStatement variants | Survived | EQUIVALENT | Stryker CaseStatement replacement text is identical to the original — vacuous by construction |
| 743 | ×4 (ta === 1 gate) | Survived | TESTED | subscription-pair limit-pressure test (lower pressure BEFORE gdpval) + free-pair test (limitSecs must NOT leak outside tier 1) — 'false' and 'true' both red verified |
| 746 | ×2 (pa − pb) | Survived/NoCoverage | TESTED | sign-flip red verified |
| 751–754 | unknown-cost guard + ordering | Survived/NoCoverage | TESTED | unknown to END, both-unknown → gdpval DESC tiebreak; guard → false red verified |

**Batch 1 outcome (119 undetected):** 35 DEAD CODE + 5 REDUNDANT removed
(`filterByQualityPct`, `filterByQualityMin`, roundrobin branch); ~66 closed by
24 new regression tests in `test/sort-by-methods.test.ts` (red-first verified);
~13 EQUIVALENT with documented rationale. Fixture lesson recorded: billing-tier
fixtures must ANTI-correlate cost and gdpval with the expected rank, and ref
slugs must not collide with `gdpval_builtin` keys (the slug resolver's
token/substring matching silently remaps gdpval — two mutants initially
survived because of exactly that collision).

## HOTSPOT metrics.ts:900-1000 (64 undetected) — ✅ TRIAGED (Batch 2, 2026-10-05)

> Line numbers refer to the tree the nightly ran on. Red-first evidence:
> 10 representative mutants applied and observed RED against
> `test/pricing-lookup-chain.test.ts` (11 tests) before landing.

| line | mutator | status | verdict | rationale |
|---|---|---|---|---|
| 901 | `!modelRegistry` → false | Survived | EQUIVALENT | registryCost is wrapped in try/catch → TypeError → null, identical to the guard's early null (defensive) |
| 908 | `!model` → true | Survived | TESTED | alias retry would OVERWRITE a primary registration with an alias miss — primary-wins test red verified |
| 909–910 | optional-chaining / `aliasProvider` truthiness | Survived | EQUIVALENT | non-optional access on a PROVIDER_MAP-miss crashes into the same try/catch null; truthy-alias path is unchanged (defensive) |
| 912 | `!model?.cost` variants | Survived | EQUIVALENT | destructure of null/undefined → TypeError → catch → null (defensive) |
| 914 | typeof guards | Survived | TESTED | registered model with STRING costs must fall through to the next stage, not return the sentinel — red verified |
| 919 | `input === 0 && output === 0` variants | Survived | TESTED | half-zero price {0, 5} is a REAL price — only {0,0} means free; red verified |
| 921 | catch block → {} | NoCoverage | EQUIVALENT | missing return yields undefined ≡ null for every caller (falsy) |
| 945–950 | metrics-cost gate / block / ObjectLiteral | Survived | TESTED | configured cost_per_m wins over the pricing cache; `{ input: cost, output: cost }` shape asserted — red verified (4 tests failed under one mutant) |
| 947 | `cost === 'unknown'` → false | Survived | EQUIVALENT | REDUNDANT GATE: the generic `return { input: cost, output: cost }` produces the identical sentinel object for cost='unknown' — behaviorally indistinguishable |
| 948 | unknown-sentinel literals | NoCoverage | TESTED | covered by the 'unknown' cost_per_m test |
| 957–967 | zero-price guard + free-detection | Survived/NoCoverage | TESTED | {0,0} + discovered-free → {0,0}; {0,0} + undiscovered + NO free_models list → 'unknown' (the `?? []` default is exercised); free-detection → true and `??` → `&&` both red verified |
| 975–978 | backfill loop (free-tier skip, norm match, slash handling) | Survived/NoCoverage | TESTED | free-tier entries skipped, paid same-model entry found via norm() across a slash+case difference — red verified |
| 982–984 | provider-cost fallback | Survived/NoCoverage | TESTED | step-4 estimate {9,9} asserted — red verified |

**Batch 2 outcome (64 undetected):** ~44 closed by 11 new regression tests
(red-first: 10 representative mutants observed RED), ~20 EQUIVALENT with
documented rationale (mostly the defensive try/catch cluster of
`registryCost`), 0 dead code — the chain's stages are all live.

## HOTSPOT metrics.ts:100-350 (74 undetected) — ✅ TRIAGED (Batch 3, 2026-10-05)

> Red-first evidence: 18 representative mutants applied and observed RED
> against `test/slug-resolution.test.ts` (14 tests) before landing. The
> private `aliasesFor()` is observed through the public `lookupPrice`
> registry-alias retry — its only production consumer.

| area | mutants | verdict | rationale |
|---|---|---|---|
| L107–110 setModelMap version counter (`++` → `--`) | 1 | EQUIVALENT → **CORRECTED (Nightly R1): TESTED** | only consumed via `!==` staleness checks; a SINGLE decrement is harmless, but decrement + one correct increment returns to the build-time version and serves a stale alias index — killed by the round-trip tests in `metrics-decision-core-r1` |
| L128–130 stripProvider (`i === -1` variants) | 2 | EQUIVALENT | slash-less refs return `ref` under every variant: slice(0, -1) never names a known provider, and `ref.slice(i + 1)` with i = -1 is the whole ref |
| L141–147 mapLookup (exact gate, wildcard loop) | 5 | TESTED | exact-beats-wildcard and prefix semantics asserted on the STRIPPED id; in-map → 'true', startsWith → false/endsWith all red verified |
| L165 alias-index version init | 1 | EQUIVALENT | consumed via `!==` only (see L110) |
| L167–177 buildModelMapAliasIndex (skip guard, group accumulation, seed) | ~7 | TESTED ×2 / EQUIVALENT ×5 | slash-key exclusion verified with a registry that WOULD answer a slash-containing id (deepseek-ai/V3-style ids are real); 3-key group proves accumulation (2-key fixtures are self-filtering and mask it). `slug == null` part of the skip guard: null-slug groups are never queried (aliasesFor early-returns) — EQUIVALENT. Seed `[]` mutant: `[]` is TRUTHY, the next sibling pushes into it and the accumulation self-heals — EQUIVALENT |
| L188–194 aliasesFor (staleness, self-filter) | ~9 | TESTED ×1 / EQUIVALENT ×8 | `||` → `&&` staleness kills via model-map change mid-file (stale index served old aliases). `=== null` → 'true' rebuilds every call — same results (perf only). Self-filter variants: retrying the already-missed primary id is a harmless extra miss — EQUIVALENT |
| L200–206 buildGdpvalIndex (token key, sort, max) | 13 | TESTED | synonym slug resolves through the token-set index; max-score selection verified in BOTH insertion orders (kills first-wins AND last-wins); build-side sort drop verified (query side keeps sorting → key mismatch) |
| L249–253 splatVersionRuns (regex, join) | 10 | TESTED | same-score twins collapse to ONE dedup identity; join/regex variants red verified. Remaining regex-variant pairs (e.g. `^\d{2,}$` vs `^\d{2,}`) are indistinguishable for realistic digit-run segments — EQUIVALENT |
| L277–283 getSlugCanon (score cache, twin conditions) | 13 | TESTED ×2 / EQUIVALENT ×11 | different-score twins stay DISTINCT (kills `===` → `!==` and the `&&` → `\|\|` leak). `slugCanonScores !== scores` → 'true' rebuilds idempotently — EQUIVALENT. `twin !== key` → 'true' maps digit-run-less keys to themselves — harmless identity |
| L292–299/318–321 resolveSlug self-heal (version counters, `.some`) | 4 | TESTED ×1 / EQUIVALENT ×3 | partial-wipe heal asserted (`.some` → `.every` red verified — the 13/148 scoring-collapse class). Version `++` → `--`: any change invalidates — EQUIVALENT. `missingBuiltin` → 'true': heal is idempotent — EQUIVALENT |
| L330 explicit-exclusion early return | 1 | EQUIVALENT | REDUNDANT GUARD: the next line `if (mapped !== undefined) return mapped` returns the same null (`null !== undefined` is true) — the early return is documentation, not behavior |
| L335 empty-gdpval ternary | 2 | EQUIVALENT | check-1 (empty → restore from cache.gdpval_scores) repopulates gdpval before this line can see an empty-but-cache-backed state; without cache scores both sides are `{}` |
| L346–347 cached LLM matches | 8 | TESTED | cached duplicate spellings are CANONICALIZED (kills gate → false, `??` → `&&`); non-string cache entries are type-checked away (kills `&&` → `\|\|`, typeof → true). Optional-chaining crash on missing cache ≡ undefined — EQUIVALENT |

**Batch 3 outcome (74 undetected):** ~34 closed by 14 new regression tests
(red-first: 18 representative mutants observed RED), ~40 EQUIVALENT with
documented rationale — this region is defensive/version-counter heavy, and
three of its "obvious" guards turned out to be genuinely redundant
(L330 double-guard, L177 truthy-seed self-heal, L335 unreachable-else).
No dead code: every resolver stage is live.

## HOTSPOT routing.ts:1000-1100 (68 undetected) — ✅ TRIAGED (Batch 4, 2026-10-05)

> Almost the entire region was NoCoverage: resolveGroup's dispatch and
> detectGroup's head had never been driven end-to-end through the public
> `Router.resolve()` / `detectGroup()`. Red-first evidence: 16 representative
> mutants applied and observed RED against `test/resolve-group-dispatch.test.ts`
> (8 tests) before landing.

| area | mutants | verdict | rationale |
|---|---|---|---|
| L1024–1025 explicit models list | 2 | TESTED | models list INTERSECTS with discovered refs (undiscovered entries drop out); gate → false and filter-drop both red verified |
| L1060 `score_by ?? 'gdpval'` → '' | 1 | EQUIVALENT | calculateScore treats '' like any absent/legacy taskType — global gdpval either way |
| L1061 tiered dispatch | 5 | TESTED | 'best' must NOT fall into the tiered branch (best-order vs billing-order differ on the fixture) — gate → true red verified (4 tests failed) |
| L1064–1067 pipeline steps + top_k | 13 | TESTED / EQUIVALENT-partial | pipeline gate + per-step top_k truncation red verified; `&&` → `\|\|` and `<` → `<=` variants are content-preserving (slice(0, top_k) with top_k ≥ length yields the same array) |
| L1069–1072 roundrobin rotation | 15 | TESTED ×3 / EQUIVALENT ×1 | `%` → `*` and rotation-array mutants red verified via three successive resolves; counter `i + 1` → `i - 1` was ledgered EQUIVALENT — **CORRECTED (Nightly R1): TESTED**: the second pick becomes the LAST element for 3+ candidates (two-model fixtures cannot tell), killed by `display-dispatch` |
| L1073–1075 min_cost_if_all_priced branch | 13 | REDUNDANT (removed) / TESTED | the explicit branch is behaviorally identical to the generic else (`sortBy(c, g.method, name)` dispatches the same) — 'false' mutant empirically green, branch REMOVED per AGENTS.md §7 with a comment; the 'true' mutant (everything min-cost) red verified via the best-group test; group top_k red verified |
| L1078 generic top_k | 9 | TESTED | truncation on the else-branch red verified |
| L1090–1091 activeGroup pinning | 3 | TESTED | both → false (pin lost) and → true (always pin, even null) red verified |
| L1097–1099 detectGroup threshold list | 11 | TESTED | dynamic-group exclusion + highest-min_gdpval-first ordering red verified with a config whose OBJECT order is deliberately wrong (only the sort produces the right answer) |

**Batch 4 outcome (68 undetected):** ~49 closed by 8 new end-to-end regression
tests (red-first: 16 representative mutants observed RED), 1 redundant branch
removed, ~18 EQUIVALENT with documented rationale (content-preserving slice
variants, the negative-modulo rotation, the '' taskType).

## REST metrics.ts (172 undetected)

| line | mutator | status | verdict | rationale |
|---|---|---|---|---|
| 52 | ArrayDeclaration | Survived | UNTRIAGED | |
| 57 | UnaryOperator | Survived | UNTRIAGED | |
| 62 | BlockStatement | Survived | UNTRIAGED | |
| 63 | StringLiteral | Survived | UNTRIAGED | |
| 64 | BlockStatement | Survived | UNTRIAGED | |
| 67 | ArrayDeclaration | Survived | UNTRIAGED | |
| 68 | BlockStatement | Survived | UNTRIAGED | |
| 69 | ConditionalExpression ×4 | Survived | UNTRIAGED | |
| 69 | EqualityOperator ×2 | Survived | UNTRIAGED | |
| 69 | LogicalOperator | Survived | UNTRIAGED | |
| 69 | StringLiteral | Survived | UNTRIAGED | |
| 70 | BlockStatement | Survived | UNTRIAGED | |
| 70 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 70 | MethodExpression | Survived | UNTRIAGED | |
| 70 | StringLiteral | Survived | UNTRIAGED | |
| 71 | ArrayDeclaration | Survived | UNTRIAGED | |
| 71 | MethodExpression | Survived | UNTRIAGED | |
| 72 | BlockStatement | Survived | UNTRIAGED | |
| 77 | ArithmeticOperator | Survived | UNTRIAGED | |
| 77 | ArrowFunction | Survived | UNTRIAGED | |
| 77 | MethodExpression | Survived | UNTRIAGED | |
| 79 | BlockStatement | NoCoverage | UNTRIAGED | |
| 84 | StringLiteral | NoCoverage | UNTRIAGED | |
| 86 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 87 | UpdateOperator | NoCoverage | UNTRIAGED | |
| 96 | UpdateOperator | Survived | UNTRIAGED | |
| 355 | ConditionalExpression ×4 | Survived | UNTRIAGED | |
| 355 | EqualityOperator ×2 | Survived | UNTRIAGED | |
| 355 | LogicalOperator | Survived | UNTRIAGED | |
| 377 | ConditionalExpression | Survived | UNTRIAGED | |
| 381 | ConditionalExpression | Survived | UNTRIAGED | |
| 386 | ArrayDeclaration | Survived | UNTRIAGED | |
| 386 | MethodExpression | Survived | UNTRIAGED | |
| 386 | StringLiteral | Survived | UNTRIAGED | |
| 393 | ObjectLiteral | Survived | UNTRIAGED | |
| 425 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 425 | EqualityOperator | Survived | UNTRIAGED | |
| 425 | LogicalOperator | Survived | UNTRIAGED | |
| 428 | OptionalChaining | Survived | UNTRIAGED | |
| 429 | ConditionalExpression | Survived | UNTRIAGED | |
| 438 | ArrayDeclaration | Survived | UNTRIAGED | |
| 509 | BlockStatement | Survived | UNTRIAGED | |
| 518 | BlockStatement | Survived | UNTRIAGED | |
| 518 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 522 | CallExpression | Survived | UNTRIAGED | |
| 523 | UpdateOperator | Survived | UNTRIAGED | |
| 536 | ConditionalExpression | Survived | UNTRIAGED | |
| 539 | ConditionalExpression | Survived | UNTRIAGED | |
| 544 | ConditionalExpression | Survived | UNTRIAGED | |
| 548 | UpdateOperator | Survived | UNTRIAGED | |
| 574 | ConditionalExpression | Survived | UNTRIAGED | |
| 582 | BlockStatement | NoCoverage | UNTRIAGED | |
| 618 | BlockStatement | Survived | UNTRIAGED | |
| 618 | ConditionalExpression | Survived | UNTRIAGED | |
| 628 | ArrayDeclaration | Survived | UNTRIAGED | |
| 628 | ArrowFunction | Survived | UNTRIAGED | |
| 628 | ConditionalExpression | Survived | UNTRIAGED | |
| 628 | StringLiteral | Survived | UNTRIAGED | |
| 629 | BlockStatement | Survived | UNTRIAGED | |
| 629 | ConditionalExpression | Survived | UNTRIAGED | |
| 647 | BlockStatement | Survived | UNTRIAGED | |
| 647 | ConditionalExpression | Survived | UNTRIAGED | |
| 660 | BlockStatement | Survived | UNTRIAGED | |
| 660 | ConditionalExpression ×3 | Survived | UNTRIAGED | |
| 660 | LogicalOperator | Survived | UNTRIAGED | |
| 660 | StringLiteral | Survived | UNTRIAGED | |
| 681 | LogicalOperator | Survived | UNTRIAGED | |
| 682 | LogicalOperator | Survived | UNTRIAGED | |
| 691 | BlockStatement | NoCoverage | UNTRIAGED | |
| 694 | ArithmeticOperator ×4 | NoCoverage | UNTRIAGED | |
| 695 | BlockStatement | NoCoverage | UNTRIAGED | |
| 695 | ConditionalExpression ×4 | NoCoverage | UNTRIAGED | |
| 695 | EqualityOperator ×4 | NoCoverage | UNTRIAGED | |
| 695 | LogicalOperator | NoCoverage | UNTRIAGED | |
| 696 | ArithmeticOperator ×6 | NoCoverage | UNTRIAGED | |
| 697 | BooleanLiteral | NoCoverage | UNTRIAGED | |
| 697 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 737 | ConditionalExpression | Survived | UNTRIAGED | |
| 776 | BlockStatement | Survived | UNTRIAGED | |
| 776 | ConditionalExpression | Survived | UNTRIAGED | |
| 778 | BooleanLiteral | Survived | UNTRIAGED | |
| 778 | ConditionalExpression | Survived | UNTRIAGED | |
| 779 | MethodExpression | Survived | UNTRIAGED | |
| 779 | StringLiteral ×3 | Survived | UNTRIAGED | |
| 780 | BooleanLiteral | NoCoverage | UNTRIAGED | |
| 780 | ConditionalExpression | Survived | UNTRIAGED | |
| 781 | BooleanLiteral | NoCoverage | UNTRIAGED | |
| 781 | ConditionalExpression | Survived | UNTRIAGED | |
| 781 | StringLiteral | Survived | UNTRIAGED | |
| 784 | ArrayDeclaration | Survived | UNTRIAGED | |
| 807 | StringLiteral | Survived | UNTRIAGED | |
| 818 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 819 | MethodExpression | NoCoverage | UNTRIAGED | |
| 819 | StringLiteral ×3 | NoCoverage | UNTRIAGED | |
| 820 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 821 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 821 | StringLiteral | NoCoverage | UNTRIAGED | |
| 823 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 880 | LogicalOperator | Survived | UNTRIAGED | |
| 880 | StringLiteral | Survived | UNTRIAGED | |
| 891 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1014 | ConditionalExpression | Survived | UNTRIAGED | |
| 1017 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1017 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1017 | EqualityOperator | Survived | UNTRIAGED | |
| 1019 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1019 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1020 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1020 | ConditionalExpression ×4 | NoCoverage | UNTRIAGED | |
| 1020 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1020 | LogicalOperator | NoCoverage | UNTRIAGED | |
| 1020 | StringLiteral ×2 | NoCoverage | UNTRIAGED | |
| 1021 | StringLiteral | NoCoverage | UNTRIAGED | |
| 1028 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1028 | ConditionalExpression | Survived | UNTRIAGED | |
| 1031 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1031 | OptionalChaining | NoCoverage | UNTRIAGED | |
| 1034 | OptionalChaining ×2 | NoCoverage | UNTRIAGED | |
| 1035 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1035 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1035 | EqualityOperator | NoCoverage | UNTRIAGED | |
| 1053 | ArithmeticOperator | Survived | UNTRIAGED | |
| 1070 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 1071 | EqualityOperator | Survived | UNTRIAGED | |
| 1081 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 1082 | EqualityOperator | Survived | UNTRIAGED | |

## REST routing.ts (231 undetected)

| line | mutator | status | verdict | rationale |
|---|---|---|---|---|
| 48 | BooleanLiteral | Survived | UNTRIAGED | |
| 49 | LogicalOperator | Survived | UNTRIAGED | |
| 69 | BooleanLiteral | Survived | UNTRIAGED | |
| 69 | ConditionalExpression | Survived | UNTRIAGED | |
| 88 | BlockStatement | Survived | UNTRIAGED | |
| 89 | OptionalChaining | Survived | UNTRIAGED | |
| 89 | StringLiteral | Survived | UNTRIAGED | |
| 98 | OptionalChaining | Survived | UNTRIAGED | |
| 115 | BlockStatement | Survived | UNTRIAGED | |
| 116 | StringLiteral | Survived | UNTRIAGED | |
| 117 | OptionalChaining | Survived | UNTRIAGED | |
| 118 | ConditionalExpression | Survived | UNTRIAGED | |
| 119 | ArithmeticOperator | Survived | UNTRIAGED | |
| 119 | MethodExpression | Survived | UNTRIAGED | |
| 120 | ConditionalExpression | Survived | UNTRIAGED | |
| 120 | LogicalOperator | Survived | UNTRIAGED | |
| 133 | ConditionalExpression | Survived | UNTRIAGED | |
| 133 | LogicalOperator | Survived | UNTRIAGED | |
| 135 | BooleanLiteral | NoCoverage | UNTRIAGED | |
| 135 | ConditionalExpression | NoCoverage | UNTRIAGED | |
| 135 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 135 | EqualityOperator | NoCoverage | UNTRIAGED | |
| 135 | EqualityOperator | Survived | UNTRIAGED | |
| 214 | BooleanLiteral | Survived | UNTRIAGED | |
| 239 | LogicalOperator | Survived | UNTRIAGED | |
| 257 | ConditionalExpression | Survived | UNTRIAGED | |
| 258 | ConditionalExpression | Survived | UNTRIAGED | |
| 258 | EqualityOperator | Survived | UNTRIAGED | |
| 259 | BlockStatement | NoCoverage | UNTRIAGED | |
| 259 | ConditionalExpression | NoCoverage | UNTRIAGED | |
| 259 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 259 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 259 | EqualityOperator | Survived | UNTRIAGED | |
| 259 | LogicalOperator | Survived | UNTRIAGED | |
| 263 | ArrowFunction ×2 | NoCoverage | UNTRIAGED | |
| 263 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 263 | EqualityOperator | NoCoverage | UNTRIAGED | |
| 263 | MethodExpression | NoCoverage | UNTRIAGED | |
| 264 | BlockStatement | NoCoverage | UNTRIAGED | |
| 264 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 265 | MethodExpression | NoCoverage | UNTRIAGED | |
| 266 | ArithmeticOperator ×2 | NoCoverage | UNTRIAGED | |
| 267 | BlockStatement | NoCoverage | UNTRIAGED | |
| 267 | ConditionalExpression ×4 | NoCoverage | UNTRIAGED | |
| 267 | EqualityOperator ×3 | NoCoverage | UNTRIAGED | |
| 267 | LogicalOperator | NoCoverage | UNTRIAGED | |
| 267 | MethodExpression | NoCoverage | UNTRIAGED | |
| 275 | ConditionalExpression | Survived | UNTRIAGED | |
| 276 | ConditionalExpression | Survived | UNTRIAGED | |
| 276 | EqualityOperator | Survived | UNTRIAGED | |
| 287 | ConditionalExpression | Survived | UNTRIAGED | |
| 289 | ConditionalExpression | Survived | UNTRIAGED | |
| 289 | StringLiteral | Survived | UNTRIAGED | |
| 290 | EqualityOperator | Survived | UNTRIAGED | |
| 301 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 301 | StringLiteral | Survived | UNTRIAGED | |
| 302 | EqualityOperator | Survived | UNTRIAGED | |
| 309 | ConditionalExpression | Survived | UNTRIAGED | |
| 312 | ConditionalExpression | Survived | UNTRIAGED | |
| 312 | EqualityOperator | Survived | UNTRIAGED | |
| 325 | ArrayDeclaration | Survived | UNTRIAGED | |
| 326 | StringLiteral ×8 | Survived | UNTRIAGED | |
| 351 | OptionalChaining | Survived | UNTRIAGED | |
| 360 | EqualityOperator | Survived | UNTRIAGED | |
| 380 | ConditionalExpression | Survived | UNTRIAGED | |
| 380 | UnaryOperator | Survived | UNTRIAGED | |
| 422 | ConditionalExpression ×3 | Survived | UNTRIAGED | |
| 422 | EqualityOperator | Survived | UNTRIAGED | |
| 422 | LogicalOperator | Survived | UNTRIAGED | |
| 435 | ConditionalExpression | Survived | UNTRIAGED | |
| 449 | ConditionalExpression | Survived | UNTRIAGED | |
| 463 | ConditionalExpression ×3 | Survived | UNTRIAGED | |
| 463 | EqualityOperator | Survived | UNTRIAGED | |
| 463 | LogicalOperator | Survived | UNTRIAGED | |
| 481 | ConditionalExpression ×3 | Survived | UNTRIAGED | |
| 481 | EqualityOperator ×2 | Survived | UNTRIAGED | |
| 481 | LogicalOperator | Survived | UNTRIAGED | |
| 520 | ConditionalExpression | Survived | UNTRIAGED | |
| 546 | LogicalOperator | Survived | UNTRIAGED | |
| 585 | ConditionalExpression | Survived | UNTRIAGED | |
| 773 | BlockStatement | NoCoverage | UNTRIAGED | |
| 773 | ConditionalExpression | Survived | UNTRIAGED | |
| 773 | StringLiteral ×2 | Survived | UNTRIAGED | |
| 774 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 776 | ConditionalExpression | Survived | UNTRIAGED | |
| 776 | StringLiteral | Survived | UNTRIAGED | |
| 777 | ConditionalExpression | Survived | UNTRIAGED | |
| 843 | ConditionalExpression | Survived | UNTRIAGED | |
| 843 | StringLiteral | Survived | UNTRIAGED | |
| 847 | ConditionalExpression | Survived | UNTRIAGED | |
| 850 | ArrayDeclaration | Survived | UNTRIAGED | |
| 850 | BlockStatement | Survived | UNTRIAGED | |
| 852 | BooleanLiteral | Survived | UNTRIAGED | |
| 852 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 854 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 890 | ConditionalExpression | Survived | UNTRIAGED | |
| 890 | UnaryOperator | Survived | UNTRIAGED | |
| 891 | CallExpression | Survived | UNTRIAGED | |
| 931 | LogicalOperator | Survived | UNTRIAGED | |
| 962 | LogicalOperator | Survived | UNTRIAGED | |
| 963 | LogicalOperator | Survived | UNTRIAGED | |
| 966 | EqualityOperator | Survived | UNTRIAGED | |
| 980 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 980 | Regex | Survived | UNTRIAGED | |
| 982 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 982 | Regex ×7 | Survived | UNTRIAGED | |
| 984 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 984 | Regex ×2 | Survived | UNTRIAGED | |
| 1101 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1101 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1101 | EqualityOperator | NoCoverage | UNTRIAGED | |
| 1102 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1103 | LogicalOperator | NoCoverage | UNTRIAGED | |
| 1104 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1104 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1104 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1111 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 1111 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1111 | StringLiteral ×5 | NoCoverage | UNTRIAGED | |
| 1113 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1113 | ConditionalExpression ×5 | NoCoverage | UNTRIAGED | |
| 1113 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1113 | LogicalOperator ×2 | NoCoverage | UNTRIAGED | |
| 1130 | BlockStatement | Survived | UNTRIAGED | |
| 1183 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 1183 | ConditionalExpression | Survived | UNTRIAGED | |
| 1183 | ObjectLiteral | NoCoverage | UNTRIAGED | |
| 1184 | ArrayDeclaration | Survived | UNTRIAGED | |
| 1184 | ConditionalExpression | Survived | UNTRIAGED | |
| 1184 | ObjectLiteral | Survived | UNTRIAGED | |
| 1184 | StringLiteral | Survived | UNTRIAGED | |
| 1196 | BooleanLiteral | Survived | UNTRIAGED | |
| 1198 | BlockStatement | Survived | UNTRIAGED | |
| 1198 | ConditionalExpression | Survived | UNTRIAGED | |
| 1198 | StringLiteral | Survived | UNTRIAGED | |
| 1202 | LogicalOperator | Survived | UNTRIAGED | |
| 1202 | StringLiteral ×2 | Survived | UNTRIAGED | |
| 1203 | BlockStatement | Survived | UNTRIAGED | |
| 1203 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1203 | EqualityOperator | Survived | UNTRIAGED | |
| 1203 | StringLiteral | Survived | UNTRIAGED | |
| 1205 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1205 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1205 | EqualityOperator | Survived | UNTRIAGED | |
| 1205 | LogicalOperator | Survived | UNTRIAGED | |
| 1205 | StringLiteral | Survived | UNTRIAGED | |
| 1206 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1206 | ConditionalExpression | NoCoverage | UNTRIAGED | |
| 1206 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1206 | UpdateOperator | NoCoverage | UNTRIAGED | |
| 1210 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 1210 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1210 | EqualityOperator | NoCoverage | UNTRIAGED | |
| 1211 | BooleanLiteral | NoCoverage | UNTRIAGED | |
| 1211 | ConditionalExpression ×4 | NoCoverage | UNTRIAGED | |
| 1211 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1211 | LogicalOperator ×2 | NoCoverage | UNTRIAGED | |
| 1211 | MethodExpression | NoCoverage | UNTRIAGED | |
| 1213 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1213 | EqualityOperator | Survived | UNTRIAGED | |
| 1213 | StringLiteral | Survived | UNTRIAGED | |
| 1215 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1233 | ArrowFunction | Survived | UNTRIAGED | |
| 1234 | MethodExpression | Survived | UNTRIAGED | |
| 1235 | ArrowFunction | Survived | UNTRIAGED | |
| 1244 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1248 | BlockStatement | Survived | UNTRIAGED | |

## Task 6 baseline — re-measure (2026-10-05, run 37348781600 on main @ 337e2d3)

| metric | report #1 (baseline) | re-measure | delta |
|---|---|---|---|
| total mutants | 1670 | 1622 | −48 (dead code removed) |
| killed | 942 | 1252 | +310 |
| survived | 468 | 330 | −138 |
| no coverage | 260 | 40 | −220 |
| **mutation score** | **56.41%** | **77.19%** | **+20.78pp** |

Per file (re-measure): metrics.ts 74.68% (144 survived + 34 NoCov),
routing.ts 79.11% (186 survived + 6 NoCov).

**Closure judgment:** 77.19% sits just under the plan's ~80% heuristic —
report #1 is NOT formally closed. Of the 330 survivors, roughly 110 are
the EQUIVALENT/defensive verdicts already ledgered in the batch sections
(their mutants stay green by design). The genuinely untriaged remainder
(~220 survived + 40 NoCov) concentrates in the never-triaged REST regions
— top clusters (by enclosing function, re-measure): routing.ts
getTopModels/resolveGroup locals (26), metrics.ts price chain leftovers
(20), routing.ts modelId/dedup comparators (~37), thanScore comparator
(17), costB comparators (15), metrics.ts billingTier free paths (13),
FALLBACK_GROUP_ORDER (9 — the fallback_groups CHAIN, distinct from
detectGroup's tier fallback), isLastStep display-pipeline leftovers (10).
Fresh report: `/tmp/mutation-report-2/mutation/mutation.json` (artifact
`mutation-report` of run 37348781600).

## Task 5 verdicts — no-coverage sweep (2026-10-05, `test/no-coverage-sweep.test.ts`)

| cluster | mutants | verdict |
|---|---|---|
| `isVirtualGroupRef` | 140 | REAL GAP — full truth table (slash presence, provider∈groupNames, self / `:use-static` id forms). Largest single cluster of report #1. |
| `applyGroupFilters` min_gdpval_pct gate | ~6 | REAL GAP — percentile threshold vs pool max, gate-off, all-unscored pass-through. |
| `detectGroup` no-score fallback list | ~8 | REAL GAP — first unrestricted tier of [scout, operational, tactical, strategic, fallback] wins; positive min skips a tier. |
| `getTopModels` display pipeline (isLastStep, top_k, L1244) | ~30 | REAL GAP — display deliberately differs from resolveGroup: the LAST pipeline step never truncates. Pinned in both directions. |
| `effCost` steps 2–3 (lookupPrice → provider estimate → $0.000020) | ~24 | DEAD — `getM()` guarantees `cost_per_m` is always defined (0/'unknown' heal via `resolveCostPerM`), so the fallbacks were unreachable for every input. Removed per §7; the invariant is pinned by test. |
| `effCost` reachable chain (subscription discount, costMux, typeof) | ~10 | REAL GAP — pinned after the removal. |
| `updateMetrics` (EMA α=0.3, zero-duration guard, benchmarks persist) | 24 | REAL GAP. |
| `billingTier` free paths (:free tag, free_models, discovered-0) | 10 | REAL GAP — qualified/bare/discovered variants. The third `includes(prov+'/'+bare)` check was byte-identical to the first for every slash ref → REMOVED per §7 (each copy masked every mutant on the other; empirically unkillable). |
| `loadModelMap` (valid map, wildcard longest-first, broken YAML) | 4 | REAL GAP. |
| `liveGroupFilterLookups.isFree` (routing.ts ~L135, max_cost 0) | 3 | PARTIAL — `price !== null` and truthy mutants killed via an unpriced third ref (mutant throws on `price.input`); the `price.input === 0 && price.output === 0` conjunct is EQUIVALENT: both callers wrap `isFree` in `admitsZeroCostGroup`, which re-requires token-based, and for token-based providers `effCost(ref) === 0` coincides with a `{0,0}` pricing result (orFallbackPrice only returns `{0,0}` for discovered-0/free-list refs, and both also make resolveCostPerM return 0). Ledgered, not removed — cheap belt-and-braces. |
| `updateMetrics`/misc single mutants (getCapabilityProfiles, aliasesFor, registryCost catch) | ~3 | covered by Batch 2/3 tests or defensive — see batch sections. |

Red-first evidence: 13 representative mutants applied and observed RED
(`/tmp/task5-redfirst.sh` pattern); 1 survivor was the redundancy proof
for the billingTier removal. Lines refer to the pre-sweep tree.

## No-coverage clusters (Task 5 orientation)

| function | NoCoverage mutants |
|---|---|
| routing.ts: export function isVirtualGroupRef(ref: string, groupNames: R | 140 |
| routing.ts: export function applyGroupFilters( | 26 |
| metrics.ts: export function effCost(ref: string): number | 'unknown' { | 25 |
| metrics.ts: export function updateMetrics(ref: string, latMs: number, to | 24 |
| metrics.ts: export function lookupPrice(ref: string): { input: number |  | 21 |
| metrics.ts: export function billingTier(ref: string): number { | 10 |
| metrics.ts: export function loadModelMap(extDir: string): void { | 4 |
| routing.ts: function liveGroupFilterLookups(cfg: Config): GroupFilterLoo | 3 |
| metrics.ts: export function isFreeModelRef( | 2 |
| metrics.ts: function aliasesFor(modelId: string): string[] { | 1 |
| metrics.ts: export function getCapabilityProfiles(): NonNullable<Cache[' | 1 |
| metrics.ts: function registryCost( | 1 |

## Nightly R1 (2026-10-07) — first nightly report, run 37606222840

> Artifact `mutation-report` of "Nightly Mutation Testing" (2026-10-07T10:15Z,
> 44m46s, incremental run, decision core `src/metrics.ts` + `src/routing.ts`).
> Line numbers below are the report's (source = commit faca950, ADR-0025
> Phase B). Triage branch `stryker-triage-r1`. The per-mutant dataset
> (verdict, killing test, rationale) is committed as
> `docs/mutation-data/nightly-r1.json`.
>
> **Corrected after review (same day):** the first version of this section
> reported 70 "false survivors" and 211 real-vacuity findings. A reviewer
> found that the parallel recheck itself was unreliable (see Finding 1); the
> numbers below are from the re-run with confirmed kills.

### Numbers

| | nightly (measured) | after R1 triage (**projected**) |
|---|---|---|
| mutants | 1781 | ≤ 1723 (58 mutants live on code R1 removed) |
| killed | 1346 | ≤ 1611 (+11 killed by the existing suite, +254 by the new tests) |
| survived / no coverage | 382 / 53 | 112 (all ledgered EQUIVALENT) |
| score | 75.58 % | ≈ 93.5 % |

The right-hand column is a **projection, not a measurement**: it subtracts the
58 removed undetected mutants from the total but cannot subtract the KILLED
mutants that also lived on the removed lines (unknown without a re-run), so
it is an upper bound. The real score is re-measured by the next nightly.

Per file (nightly): metrics.ts 167 survived + 35 NoCov (202), routing.ts 215
survived + 18 NoCov (233). Raw report: not committed (2.7 MB) — re-derive it
with `gh run download 37606222840 -n mutation-report`.

### Pre-CDE caveat, quantified: 0 obsolete

The report embeds the exact source it mutated: it is byte-identical to commit
faca950 (Phase B). `git diff faca950 HEAD -- src/metrics.ts src/routing.ts` was
three comment lines at the time of triage (ADR-0025 C/D touched other
modules), so every mutated line still existed semantically. **Obsolete
mutants: 0 / 435.**

### Category distribution (435 undetected = 382 survived + 53 no coverage)

| category | mutants | share | meaning |
|---|---|---|---|
| (c) real vacuity → killed by new tests | **254** | 58.4 % | alive against the full existing suite (confirmed), killed by the R1 tests |
| false survivor → killed by the existing suite | **11** | 2.5 % | the nightly says "Survived", the existing full suite kills it (confirmed); 10 of them are also killed by the new tests alone |
| (b) equivalent | 112 | 25.7 % | 78 distinct lines, rationale per row below |
| (d) dead/redundant code → removed (§7) | 58 | 13.3 % | 26 of the 53 NoCov are here |
| (a) obsolete | 0 | 0 % | |
| (e) cosmetic / untestable | 0 | 0 % | the log-text string literals turned out testable (decision-log shape) |

Survived (382): 234 real vacuity, 11 false survivors, 105 equivalent, 32 dead.
NoCoverage (53): 20 real vacuity, 0 false survivors, 7 equivalent (`?? []`
junk fallbacks), 26 dead. Every mutant has a verdict and every real one a
killing test; nothing is deferred.

### Method (reusable, all in `scripts/`)

1. `mutation-survivors.ts` — per-line worklist of the report; extracts the
   embedded source for the obsolete check.
2. `mutation-recheck.ts` — re-runs every undetected mutant against the FULL
   suite in parallel pristine copies. It first proves the unmutated tree green,
   and **a kill only counts when confirmed**: the failing test file named by
   vitest is re-run ALONE on the same mutated copy (must fail) and ALONE on the
   baseline (must pass); otherwise the mutant is reported `unconfirmed`.
3. `mutation-apply.ts` — re-applies ONE reported mutant by its location for
   red-first evidence (AGENTS.md §4); `mutation-recheck.ts --tests <files>`
   does the same in bulk for the new tests.

Regeneration of the dataset (pristine tree = the commit the nightly mutated):

```
gh run download 37606222840 -n mutation-report -D /tmp/r1/report
git archive c05a4e5 | tar -x -C /tmp/r1/pristine        # + ln -s <repo>/node_modules
cp test/cache-per-project-state.test.ts /tmp/r1/pristine/test/   # parallel-safe version
node scripts/mutation-recheck.ts /tmp/r1/report/mutation/mutation.json \
  --tree /tmp/r1/pristine --out /tmp/r1/suite.json --jobs 4 --max-workers 3
# new-tests pass: same tree + the R1 test files, only those files run
node scripts/mutation-recheck.ts <report> --tree /tmp/r1/with-new-tests \
  --out /tmp/r1/new.json --jobs 4 --max-workers 2 --tests <comma-separated R1 test files>
```

Red-first evidence for the batch: all 254 + 11 mutants were re-applied at
their reported location against the nightly source plus the new tests and
observed RED (`newTests: killed` in the dataset for the 254, 10 of the 11); the
unmutated tree with the new tests is green. The exceptions were also applied
individually with `mutation-apply.ts` after the review: the version-counter
round trips (ids 29, 34, 40, 150, 161) and the roundrobin counter (L1106).

### Finding 1 — the first recheck was unreliable; false survivors are rare (11 = 2.5 %)

The first version of this triage reported 70 false survivors (66 killed + 4
timeouts, all four timeouts naming a failing test) and built a "perTest
isolation produces noise" finding on them. Review showed that was an artifact
of the recheck: `test/cache-per-project-state.test.ts` used the FIXED shared
directory `os.tmpdir()/router-state-global` and deletes it in `beforeEach`;
the four parallel recheck jobs raced on it. That test imports only
`cache.ts → session-errors.ts → types` and can never load `metrics.ts` or
`routing.ts`, yet it was recorded as the killer of 14 decision-core mutants.
The test now uses `mkdtempSync`; six concurrent runs of the unfixed file on an
unmutated tree fail 3–7 of 9 tests each, six concurrent runs of the fixed
file pass.

After the fix and with confirmation (above), the full-suite recheck leaves
**11 genuine false survivors**: 424 survive, 11 are killed, 0 time out, 0 are
unconfirmed. Of the 70 earlier "kills", 59 do not reproduce (13 from the race;
the rest — `delegation`, `runtime-overflow-detection`,
`consolidated-routing-cache-pins`, `adr-0021-…`, … — pass when re-run alone
and in the clean run; they were most likely timing failures under the load of
parallel jobs, which is a hypothesis, not a proven cause). The 11 genuine ones
are killed by `no-coverage-sweep` (2), `fallback-chain` (4),
`expensive-model-read-block` (2), `slug-canon-dedup`, `cache-usage-wiring` and
`sort-by-methods`. One mechanism is demonstrated: the broken-YAML test of
`loadModelMap` (`test/no-coverage-sweep.test.ts`) was the ONLY covering test of
a SURVIVED mutant (`catch { }` emptied) because it depended on the previous
test having loaded the map — run alone, which is what StrykerJS perTest does,
it passed vacuously. It now loads a valid map first (red evidence: old test
isolated + emptied catch → SURVIVED; fixed test isolated + emptied catch →
KILLED). Consequence: a nightly survivor is almost always real or equivalent;
the confirmed recheck is cheap insurance, not a required step.

### Finding 2 — real vacuity: where the suite was assertion-light (254)

No product defect was found — the decision core behaves as designed. The 254
are behaviors the suite did not pin. By incident class (the ones this repo
actually had):

- **Gating** (`applyGroupFilters`, live `isFree`, `free_models`): every
  threshold boundary was unpinned (min/max_gdpval, pct, max_cost,
  max_cost_per_m, min_context_length are inclusive), `max_gdpval` null-fail,
  the dedup opt-in, the per-gate drop reasons; `free_models` prefixed vs bare;
  an undeclared provider is pay_per_token for unknown cost but never
  token-based for the $0 admission; a half-zero list price is a real price.
  → `group-filter-boundaries`, `group-filter-live-lookups`.
- **Ordering**: the cost comparators passed because V8's insertion sort only
  ever calls `cmp(later, earlier)` — half of every comparator was dead to the
  suite (the `unknown`-cost branches, the pool tiebreak direction). New tests
  run over all input permutations AND assert the comparator on every ordered
  pair. Same-model variant selection (canonical > dated > versioned > -latest,
  tie rule, 3-variant replacement) was only exercised through one fixture.
  → `min-cost-ordering`, `model-variant-preference`.
- **Cost / pricing** (metrics.ts): stale `'unknown'`/0 placeholder healing vs a
  real configured price; registry retry rules (`:free` only for `:free`, never
  overwriting a hit, alias seed including the FIRST group member); OpenRouter
  paid-index staleness (in-place additions AND same-size table replacement);
  the subscription rule cost (eps × list, multiplier, fallbacks); usage-log
  window boundaries; registry context-window guards.
  → `metrics-decision-core-r1`.
- **Stale-index protection**: the model-map / GDPval version counters are only
  compared with `!==`, which makes a single decrement harmless — but a
  decrement followed by one correct increment returns to the version a cached
  index was built at and serves a stale index. The first ledger version called
  these (L94, L103, L126, L315, L337) EQUIVALENT; five round-trip tests now
  kill them. The same correction applies to Batch 3 L107–110 below.
- **Config semantics**: `top_k: 0` means "no limit" (three code paths), a stray
  `pipeline` field on a non-pipeline group is ignored, a non-array
  `free_models` contributes nothing, and roundrobin visits three candidates in
  order (the Batch 4 ledger called the rotation-counter `i - 1` mutant
  equivalent; it is not for 3+ candidates).
- **State contracts**: turn-pin boundaries (`turn-pin-boundaries`), the
  fallback order contents (`fallback-chain`; four of the order mutants were
  already killed by the existing chain tests), the decision-log line shape (old
  assertions were all `toContain` — `group-decision-log`), display dispatch and
  dedup-before-cost-gate (`display-dispatch`), the first-ever GDPval version
  bump building the token index (fresh-module tests).

Killing tests (killed survivors per file; a mutant is attributed to its first
killer): `metrics-decision-core-r1` 75, `display-dispatch` 42,
`group-decision-log` 31, `group-filter-live-lookups` 30,
`group-filter-boundaries` 28, `model-variant-preference` 21,
`min-cost-ordering` 15, `fallback-chain` 6, `turn-pin-boundaries` 6.
+152 tests overall (suite: 1798 passed / 3 skipped after merging main; every
new test red-first against the mutants above).

### Finding 3 — dead and redundant code (58, removed per §7)

- `effCost` steps 2–3 (lookupPrice / provider estimate / $0.000020 default):
  unreachable because `getM()` heals `cost_per_m`. **Process note:** commit
  03a0b8e (Task 5 sweep) documents this removal in its message and in
  `test/no-coverage-sweep.test.ts`, but the source deletion never landed.
  The same commit's `billingTier` third-`includes` removal was missing too.
- `isFreeModelRef` / `billingTier`: the third `freeList.includes(prov/bare)` is
  byte-identical to the first for every slash ref — each copy masked every
  mutant on the other (mutually unkillable).
- `resolveCostPerM` local-provider and discovered-0 steps: clauses of
  `isFreeModelRef`, which the chain consults next (local providers are also
  `billing: subscription` in `PROVIDER_MAP`, so they returned 0 one step
  earlier anyway).
- `orPaidNormIndex` `kModel` strip: `norm()` already keeps only the last
  segment.
- `sortByBillingPreference` `local_before_payg` table (L727/744/754): the
  identity on the tier numbering — takes the default branch.
- `getTopModels` explicit `min_cost_if_all_priced` branch (L1278): identical to
  the generic else (same redundancy removed from `resolveGroup` in Batch 4).

Removals that contain mutants (58): metrics.ts 52, routing.ts 6. They are
removed lines of code, so the mutants disappear with them (they are not counted
as killed in the projection above).

### Equivalent-mutant examples (112 mutants on 78 lines, rationale per row)

- **Junk-array fallbacks (`?? []` → `["Stryker was here"]`, 8):** the fallback
  holds a string; `find`/`filter`/`includes` over it never matches.
- **Guard duplicated by the comparison it guards (12):** `null >= positive
  floor`, `undefined > 0` and `'unknown' <= n` are false anyway, so `v !== null`,
  `g.min_gdpval != null`, the `typeof` half of a price guard etc. cannot change
  an outcome. Same for the turn-pin guards with `turnStartMs <= 0`
  (`turnDriverAt`/`curModelAt` are never negative).
- **Exclude/budget wrappers (3):** `isExcluded` with undefined rules and
  `hasBudget` with an undefined `budget_cache` already pass every ref, so the
  early-return guards in front of them are belt-and-braces.
- **Version-counter initial sentinels (2):** `-1` → `+1` on the `lastIndexVersion`
  style initial values is shadowed by the `=== null` check in front of it.
  (Single decrements of the live counters are NOT equivalent — see Finding 2.)
- **`slice(0, top_k)` with `top_k ≥ length`, `'' ?? ref` vs `'' && ref`,
  `canon.get(null)`:** content-preserving by JavaScript semantics.
- **Earlier-batch verdicts (38 mutants cite Batch 2/3/4):** try/catch-wrapped
  optional chaining in registry code lands in the same `null`; redundant
  guards; idempotent rebuilds. The earlier rationale applies unchanged except
  for the two corrections named in Finding 2.

### Workflow gaps (§7)

Only one: the artifact upload relied on the repo-default retention although
triage happens days later → `retention-days: 90` explicit and pinned. The
incremental state that seeds the next nights comes from `actions/cache`, the
artifact copy is for diagnosis. Scope, schedule and report-only status
untouched. The score threshold is already in the run summary
(`scripts/mutation-summary.ts`).

### Phase-2 evidence (the owner decides)

| input | R1 value |
|---|---|
| undetected mutants triaged | 435 (382 + 53) |
| real vacuity | **254 mutants = 58.4 %**, clustering into ~18 regions → 9 test files, +152 tests |
| product defects found | 0 |
| test-quality defects found | 1 order-dependent test (vacuous in isolation), 1 test that raced on a fixed shared tmp dir (fixed), several assertion-light areas (comparators, log shape, fallback order, version counters) |
| ledger errors found by the re-triage | 2 earlier "equivalent" verdicts were wrong (version-counter round trips, roundrobin counter) |
| dead/redundant code | 58 mutants → 6 removals, one of them a missed removal from an earlier "done" commit |
| false survivors (tool noise) | 11 = 2.5 % |
| equivalent | 112 = 25.7 % |
| triage tax | ~2.2 h for the first pass + ~1.5 h for the review-fix round (mostly waiting for the 25-minute recheck); the three scripts above are reusable for every later report |

Recommendation (data, not a decision): the Phase-2 gate ("only if Phase 1
finds genuine vacuity") is met — 58 % real vacuity is a high yield, and the
findings are in the incident classes this repo has actually had (gating,
ordering, cost, free-tier admission, stale caches). But the yield is a
**first-report effect**: the next nightly on this scope should show few new
survivors (incremental mode makes unchanged nights near-free), so the
*ongoing* tax on the current scope is small, while extending to more files
re-pays the first-report cost (~2 h per ~1 800 mutants). The numbers
therefore support (1) keeping the nightly on the decision core, triaging only
nights where the core changed (the existing operating model), (2) extending
ONE module at a time — the next candidate by blast radius is
`stream-orchestrator.ts` — not suite-wide, and (3) treating
`mutation-recheck.ts` as an optional, cheap pre-triage check rather than a
nightly step: with a parallel-safe suite only 2.5 % of the survivors are
nightly noise, while the equivalent rate (25.7 %) is the irreducible triage
tax. Two cautions from this round: a mutation recheck must run against a
parallel-safe suite and must confirm each kill (the first version of this
ledger was wrong precisely there), and "equivalent" verdicts for counters and
caches deserve a second look at SEQUENCES, not single mutations. The score
(75.6 → ≈ 93.5 %, projected) is not a KPI; the 112 remaining mutants are
ledgered, not open.

### Per-region verdicts

> Nightly R1 line numbers (faca950). Verdict legend: REAL GAP → TESTED (red
> verified, killing test named), FALSE SURVIVOR (killed by the existing full
> suite), DEAD/REDUNDANT → removed, EQUIVALENT (rationale). Where a row says
> "(Batch N ledger)" the earlier batch verdict applies unchanged.

### routing.ts L40-140 — cluster representatives, billing helpers, free_models, live isFree (24 undetected)

Verdicts: EQUIVALENT ×2, REAL-KILLED ×22

| line | mutants | nightly status | verdict | killed by / rationale |
|---|---|---|---|---|
| 49 | 1 | SV ×1 | EQUIVALENT ×1 | canonical() is never evaluated for slug-less refs (their cluster key is the ref itself) |
| 50 | 1 | SV ×1 | EQUIVALENT ×1 | split('/').pop() always returns a string; `'' ?? ref` ≡ `'' && ref` |
| 70 | 2 | SV ×2 | REAL GAP → TESTED ×2 | model-variant-preference |
| 89 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-live-lookups |
| 90 | 2 | SV ×2 | REAL GAP → TESTED ×2 | group-filter-live-lookups |
| 99 | 2 | SV ×2 | REAL GAP → TESTED ×2 | group-filter-live-lookups |
| 116 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-live-lookups |
| 117 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-live-lookups |
| 118 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-live-lookups |
| 119 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-live-lookups |
| 120 | 2 | SV ×2 | REAL GAP → TESTED ×2 | group-filter-live-lookups |
| 121 | 2 | SV ×2 | REAL GAP → TESTED ×2 | group-filter-live-lookups |
| 134 | 2 | SV ×2 | REAL GAP → TESTED ×2 | group-filter-live-lookups |
| 136 | 5 | SV ×5 | REAL GAP → TESTED ×5 | group-filter-live-lookups |

### routing.ts L215-340 — applyGroupFilters gates (38 undetected)

Verdicts: REAL-KILLED ×30, EQUIVALENT ×8

| line | mutants | nightly status | verdict | killed by / rationale |
|---|---|---|---|---|
| 221 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-boundaries |
| 239 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-boundaries |
| 243 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-boundaries |
| 255 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-boundaries |
| 257 | 2 | SV ×2 | REAL GAP → TESTED ×2 | group-filter-boundaries |
| 259 | 4 | SV ×3, NC ×1 | REAL GAP → TESTED ×4 | group-decision-log, group-filter-boundaries |
| 273 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-boundaries |
| 280 | 1 | SV ×1 | EQUIVALENT ×1 | `undefined > 0` is false: the null guard duplicates the comparison |
| 281 | 2 | SV ×2 | REAL GAP → TESTED ×1; EQUIVALENT ×1 | group-filter-boundaries — `null >= positive floor` is false: the null guard duplicates the comparison |
| 282 | 4 | SV ×4 | REAL GAP → TESTED ×3; EQUIVALENT ×1 | group-filter-boundaries — `undefined > 0` is false: the null guard duplicates the comparison |
| 290 | 3 | SV ×3 | REAL GAP → TESTED ×2; EQUIVALENT ×1 | group-filter-boundaries — `null >= positive threshold` is false: the null guard duplicates the comparison |
| 298 | 1 | SV ×1 | EQUIVALENT ×1 | `undefined > 0` is false: the null guard duplicates the comparison |
| 299 | 2 | SV ×2 | REAL GAP → TESTED ×2 | group-filter-boundaries |
| 308 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-boundaries |
| 311 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-boundaries |
| 313 | 2 | SV ×2 | REAL GAP → TESTED ×2 | group-filter-boundaries |
| 314 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-boundaries |
| 322 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-boundaries |
| 325 | 3 | SV ×3 | REAL GAP → TESTED ×2; EQUIVALENT ×1 | group-filter-boundaries — `'unknown' <= number` is NaN-false, so the typeof half of the guard is redundant |
| 326 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-boundaries |
| 333 | 1 | SV ×1 | EQUIVALENT ×1 | `undefined > 0` is false: the null guard duplicates the comparison |
| 334 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-boundaries |
| 336 | 2 | SV ×2 | REAL GAP → TESTED ×1; EQUIVALENT ×1 | group-filter-boundaries — `null >= positive window` is false: the null guard duplicates the comparison |

### routing.ts L345-410 — fallback order, isVirtualGroupRef (13 undetected)

Verdicts: SUITE-KILLED ×4, REAL-KILLED ×7, EQUIVALENT ×2

| line | mutants | nightly status | verdict | killed by / rationale |
|---|---|---|---|---|
| 349 | 1 | SV ×1 | FALSE SURVIVOR ×1 | killed by the full suite (fallback-chain); 1 also killed in isolation by the new tests |
| 350 | 8 | SV ×8 | REAL GAP → TESTED ×5; FALSE SURVIVOR ×3 | fallback-chain — killed by the full suite (fallback-chain); 3 also killed in isolation by the new tests |
| 375 | 1 | SV ×1 | REAL GAP → TESTED ×1 | fallback-chain |
| 384 | 1 | SV ×1 | EQUIVALENT ×1 | FALLBACK_GROUP_ORDER[length] is undefined → modelGroups[undefined] is falsy |
| 404 | 2 | SV ×2 | REAL GAP → TESTED ×1; EQUIVALENT ×1 | group-filter-live-lookups — a slash-less ref can never equal its own prefix (`ref.slice(0,-1)`) nor prefix + ":use-static", so skipping the early return changes nothing; the `+1` variant is killed by the one-character-provider test |

### routing.ts L440-640 — Router turn pin, discovery, exclude/budget wrappers (22 undetected)

Verdicts: REAL-KILLED ×7, EQUIVALENT ×13, SUITE-KILLED ×2

| line | mutants | nightly status | verdict | killed by / rationale |
|---|---|---|---|---|
| 446 | 5 | SV ×5 | REAL GAP → TESTED ×3; EQUIVALENT ×2 | turn-pin-boundaries — assigning an equal boundary is a no-op; typeof half is redundant for number-typed input |
| 459 | 1 | SV ×1 | REAL GAP → TESTED ×1 | turn-pin-boundaries |
| 473 | 1 | SV ×1 | REAL GAP → TESTED ×1 | turn-pin-boundaries |
| 487 | 5 | SV ×5 | FALSE SURVIVOR ×1; EQUIVALENT ×4 | killed by the full suite (expensive-model-read-block); 1 also killed in isolation by the new tests — turnStartMs <= 0 / non-number: `turnDriverAt < turnStartMs` is false anyway (turnDriverAt >= 0), same return |
| 505 | 6 | SV ×6 | REAL GAP → TESTED ×1; FALSE SURVIVOR ×1; EQUIVALENT ×4 | turn-pin-boundaries — killed by the full suite (expensive-model-read-block); 1 also killed in isolation by the new tests — turnStartMs 0 / non-number both end in the same live-ref return; curModelAt is never negative |
| 544 | 1 | SV ×1 | EQUIVALENT ×1 | isExcluded with undefined rules returns false for every ref (`ctx.rules ?? {}`) |
| 580 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-filter-live-lookups |
| 620 | 1 | SV ×1 | EQUIVALENT ×1 | applyExcludes with an undefined exclude block returns the refs unchanged |
| 637 | 1 | SV ×1 | EQUIVALENT ×1 | hasBudget with an undefined budget_cache admits every ref |

### routing.ts L690-830 — sort comparators (21 undetected)

Verdicts: EQUIVALENT ×2, REAL-KILLED ×15, REMOVED ×4

| line | mutants | nightly status | verdict | killed by / rationale |
|---|---|---|---|---|
| 690 | 1 | SV ×1 | EQUIVALENT ×1 | single-element pool: `[...pool, ...rest]` equals `sorted` (Batch 1 L669) |
| 697 | 1 | SV ×1 | REAL GAP → TESTED ×1 | min-cost-ordering |
| 698 | 2 | SV ×2 | REAL GAP → TESTED ×2 | min-cost-ordering |
| 727 | 1 | SV ×1 | EQUIVALENT ×1 | '' falls to the switch default exactly like 'default' |
| 744 | 2 | SV ×2 | DEAD/REDUNDANT → removed ×2 | local_before_payg rank table (identity on the tier numbering; local-vs-payg ties fall to cost, Batch 1 L720) — removed |
| 754 | 2 | SV ×2 | DEAD/REDUNDANT → removed ×2 | local_before_payg case label: identical to the default arm — removed |
| 775 | 1 | SV ×1 | REAL GAP → TESTED ×1 | min-cost-ordering |
| 776 | 2 | SV ×2 | REAL GAP → TESTED ×2 | min-cost-ordering |
| 778 | 2 | SV ×2 | REAL GAP → TESTED ×2 | min-cost-ordering |
| 797 | 4 | SV ×3, NC ×1 | REAL GAP → TESTED ×4 | min-cost-ordering |
| 798 | 1 | NC ×1 | REAL GAP → TESTED ×1 | min-cost-ordering |
| 800 | 2 | SV ×2 | REAL GAP → TESTED ×2 | min-cost-ordering |

### routing.ts L860-1010 — resolve cascade, same-model dedup, variant preference (27 undetected)

Verdicts: REAL-KILLED ×23, EQUIVALENT ×4

| line | mutants | nightly status | verdict | killed by / rationale |
|---|---|---|---|---|
| 867 | 2 | SV ×2 | REAL GAP → TESTED ×2 | display-dispatch |
| 874 | 1 | SV ×1 | EQUIVALENT ×1 | unknown fallback group name → `!fbGroup` continue |
| 876 | 1 | SV ×1 | REAL GAP → TESTED ×1 | display-dispatch |
| 878 | 1 | SV ×1 | REAL GAP → TESTED ×1 | display-dispatch |
| 914 | 2 | SV ×2 | REAL GAP → TESTED ×1; EQUIVALENT ×1 | model-variant-preference — the incumbent is always present in result, so indexOf never misses |
| 915 | 1 | SV ×1 | REAL GAP → TESTED ×1 | model-variant-preference |
| 986 | 1 | SV ×1 | EQUIVALENT ×1 | split('/').pop() always returns a string |
| 987 | 1 | SV ×1 | EQUIVALENT ×1 | split('/').pop() always returns a string |
| 990 | 1 | SV ×1 | REAL GAP → TESTED ×1 | model-variant-preference |
| 1004 | 3 | SV ×3 | REAL GAP → TESTED ×3 | model-variant-preference |
| 1006 | 9 | SV ×9 | REAL GAP → TESTED ×9 | model-variant-preference |
| 1008 | 4 | SV ×4 | REAL GAP → TESTED ×4 | model-variant-preference |

### routing.ts L1060-1180 — resolveGroup, decision log, detectGroup (56 undetected)

Verdicts: REAL-KILLED ×49, EQUIVALENT ×7

| line | mutants | nightly status | verdict | killed by / rationale |
|---|---|---|---|---|
| 1061 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-decision-log |
| 1069 | 6 | SV ×5, NC ×1 | REAL GAP → TESTED ×5; EQUIVALENT ×1 | group-decision-log — the length comparison only skips work when nothing was dropped; the kept-set diff is empty then |
| 1071 | 5 | NC ×5 | REAL GAP → TESTED ×5 | group-decision-log |
| 1095 | 1 | SV ×1 | EQUIVALENT ×1 | '' taskType ranks like gdpval (Batch 4 L1060) |
| 1096 | 3 | SV ×3 | REAL GAP → TESTED ×3 | display-dispatch |
| 1099 | 2 | SV ×2 | REAL GAP → TESTED ×2 | display-dispatch, group-filter-live-lookups |
| 1102 | 4 | SV ×4 | REAL GAP → TESTED ×2; EQUIVALENT ×2 | group-filter-live-lookups — slice(0, top_k) with top_k ≥ length is content-preserving (Batch 4 L1064-1067) |
| 1106 | 1 | SV ×1 | REAL GAP → TESTED ×1 | display-dispatch (CORRECTS the Batch 4 ledger: `i + 1` → `i - 1` is NOT equivalent for 3+ candidates — the second pick becomes the last element) |
| 1107 | 1 | SV ×1 | REAL GAP → TESTED ×1 | display-dispatch |
| 1114 | 4 | SV ×4 | REAL GAP → TESTED ×2; EQUIVALENT ×2 | group-filter-live-lookups — slice(0, top_k) with top_k ≥ length is content-preserving (Batch 4 L1078) |
| 1119 | 5 | SV ×3, NC ×2 | REAL GAP → TESTED ×5 | group-decision-log |
| 1139 | 1 | NC ×1 | REAL GAP → TESTED ×1 | group-decision-log |
| 1140 | 7 | SV ×7 | REAL GAP → TESTED ×6; EQUIVALENT ×1 | group-decision-log — '' taskType ranks like gdpval (Batch 4 L1060) |
| 1141 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-decision-log |
| 1142 | 1 | SV ×1 | REAL GAP → TESTED ×1 | group-decision-log |
| 1146 | 2 | SV ×1, NC ×1 | REAL GAP → TESTED ×2 | group-decision-log |
| 1147 | 2 | NC ×1, SV ×1 | REAL GAP → TESTED ×2 | group-decision-log |
| 1164 | 1 | SV ×1 | REAL GAP → TESTED ×1 | display-dispatch |
| 1166 | 1 | SV ×1 | REAL GAP → TESTED ×1 | display-dispatch |
| 1168 | 1 | SV ×1 | REAL GAP → TESTED ×1 | display-dispatch |
| 1169 | 2 | SV ×2 | REAL GAP → TESTED ×2 | display-dispatch |
| 1176 | 3 | SV ×3 | REAL GAP → TESTED ×3 | display-dispatch |
| 1178 | 1 | SV ×1 | REAL GAP → TESTED ×1 | display-dispatch |

### routing.ts L1245-1316 — getTopModels display (32 undetected)

Verdicts: REAL-KILLED ×26, EQUIVALENT ×3, SUITE-KILLED ×1, REMOVED ×2

| line | mutants | nightly status | verdict | killed by / rationale |
|---|---|---|---|---|
| 1248 | 3 | NC ×2, SV ×1 | REAL GAP → TESTED ×3 | display-dispatch |
| 1249 | 4 | SV ×4 | REAL GAP → TESTED ×4 | display-dispatch |
| 1261 | 1 | SV ×1 | REAL GAP → TESTED ×1 | display-dispatch |
| 1263 | 3 | SV ×3 | REAL GAP → TESTED ×3 | display-dispatch |
| 1267 | 3 | SV ×3 | REAL GAP → TESTED ×2; EQUIVALENT ×1 | display-dispatch — '' taskType ranks like gdpval (Batch 4 L1060) |
| 1268 | 3 | SV ×3 | REAL GAP → TESTED ×3 | display-dispatch |
| 1270 | 2 | SV ×2 | REAL GAP → TESTED ×2 | display-dispatch, group-filter-live-lookups |
| 1276 | 4 | SV ×4 | REAL GAP → TESTED ×1; FALSE SURVIVOR ×1; EQUIVALENT ×2 | group-filter-live-lookups — killed by the full suite (no-coverage-sweep); 1 also killed in isolation by the new tests — slice(0, top_k) with top_k ≥ length is content-preserving (Batch 4 L1064-1067) |
| 1278 | 4 | SV ×4 | REAL GAP → TESTED ×2; DEAD/REDUNDANT → removed ×2 | display-dispatch — getTopModels min_cost_if_all_priced branch dispatches exactly like the generic else — removed |
| 1280 | 1 | NC ×1 | REAL GAP → TESTED ×1 | group-filter-live-lookups |
| 1298 | 1 | SV ×1 | REAL GAP → TESTED ×1 | display-dispatch |
| 1299 | 1 | SV ×1 | REAL GAP → TESTED ×1 | display-dispatch |
| 1300 | 1 | SV ×1 | REAL GAP → TESTED ×1 | display-dispatch |
| 1309 | 1 | NC ×1 | REAL GAP → TESTED ×1 | display-dispatch |

### metrics.ts L60-350 — model map, alias index, GDPval index, slug canon (40 undetected)

Verdicts: EQUIVALENT ×25, REAL-KILLED ×13, SUITE-KILLED ×2

| line | mutants | nightly status | verdict | killed by / rationale |
|---|---|---|---|---|
| 68 | 1 | SV ×1 | EQUIVALENT ×1 | initial wildcard list is overwritten by any loadModelMap/setModelMap before the first lookup |
| 73 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 83 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 85 | 4 | SV ×4 | EQUIVALENT ×4 | Object.entries of a parsed YAML map yields string keys only — the guard is a type-narrowing belt |
| 86 | 2 | SV ×2 | REAL GAP → TESTED ×2 | metrics-decision-core-r1 |
| 94 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 95 | 1 | SV ×1 | FALSE SURVIVOR ×1 | killed by the full suite (no-coverage-sweep); 1 also killed in isolation by the new tests |
| 100 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 102 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 103 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 112 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 126 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 146 | 2 | SV ×2 | EQUIVALENT ×2 | slash-less refs return `ref` under every variant (Batch 3 L128-130) |
| 181 | 1 | SV ×1 | EQUIVALENT ×1 | alias-index version init: the `modelMapAliasIndex === null` check short-circuits first |
| 190 | 1 | SV ×1 | EQUIVALENT ×1 | `slug == null` half of the skip guard: null-slug groups are never queried (aliasesFor early-returns); the slash-key half is killed |
| 193 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 206 | 2 | SV ×2 | EQUIVALENT ×2 | aliasesFor early return: null-slug lookups end in an empty group either way (Batch 3 L188-194) |
| 207 | 3 | SV ×3 | EQUIVALENT ×3 | staleness/rebuild checks: rebuilding is idempotent (Batch 3 L188-194) |
| 210 | 3 | NC ×1, SV ×2 | EQUIVALENT ×3 | self-filter / `?? []`: retrying the already-missed id is a harmless extra miss, the `?? []` is unreachable for a mapped slug (Batch 3 L188-194) |
| 221 | 1 | SV ×1 | EQUIVALENT ×1 | equal scores store the same value |
| 268 | 2 | SV ×2 | EQUIVALENT ×2 | regex anchor variants are indistinguishable for realistic digit-run segments (Batch 3 L249-253) |
| 294 | 1 | SV ×1 | EQUIVALENT ×1 | slug-canon cache check: rebuilding is idempotent (Batch 3 L277-283) |
| 298 | 3 | SV ×3 | FALSE SURVIVOR ×1; EQUIVALENT ×2 | killed by the full suite (slug-canon-dedup) — twin-condition variants map keys to themselves or to an equal-score twin (Batch 3 L277-283) |
| 315 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 335 | 1 | SV ×1 | EQUIVALENT ×1 | heal is idempotent (Batch 3 L292-299) |
| 337 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 346 | 1 | SV ×1 | EQUIVALENT ×1 | redundant guard: the next line returns the same null (Batch 3 L330) |

### metrics.ts L351-600 — slug pipeline, context window, state setters (32 undetected)

Verdicts: EQUIVALENT ×23, REAL-KILLED ×8, SUITE-KILLED ×1

| line | mutants | nightly status | verdict | killed by / rationale |
|---|---|---|---|---|
| 351 | 2 | SV ×2 | EQUIVALENT ×2 | empty-gdpval ternary: check 1 already restores from the cache (Batch 3 L335) |
| 362 | 1 | SV ×1 | EQUIVALENT ×1 | optional chaining on a cache that is always an object (Batch 3 L346-347) |
| 371 | 7 | SV ×7 | EQUIVALENT ×7 | canon.get(null\|undefined) is undefined, so `?? matched` returns the same null/undefined |
| 393 | 1 | SV ×1 | EQUIVALENT ×1 | rebuilding the token index on every call is a performance difference only |
| 397 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 409 | 1 | SV ×1 | FALSE SURVIVOR ×1 | killed by the full suite (cache-usage-wiring); 1 also killed in isolation by the new tests |
| 441 | 4 | SV ×4 | EQUIVALENT ×4 | no-slash refs and a missing registry both end in the try/catch → scan-cache fallthrough |
| 444 | 1 | SV ×1 | EQUIVALENT ×1 | optional chaining crash is caught by the surrounding try/catch (degraded registry path) |
| 445 | 1 | SV ×1 | EQUIVALENT ×1 | `undefined > 0` is false, so the typeof half of the guard is redundant |
| 454 | 1 | SV ×1 | EQUIVALENT ×1 | `?? []` fallback holds a string; find() over it never matches |
| 525 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 534 | 3 | SV ×3 | REAL GAP → TESTED ×2; EQUIVALENT ×1 | metrics-decision-core-r1 — Object.assign(gdpval, undefined) is a no-op; the extra version bump only rebuilds an index |
| 538 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 539 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 552 | 1 | SV ×1 | EQUIVALENT ×1 | spreading undefined capability_profiles is a no-op |
| 555 | 1 | SV ×1 | EQUIVALENT ×1 | spreading undefined gdpval_scores is a no-op; extra bump only rebuilds an index |
| 560 | 1 | SV ×1 | EQUIVALENT ×1 | Object.assign(merged, undefined) is a no-op |
| 564 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 590 | 1 | SV ×1 | EQUIVALENT ×1 | capabilityProfiles[null\|undefined] is undefined → the next line returns the same null |
| 598 | 1 | NC ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |

### metrics.ts L600-860 — cost resolution, getM, updateMetrics, free/billing (44 undetected)

Verdicts: REMOVED ×17, EQUIVALENT ×5, REAL-KILLED ×21, SUITE-KILLED ×1

| line | mutants | nightly status | verdict | killed by / rationale |
|---|---|---|---|---|
| 634 | 2 | SV ×2 | DEAD/REDUNDANT → removed ×2 | resolveCostPerM local-provider step: masked by the subscription step (local providers are billing:subscription) and by isFreeModelRef — removed |
| 647 | 4 | SV ×4 | DEAD/REDUNDANT → removed ×4 | resolveCostPerM discovered-0 step: duplicate of isFreeModelRef's discovered check — removed |
| 648 | 2 | SV ×2 | DEAD/REDUNDANT → removed ×2 | resolveCostPerM discovered-0 step: duplicate of isFreeModelRef's discovered check — removed |
| 669 | 1 | SV ×1 | EQUIVALENT ×1 | Config.model_metrics is a required field; optional chaining is belt-and-braces |
| 679 | 6 | SV ×6 | REAL GAP → TESTED ×6 | metrics-decision-core-r1 |
| 700 | 1 | SV ×1 | FALSE SURVIVOR ×1 | killed by the full suite (sort-by-methods); 1 also killed in isolation by the new tests |
| 714 | 5 | SV ×5 | REAL GAP → TESTED ×5 | metrics-decision-core-r1 |
| 716 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 756 | 1 | SV ×1 | EQUIVALENT ×1 | lookupCapability(ref, <other column>) finds no such profile key → null → same gdpval fallthrough |
| 795 | 2 | SV ×2 | REAL GAP → TESTED ×2 | metrics-decision-core-r1 |
| 797 | 2 | SV ×2 | REAL GAP → TESTED ×1; DEAD/REDUNDANT → removed ×1 | metrics-decision-core-r1 — isFreeModelRef free-list check masked by the byte-identical third check — duplicate removed |
| 798 | 4 | SV ×4 | REAL GAP → TESTED ×3; DEAD/REDUNDANT → removed ×1 | metrics-decision-core-r1 — bare-id derivation masked by the duplicate third check — duplicate removed |
| 799 | 2 | NC ×1, SV ×1 | REAL GAP → TESTED ×2 | metrics-decision-core-r1 |
| 800 | 3 | NC ×1, SV ×2 | DEAD/REDUNDANT → removed ×3 | third free-list check byte-identical to the first for every slash ref — removed |
| 803 | 1 | SV ×1 | EQUIVALENT ×1 | `?? []` fallback holds a string; find() over it never matches |
| 826 | 1 | SV ×1 | EQUIVALENT ×1 | an empty billing string falls to tier 3 exactly like pay_per_token |
| 837 | 1 | SV ×1 | DEAD/REDUNDANT → removed ×1 | billingTier free-list check masked by the duplicate third check — duplicate removed |
| 838 | 2 | SV ×2 | REAL GAP → TESTED ×1; DEAD/REDUNDANT → removed ×1 | metrics-decision-core-r1 — bare-id derivation masked by the duplicate third check — duplicate removed |
| 840 | 2 | SV ×2 | DEAD/REDUNDANT → removed ×2 | third free-list check byte-identical to the first for every slash ref — removed |
| 842 | 1 | NC ×1 | EQUIVALENT ×1 | `?? []` fallback holds a string; find() over it never matches |

### metrics.ts L880-1150 — registry lookup, pricing chain, effCost, subscription rule (70 undetected)

Verdicts: REAL-KILLED ×20, EQUIVALENT ×15, REMOVED ×35

| line | mutants | nightly status | verdict | killed by / rationale |
|---|---|---|---|---|
| 899 | 2 | SV ×2 | REAL GAP → TESTED ×2 | metrics-decision-core-r1 |
| 910 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 920 | 1 | SV ×1 | EQUIVALENT ×1 | registryCost is wrapped in try/catch → TypeError → null (Batch 2 L901) |
| 928 | 1 | SV ×1 | EQUIVALENT ×1 | PROVIDER_MAP miss crashes into the same try/catch null (Batch 2 L909-910) |
| 929 | 1 | SV ×1 | EQUIVALENT ×1 | retrying the primary provider with an undefined alias yields the same miss (Batch 2 L909-910) |
| 931 | 2 | SV ×2 | EQUIVALENT ×2 | destructure of a missing cost → TypeError → catch → null (Batch 2 L912) |
| 933 | 3 | SV ×3 | REAL GAP → TESTED ×3 | metrics-decision-core-r1 |
| 938 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 940 | 1 | NC ×1 | EQUIVALENT ×1 | missing return yields undefined ≡ null for every caller (Batch 2 L921) |
| 966 | 3 | SV ×3 | EQUIVALENT ×3 | redundant gate: the generic `{input: cost, output: cost}` produces the identical sentinel (Batch 2 L947) |
| 989 | 1 | SV ×1 | EQUIVALENT ×1 | first call: `pricing !== null` already differs from the initial identity |
| 994 | 3 | SV ×3 | REAL GAP → TESTED ×2; EQUIVALENT ×1 | metrics-decision-core-r1 — rebuilding the paid index on every call is a performance difference only |
| 999 | 8 | SV ×8 | DEAD/REDUNDANT → removed ×8 | kModel prefix strip removed: norm() already keeps only the last path segment, so every variant produced the same key |
| 1001 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 1016 | 4 | SV ×4 | REAL GAP → TESTED ×4 | metrics-decision-core-r1 |
| 1018 | 1 | NC ×1 | EQUIVALENT ×1 | `?? []` fallback holds a string; find() over it never matches |
| 1019 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 1020 | 2 | SV ×2 | REAL GAP → TESTED ×1; EQUIVALENT ×1 | metrics-decision-core-r1 — `?? []` fallback holds a string; includes(ref) never matches |
| 1064 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 1096 | 3 | SV ×3 | REAL GAP → TESTED ×2; EQUIVALENT ×1 | metrics-decision-core-r1 — `'unknown' > 0` is false, so the typeof half of the guard is redundant |
| 1118 | 1 | SV ×1 | EQUIVALENT ×1 | `null * costMux(prov)` is 0 — same as the explicit early return |
| 1119 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 1123 | 2 | NC ×1, SV ×1 | DEAD/REDUNDANT → removed ×2 | effCost step 2 unreachable (getM heals cost_per_m to a defined value) — removed |
| 1125 | 3 | NC ×3 | DEAD/REDUNDANT → removed ×3 | effCost step 2 unreachable — removed |
| 1126 | 10 | NC ×10 | DEAD/REDUNDANT → removed ×10 | effCost step 2 unreachable — removed |
| 1127 | 1 | NC ×1 | DEAD/REDUNDANT → removed ×1 | effCost step 2 unreachable — removed |
| 1134 | 2 | NC ×1, SV ×1 | DEAD/REDUNDANT → removed ×2 | effCost step 3 unreachable — removed |
| 1137 | 3 | NC ×3 | DEAD/REDUNDANT → removed ×3 | effCost step 3 unreachable — removed |
| 1140 | 2 | NC ×2 | DEAD/REDUNDANT → removed ×2 | effCost step 3 unreachable — removed |
| 1141 | 4 | NC ×4 | DEAD/REDUNDANT → removed ×4 | effCost step 3 unreachable — removed |

### metrics.ts L1170-1210 — usage windows (16 undetected)

Verdicts: EQUIVALENT ×3, REAL-KILLED ×13

| line | mutants | nightly status | verdict | killed by / rationale |
|---|---|---|---|---|
| 1176 | 1 | NC ×1 | EQUIVALENT ×1 | `?? []` fallback holds a string; the filter predicate never matches |
| 1177 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 1187 | 1 | NC ×1 | EQUIVALENT ×1 | `?? []` fallback holds a string; `undefined > cutoff` is false |
| 1188 | 1 | SV ×1 | REAL GAP → TESTED ×1 | metrics-decision-core-r1 |
| 1199 | 3 | SV ×3 | REAL GAP → TESTED ×3 | metrics-decision-core-r1 |
| 1201 | 1 | NC ×1 | EQUIVALENT ×1 | `?? []` fallback holds a string; `undefined <= cutoff` is false and the cache check skips it |
| 1202 | 8 | SV ×8 | REAL GAP → TESTED ×8 | metrics-decision-core-r1 |
