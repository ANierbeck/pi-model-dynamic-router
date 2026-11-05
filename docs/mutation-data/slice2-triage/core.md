<!--
Slice-2 triage verdict inventory (driveStream survivors, recheck report
docs/mutation-data/slice2-driveStream.json). Produced 2026-11-05 by four
parallel reading agents against the INSTRUMENTED tree c101b27 (the tree the
recheck instrumented; NOT fde54f8), cross-checked against then-current main.

EMPIRICAL CORRECTIONS (hand-applied mutants + full-suite runs on main @ 9c57cda,
see docs/mutation-triage.md "Slice 2 triage" for the runs):
- core: mutant 871 (unconfirmed) was claimed 'already rejected by classifier-replay.test.ts' — DISPROVED: it survives the full suite on main. Real gap (thin: the reachable divergence needs a silent-skip-without-reason candidate; empty-candidates is handled at resolve level). Mutant 659 (UNSURE) is resolved: it is the INVERTED `if (!retryTarget) retryAttempt.abandon()` guard (abandons the LIVE retry stream) — the wait-retry twin of collapse 1058/1059, a real gap needing a signal-respecting fixture. Mutants 669/670: see the pre-region correction — real gaps, not false survivors.

Verdict key: TESTED-IDEA = real gap, needs a red-first test (sketch in the row);
EQUIVALENT = behavior-identical, rationale per line; REDUNDANT = dead code,
removal candidate (AGENTS.md §7); "already killed"/"false survivor" claims in
these files were CHECKED — see the corrections above for which held.
-->

# Mutation triage — driveStream core (rate-limit wait → fallback cascade)

Region: `src/stream-orchestrator.ts`, pristine lines 860–1081 (rate-limit wait retry block, context-overflow handling, repetition/truncated branches, paid/soft failure narration, stream-error catch, fallback cascade).

**Line mapping:** every mutant line N maps to pristine line **N−40** (verified entry-by-entry against file content; the report was generated against a tree with 40 extra lines above this region). On current main the same code sits at **pristine+47…+51** (e.g. `rateLimitWaitUsed = true` pristine 860 → current 907). All clusters exist on current main → **0 GONE**.

**Key facts verified in source/tests:**
- `pushError` (current 713) is a pure append to `allErrors`; the aggregate error (current 1381–1393) embeds each message — pushed text only matters if the walk ends in that aggregate error.
- `recordStreamFailure` (limit-glue.ts 141): only `rate_limit_exceeded` or text-gated `isPaidCloudRateLimitFailure` take the hard-limit branch; `context_overflow`/`repetition_loop`/`truncated_length`/`""` all take the identical soft path — the reason string is session-error metadata.
- The breaker seam (index.ts 681–695 → provider-breaker.ts) independently filters rate-limit-shaped `provider_error` text; only `empty_response|empty_timeout|stall_timeout|provider_error` count as evidence.
- `getFallbackGroup(undefined, …)` returns null (routing.ts 421–422); `nextAttemptableRef` is pure; `narrateBreakerOpen` is narration-only.
- `driveStream`'s fallback cascade (current 1126–1145) is **not driven end-to-end by any test** (`fallback-chain.test.ts` unit-tests `getFallbackGroup`; escalation-streak/router-info-events only feed the narration *text* elsewhere). The rate-limit **retry-fails-again** sub-path and the **catch (streamError)** path are likewise untested (breaker cases use empty/error-event streams, not throws).

Verdicts: TI = TESTED-IDEA, EQ = EQUIVALENT, RED = REDUNDANT.

## Cluster A — rate-limit wait retry block (pristine 860–902, current 907–950)

