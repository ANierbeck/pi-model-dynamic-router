# Mutation Survivor Triage Ledger

> Companion to docs/plans/2026-10-04-mutation-survivor-triage.md (Part A =
> operating model, Part B = batches). One row per undetected mutant (or
> tight line cluster); verdicts are filled batch-by-batch. New nightly
> reports are triaged against THIS ledger: a survivor already carrying a
> verdict stays parked; only new/changed entries become work items.

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
| L107–110 setModelMap version counter (`++` → `--`) | 1 | EQUIVALENT | only consumed via `!==` staleness checks — any change (up or down) triggers the same rebuild; no collision is reachable |
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

## HOTSPOT routing.ts:1000-1100 (68 undetected)

| line | mutator | status | verdict | rationale |
|---|---|---|---|---|
| 1024 | ConditionalExpression | Survived | UNTRIAGED | |
| 1025 | MethodExpression | Survived | UNTRIAGED | |
| 1060 | StringLiteral | Survived | UNTRIAGED | |
| 1061 | BlockStatement | Survived | UNTRIAGED | |
| 1061 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1061 | EqualityOperator | Survived | UNTRIAGED | |
| 1061 | StringLiteral | Survived | UNTRIAGED | |
| 1064 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1064 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1064 | EqualityOperator | Survived | UNTRIAGED | |
| 1064 | LogicalOperator | Survived | UNTRIAGED | |
| 1064 | StringLiteral | Survived | UNTRIAGED | |
| 1065 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1067 | ConditionalExpression ×3 | NoCoverage | UNTRIAGED | |
| 1067 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1067 | LogicalOperator | NoCoverage | UNTRIAGED | |
| 1067 | MethodExpression | NoCoverage | UNTRIAGED | |
| 1069 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1069 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1069 | EqualityOperator | Survived | UNTRIAGED | |
| 1069 | StringLiteral | Survived | UNTRIAGED | |
| 1070 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 1070 | LogicalOperator | NoCoverage | UNTRIAGED | |
| 1071 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 1072 | ArrayDeclaration | NoCoverage | UNTRIAGED | |
| 1072 | MethodExpression ×2 | NoCoverage | UNTRIAGED | |
| 1073 | BlockStatement | Survived | UNTRIAGED | |
| 1073 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1073 | EqualityOperator | Survived | UNTRIAGED | |
| 1073 | StringLiteral | Survived | UNTRIAGED | |
| 1074 | StringLiteral | Survived | UNTRIAGED | |
| 1075 | ConditionalExpression | NoCoverage | UNTRIAGED | |
| 1075 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1075 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1075 | LogicalOperator | Survived | UNTRIAGED | |
| 1075 | MethodExpression | NoCoverage | UNTRIAGED | |
| 1076 | BlockStatement | Survived | UNTRIAGED | |
| 1078 | ConditionalExpression | NoCoverage | UNTRIAGED | |
| 1078 | ConditionalExpression ×2 | Survived | UNTRIAGED | |
| 1078 | EqualityOperator ×2 | NoCoverage | UNTRIAGED | |
| 1078 | LogicalOperator | Survived | UNTRIAGED | |
| 1078 | MethodExpression | NoCoverage | UNTRIAGED | |
| 1090 | BlockStatement | NoCoverage | UNTRIAGED | |
| 1091 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1097 | MethodExpression ×2 | NoCoverage | UNTRIAGED | |
| 1098 | ArrowFunction | NoCoverage | UNTRIAGED | |
| 1098 | ConditionalExpression ×2 | NoCoverage | UNTRIAGED | |
| 1098 | EqualityOperator | NoCoverage | UNTRIAGED | |
| 1098 | StringLiteral | NoCoverage | UNTRIAGED | |
| 1099 | ArithmeticOperator | NoCoverage | UNTRIAGED | |
| 1099 | ArrowFunction | NoCoverage | UNTRIAGED | |
| 1099 | LogicalOperator ×2 | NoCoverage | UNTRIAGED | |

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