| Pristine | Mutants (id: mutator) | Verdict | Rationale |
|---|---|---|---|
| 860 | 651: BooleanLiteral→false | TI | Gates ONE wait per walk; false allows a second — fixture: two models both 429 near reset, model1's retry fails far-reset → pristine cascades past model2 ("rate limit/spend limit reached") to model3; mutant waits for model2 → assert model3 called and only one "waiting" narration. |
| 861 | 652: ArithmeticOperator `/`→`*` | EQ | `waitSecs` feeds only the routerLog line and the narration number; the actual sleep uses `resetInMs`. |
| 863 | 654: StringLiteral→`` | EQ | routerLog text — observability per open decision 2. |
| 869 | 657: `resetInMs + 2000`→`- 2000` | TI | The retry fires ~2s BEFORE the provider's reset — fixture: reset-aware script (429 events while `Date.now() < resetAt`, healthy after), `rate_limit_wait_max_ms=4000`, reset at +1.5s → pristine retry succeeds; mutant retries early, 429s again, cascades → assert retry text present / fallback not called. |
| 871 | 658: ArrowFunction→`() => undefined` | EQ | `!undefined` ≡ `!null` — the null-vs-undefined distinction is never observed. |
| 872 | 659: BooleanLiteral→"retryTarget" | UNSURE | Mutated expression unclear (no boolean literal on this line); if it inverts the guard, a retry-success test asserting the retry's signal is NOT aborted would kill it — hand-check before ledgering. |
| 872 | 660: CondExpr→true, 661: CondExpr→false, 662: CallExpr→`;` | TI | Abandon of a retry whose `tryStream` returned null is never asserted — fixture: `streamSimple` throws on the ref's second call (retry tryStream → null); assert the retry attempt's AbortSignal was aborted (pattern of `stream-abandon-and-text-scan.test.ts`). |
| 873 | 663: CondExpr→true | TI (thin) | With `retryTarget` null the block dereferences `.stream` → TypeError caught by the outer catch → extra provider_error record + "— error:" narration — fixture: retry tryStream throws; assert no "— error:" line for the ref. |
| 874 | 666: `false`→`true` | TI | A timed-out (still-running) retry attempt is never abandoned → late events leak — fixture: retry returns empty-timeout then a late `text_delta`; assert the late text never reaches the output (stream-abandon #2 pattern). |
| 882 | 669: CondExpr→false, 670: BlockStatement→`{}` | TI — **already killed** | The successful retry is rerouted to the still-failing path and the walk cascades to the healthy model, which `rate-limit-wait.test.ts` #1 asserts is never called — false survivor (perTest artifact), recheck before ledgering. |
| 883 | 671: `true`→`false` | EQ | Only adds an `abandon()` of an already-completed successful retry stream — aborting a finished controller is a no-op. |
| 884 | 672: CallExpr→`;` | TI | `recordOk` clears the 429 cooldown after a successful retry — fixture: two consecutive `groupStream` calls; pristine attempts the model again on turn 2, mutant skips it (cooldown) → assert call list per turn. |
| 887 | 674: CondExpr→false, 676: StringLiteral `''`→`""` | TI | An aborted retry falls through to `recordStreamFailure` + "still failing" narration and cascades despite the user abort — fixture: abort the proxy signal mid-retry; assert no further candidate calls. |
| 891 | 677–683 (CondExpr true/false, LogicalOperator `\|\|`, EqualityOperator `!==`, StringLiteral `""`, CallExpr `;`) | TI (expensive) | The deliberate "post-wait bare 422 feeds the learned blocklist" seam — mutant starves (or over-feeds) blocklist streaks — fixture: N turns where the model 429s near-reset then retries into a bare 422; pristine eventually excludes the ref, mutant keeps attempting it → assert attempts-per-turn or blocklist state. |
| 895 | 686: StringLiteral→`` | EQ | Aggregate error-message text only (count unchanged); message text is observability. |
| 898 | 688: StringLiteral→`` | EQ | Narration text. |
| 900 | 689: BlockStatement→`{}` | TI | Removes the whole finally: local slot leak + lost abandon — fixture: LOCAL provider rate-limited near reset, retry succeeds, next turn needs another local stream; mutant's leaked slot blocks it → assert the second local stream starts. |
| 901 | 690: BooleanLiteral→"retrySucceeded", 692: CondExpr→false, 693: CallExpr→`;` | TI | Failed retry attempt never cancelled → late-event leak — same fixture as 666. |
| 901 | 691: CondExpr→true | EQ | Always-abandon also hits the success path, where aborting the finished retry stream is a no-op; the failure path behaves as pristine. |
| 902 | 694: CallExpr→`;` | TI | Local slot leak — same fixture as 689 (local provider, retry path). |

## Cluster B — rate-limit non-wait narration (pristine 909, current 955–956)

| Pristine | Mutants | Verdict | Rationale |
|---|---|---|---|
| 909 | 696, 697: StringLiteral | EQ | Suffix template feeds only the "rate limit/spend limit reached" narration text. |

## Cluster C — context_overflow branch (pristine 918–970, current 966–1015)

| Pristine | Mutants | Verdict | Rationale |
|---|---|---|---|
| 918/919 | 706: CondExpr→false, 707: BlockStatement→`{}`, 708: CallExpr→`;` | TI | The discovered real context window must persist — fixture: parseable overflow on model A (requested ≈197K), then a second `groupStream` call with a >196K-token prompt (inflated tool_result, runtime-overflow pattern); pristine skips A via the context guard, mutant retries A → assert A not called on turn 2. |
| 921 | 710: StringLiteral→`` | EQ | routerLog text. |
| 929 | 713: MethodExpression (filter neutralized) | TI | Remaining too-small candidates would be tried — fixture: small(200K) overflows parseable; remaining tiny(100K) then big(1M); pristine tries only big, mutant tiny first → assert call order `[small, big]`. |
| 931 | 717: CondExpr→true, 720: BooleanLiteral→"cw", 722: `>`→`>=` | TI | Same filter weakened (known windows always pass / boundary included) — same fixture plus a boundary candidate with `cw === minNeeded` that pristine must exclude; kills all three. |
| 942 | 730: StringLiteral `''`→`""` | EQ | `recordStreamFailure` takes the identical soft path for `''` and `'context_overflow'`; the reason string is session-error metadata only. |
| 947 | 732, 733: StringLiteral, 734: LogicalOperator `??`→`&&` | EQ | `label2` is narration/label plumbing only. |
| 950 | 737: LogicalOperator `??`→`&&`, 739: StringLiteral | EQ | Narration text. |
| 960 | 741: StringLiteral→`""` | RED | Dead store: the genuine-overflow path `pushStreamError`s and `return`s immediately (pristine 962–970), so this `allErrors` entry is never consumed — the `pushError` call itself is a §7 removal candidate. |
| 961 | 743: StringLiteral `''`→`""` | EQ | Soft path either way; reason is metadata only. |
| 964 | 745: StringLiteral→`` | TI | The compaction headline is the error event's content — fixture: provider-reported overflow, no larger candidates; assert the content contains "rejected the prompt as too large … triggering compaction" (runtime-overflow harness already pins the errorMessage half). |
| 967 | 747: StringLiteral→`` | TI | The no-detail branch of the compaction message — fixture: `context_overflow` with falsy `detail` (stream-proxy.ts 746 makes this reachable), no larger candidates; assert `errorMessage` matches /prompt is too long/. |

## Cluster D — repetition_loop branch (pristine 972–981, current 1019–1028)

| Pristine | Mutants | Verdict | Rationale |
|---|---|---|---|
| 972 | 749: CondExpr→false, 751: StringLiteral `''`→`""`, 752: BlockStatement→`{}` | TI | The branch collapses into the generic soft path, losing the branch-distinctive "stuck in a repetition loop" narration — fixture: model1 repetition_loop, model2 healthy; assert that narration (B3 precedent pinned the collapse-branch twin; the main-loop one is unpinned). |
| 973 | 754, 756: StringLiteral, 755: LogicalOperator `??`→`&&` | EQ | Aggregate error-message text only. |
| 974 | 758: StringLiteral `''`→`""` | EQ | Soft path either way; metadata only. |
| 975 | 759: `i + 1`→`i - 1` | EQ | `nextAttemptableRef` is pure and feeds only the narration suffix. |
| 976 | 760, 761: StringLiteral | EQ | Narration suffix text. |
| 979 | 763, 765: StringLiteral, 764: LogicalOperator `??`→`&&` | EQ | Narration text. |

## Cluster E — truncated_length branch (pristine 983–992, current 1030–1039)

| Pristine | Mutants | Verdict | Rationale |
|---|---|---|---|
| 984 | 772: StringLiteral→`""` | EQ | Aggregate error-message text only. |
| 985 | 774: StringLiteral `''`→`""` | EQ | Soft path either way; metadata only. |
| 987 | 776, 777: StringLiteral | EQ | Narration text (the collapse-branch twin is already pinned by the B3 test; this main-loop line differs only in text). |

## Cluster F — paid rate-limit branch (pristine 999–1023, current 1046–1070)

| Pristine | Mutants | Verdict | Rationale |
|---|---|---|---|
| 1001 | 785: StringLiteral→`""` | EQ | Aggregate error-message text only. |
| 1009 | 789: CondExpr→true, 791: StringLiteral `''`→`""` | EQ | Defensive double-guard: a `provider_error` reaching this branch is by definition rate-limit-shaped, and the breaker seam filters exactly those texts (provider-breaker case 4, `not.toContain('looks wedged')`, passes either way). |
| 1015 | 796: StringLiteral | EQ | Narration suffix text. |
| 1016 | 798: CondExpr→false, 800: StringLiteral | EQ | `paidLabel` selection feeds only the narration line. |
| 1017 | 801: StringLiteral | EQ | Narration label text. |
| 1018 | 803: CondExpr→false, 805: StringLiteral | EQ | Narration label selection/text. |
| 1019 | 806–808: StringLiteral | EQ | Narration label text. |

## Cluster G — soft-failure reason narration (pristine 1038–1048, current 1086–1096)

| Pristine | Mutants | Verdict | Rationale (per line) |
|---|---|---|---|
| 1038 | 818: CondExpr→false, 820: StringLiteral | EQ | The `reason` chain feeds only the final narration line. |
| 1039 | 821: StringLiteral | EQ | Narration text. |
| 1040 | 823: CondExpr→false, 825: StringLiteral | EQ | Narration label selection. |
| 1041 | 826: StringLiteral | EQ | Narration text. |
| 1042 | 827: CondExpr→true | EQ | Only changes which narration label is rendered. |
| 1043 | 833: StringLiteral | EQ | Narration label text. |
| 1044 | 834: CondExpr→true, 835: CondExpr→false, 836: `===`→`!==`, 837: StringLiteral | EQ | Narration label selection; no state or control flow beyond the rendered string changes. |
| 1045 | 838, 839: StringLiteral→``, 840: StringLiteral | EQ | Narration label text. |
| 1046 | 841: StringLiteral | EQ | Narration text. |
| 1048 | 843, 844: StringLiteral | EQ | Narration suffix text. |

## Cluster H — catch (streamError) path (pristine 1050–1061, current 1100–1111)

| Pristine | Mutants | Verdict | Rationale |
|---|---|---|---|
| 1050 | 847: BlockStatement→`{}` | TI | Thrown-stream failures lose narration, cooldown, session-error and blocklist evidence — fixture: `streamSimple` returns a throwing generator for model1, model2 healthy; assert the "> [router] m1 — error: …" narration and that turn 2 skips m1 (cooldown recorded). |
| 1052 | 848: CallExpr→`;` | TI | The failure line vanishes from the aggregate error — fixture: both models throw; assert the error event lists 2 `•` failure lines ("All N candidate(s) failed" — N is behavior). |
| 1053 | 849: CallExpr→`;` | TI (expensive) | Blocklist streak evidence lost on thrown errors — multi-turn blocklist fixture (same family as 891). |
| 1057 | 851: StringLiteral `''`→`""` | EQ | `recordStreamFailure`'s guard is text-gated (`isPaidCloudRateLimitFailure`), so `''` and `'provider_error'` take the same branch; reason is metadata. |
| 1058 | 852: CondExpr→true, 853: CondExpr→false, 854: StringLiteral `''`→`""`, 855: CallExpr→`;` | TI | Breaker-on-thrown-errors path is untested (breaker cases use empty/error-event streams, not throws) — fixture: three same-provider models whose streams throw connection/5xx-shaped errors; assert "looks wedged" narrated exactly once and the 4th same-provider candidate skipped. |
| 1059 | 856: `i + 1`→`i - 1` | EQ | Pure `nextAttemptableRef` feeds only the narration suffix. |
| 1060 | 857, 858: StringLiteral | EQ | Narration suffix text. |
| 1061 | 860: StringLiteral→`` | EQ | Narration text. |

## Cluster I — fallback cascade (pristine 1076–1081, current 1126–1131)

| Pristine | Mutants | Verdict | Rationale |
|---|---|---|---|
| 1076 | 867: CondExpr→true, 869: `>`→`>=` | EQ | Defensive invariant: every skip/denial path records an error or failure (cooldown/breaker/context/tryStream-null skips all `pushError` or carry skipReasons), so `allErrors` is nonempty whenever the loop ran; an empty walk needs an empty candidate list, which callers never pass. |
| 1077 | 872: CondExpr→false, 874: BlockStatement→`{}` | TI | The driveStream fallback cascade is untested end-to-end — fixture: group `simple` with two failing models + `fallback_groups: ['standard']` with a healthy model; assert narration "All models in simple failed, trying standard", the standard model called, no terminal error event. |
| 1077 | 873: LogicalOperator `\|\|` | EQ | Given the allFailed invariant, `\|\|` differs only when `groupName` is undefined, and `getFallbackGroup(undefined, …)` returns null (routing.ts 421–422) — no observable difference. |
| 1077 | 871: CondExpr→true (unconfirmed) | TI | Already REJECTED by `classifier-replay.test.ts` — not a genuine survivor; implies a no-error walk reaches the cascade (empty-candidates edge), worth a characterization test; recheck to convert to killed. |
| 1081 | 878: CondExpr→false, 879: BlockStatement→`{}` | TI | Same fixture as 872/874 — guard off → fallback never tried, walk hard-fails instead. |

## Summary

| Verdict | Count | Notes |
|---|---|---|
| TESTED-IDEA | 48 | per-cluster tables; incl. 669/670 (already killed by `rate-limit-wait.test.ts` — false survivors, recheck) and 871 (unconfirmed, already rejected) |
| EQUIVALENT | 69 | narration/log/message text, defensive guards with identical outcome, metadata-only reason strings |
| REDUNDANT | 1 | 741 — dead-store `pushError` on the early-return genuine-overflow path (§7 removal candidate) |
| UNSURE | 1 | 659 — mutated expression unclear; hand-check |
| GONE | 0 | — |
| **Total** | **119** | 118 survived + 1 unconfirmed |

Highest-value gaps (one test each): (1) fallback-cascade e2e (5 mutants + unconfirmed 871); (2) retry-fails-again family in the rate-limit wait block (~15, incl. two likely false survivors); (3) breaker-on-thrown-errors (4); (4) larger-candidates filter with tiny/boundary fixtures (4); (5) catch-path handling (3+).
