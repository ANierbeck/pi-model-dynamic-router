<!--
Slice-2 triage verdict inventory (driveStream survivors, recheck report
docs/mutation-data/slice2-driveStream.json). Produced 2026-11-05 by four
parallel reading agents against the INSTRUMENTED tree c101b27 (the tree the
recheck instrumented; NOT fde54f8), cross-checked against then-current main.

EMPIRICAL CORRECTIONS (hand-applied mutants + full-suite runs on main @ 9c57cda,
see docs/mutation-triage.md "Slice 2 triage" for the runs):
- pre: mutants 669/670 were claimed 'already killed by rate-limit-wait.test.ts' by the CORE file — DISPROVED: they survive the full suite on main (bogus recordStreamFailure('undefined') + skipped recordOk are state-level only; the narration and post-terminal cascade are invisible in the event stream). Real gaps.

Verdict key: TESTED-IDEA = real gap, needs a red-first test (sketch in the row);
EQUIVALENT = behavior-identical, rationale per line; REDUNDANT = dead code,
removal candidate (AGENTS.md §7); "already killed"/"false survivor" claims in
these files were CHECKED — see the corrections above for which held.
-->

# Mutation triage — driveStream-pre region (src/stream-orchestrator.ts)

55 survivors from `/tmp/mut-triage/surv-pre.json`.

**Line-number note:** the mutant `line` fields do **not** match the provided
`stream-orchestrator-fde54f8.ts` (that file predates the driveStream/walkCandidates
split + failStream refactor). They match **c101b27** exactly (failStream call at 687,
`r.startsWith('ollama/')` lookahead at 743, etc.); all verdicts below were made
reading `git show c101b27:src/stream-orchestrator.ts`, cross-checked against the
fde54f8 text (same code, ~45 lines earlier) and current main (a69abd3, same code,
+1…+5 lines). **No mutant is GONE** — every mutated line still exists on current
main; none of the pinned decision log lines ('HINT group not found',
'[escalation] Using escalated group', 'skipping unusable refs', 'HINT fallback
candidates') appear in this region.

Harness for sketches: the groupStream harness pattern of
`test/orchestrator-hint-wiring.test.ts` (real `StreamOrchestrator`, stubbed ctx
seams) or the walk-level harness of `test/consolidated-stream-error-pins.test.ts`.

---

## A. failStream `where` text — line 687

| pristine line (c101b27) | mutator / id | verdict | rationale |
|---|---|---|---|
| 687 | StringLiteral `→ `` ` / 470 | EQUIVALENT | The `outside the candidate loop…` template feeds only `errorLog` inside failStream — log text, observability. |
| 687 | LogicalOperator `?? → &&` / 471 | EQUIVALENT | `(groupName ?? label) && '?'` only warps the same `where` string consumed solely by errorLog — log text. |
| 687 | StringLiteral `'?' → ""` / 473 | EQUIVALENT | Same `where` string, same errorLog-only sink — log text. |

## B. failStream error strings — lines 694–695

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 694 | StringLiteral `→ `` ` / 476 | EQUIVALENT | errorLog template — log text only. |
| 695 | StringLiteral `→ `` ` / 478 | TESTED-IDEA | First pushStreamError string is the user-visible terminal error text; `drive-stream-never-rejects.test.ts` only greps the detail substring anywhere in the event, so each twin masks the other. |
| 695 | StringLiteral `→ `` ` / 479 | TESTED-IDEA | Second pushStreamError string (the `error` field of the terminal event) — same masking, same gap. |

**Test sketch (kills 478+479):** extend `drive-stream-never-rejects.test.ts`:
throwing ctx (estimate explodes), drain the proxy, then assert exactly —
`err.error.text` (first string) contains `[router] Routing failed: estimate exploded`
and the error-field message contains `[router] routing failed: estimate exploded`.
Each mutant empties one of the two fields, so exact-field assertions kill each separately.

## C. walk-start group sync — line 709

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 709 | ConditionalExpression `→ true` / 481 | TESTED-IDEA (weak) | `if (true)` calls `router.setActiveGroup(null)` when `ctx.activeGroup` is null, clearing a possibly stale `router.activeGroup` (event-handlers clears `rt.activeGroup` on non-restore `model_select` without syncing the router) — router.activeGroup is observable state (getActiveGroup/detectGroup/status line). |
| 709 | ConditionalExpression `→ false` / 482 | EQUIVALENT | Every writer of a non-null `ctx.activeGroup` (tools.ts:108-109) also syncs `router.activeGroup`, and `recordServedRef` re-syncs on every served ref — the guarded sync is a no-op in all reachable states (drift exists only in the null direction, where the guard skips too). |
| 709 | CallExpression `→ ;` / 483 | EQUIVALENT | Removing the call is behaviorally identical to 482 for the same reason. |

**Test sketch (kills 481):** harness ctx with `activeGroup: null`, a router stub
pre-seeded via `setActiveGroup('code')`, and a walk where every candidate
soft-fails; assert `router.activeGroup` is still `'code'` after the walk (mutant
clears it to null). §7 note: the sync line itself is a redundancy candidate —
flag to the owner rather than removing blind (sub-call paths were not exhaustively
checked for ctx.activeGroup writers).

## D. nextAttemptableRef lookahead guards — lines 742–743

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 742 | ConditionalExpression `→ false` / 498 | TESTED-IDEA | Drops the breaker check in the narration lookahead, so the ", trying X …" suffix can name a ref the loop then silently skips — exactly the 2026-10-03 live bug the lookahead exists for. |
| 743 | ConditionalExpression `→ false` / 500 | TESTED-IDEA | Drops the ollama-down check in the lookahead — suffix names a doomed ollama ref. |
| 743 | LogicalOperator `&& → ||` / 501 | TESTED-IDEA | `startsWith('ollama/') || isOllamaProbablyDown()` also skips every cloud ref while the daemon is down — suffix vanishes or names nothing. |
| 743 | MethodExpression `startsWith → endsWith` / 502 | TESTED-IDEA | No ref ends with `'ollama/'`, so the guard never fires — same as 500. |
| 743 | StringLiteral `'ollama/' → ""` / 503 | TESTED-IDEA | `startsWith('')` is always true, so with the daemon down the lookahead skips every candidate — suffix vanishes. |

**Test sketch (kills all five):** walk-level harness, candidates
`[a/one, b/wedge, ollama/nemo, c/two]` where `a/one` soft-fails on first serve,
`ctx.isBreakerOpen` is true only for `b/wedge`, `isOllamaProbablyDown` is stubbed
true (mock ollama-utils), and `c/two` is clean. Assert the failure narration for
`a/one` carries the suffix `, trying c/two …` (498/500/502/503 would name
`b/wedge`/`ollama/nemo`; 501 yields no suffix).

## E. pre-flight breaker skip — lines 765–768

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 765 | StringLiteral `'/' → ""` / 522 | TESTED-IDEA | `ref.split('')[0]` keys breakerState by the first character, so `secsLeft` comes from a wrong/empty state and the user-facing skip reason is wrong. |
| 766 | MethodExpression `max → min` / 523 | TESTED-IDEA | secsLeft clamps to 0 — the user-facing "(Ns remaining)" in the aggregated failure message is wrong. |
| 766 | ArithmeticOperator `/ → *` / 524 | TESTED-IDEA | secsLeft inflates 1000× — same user-facing message corrupted. |
| 766 | ArithmeticOperator `- → +` / 525 | TESTED-IDEA | secsLeft becomes a huge nonsense value — same message corrupted. |
| 767 | StringLiteral `→ `` ` / 527 | TESTED-IDEA | Empties the "skipped, provider breaker open" reason that lands in the user-visible "All candidates failed" terminal error. |
| 768 | CallExpression `→ ;` / 528 | EQUIVALENT | noteBreakerSkip only increments the `avoided_hops` telemetry counter, read solely by the /router stats display (commands.ts:762) — observability, no decision consumes it. |

**Test sketch (kills 522–527):** harness with a provider breaker armed until
`now + 90_000` (via the breaker-state helpers on `ctx.cache`), walk its ref, drain
the terminal error and assert it contains `skipped, provider breaker open (90s remaining)`
(523-525 change the number, 522 the state lookup, 527 removes the text).

## F. ollama-down skip reason — line 778

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 778 | StringLiteral `→ ""` / 537 | TESTED-IDEA | Empties the "skipped, ollama daemon unavailable (availability probe)" reason in the user-visible aggregated failure message. |

**Sketch:** mock `isOllamaAvailable` false, walk an `ollama/x` candidate, assert the
terminal error contains the skip reason.

## G. context-window skip reason — line 784

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 784 | StringLiteral `→ `` ` / 545 | TESTED-IDEA | Empties the "skipped, context window … tokens needed" reason in the user-visible aggregated failure message. |

**Sketch:** candidate whose `getModelContextWindow` returns a tiny window, assert
the terminal error contains `skipped, context window`.

## H. thrown-open catch — lines 798–813

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 798 | LogicalOperator `\|\| → &&` / 550 | TESTED-IDEA | `String(err.message && err)` turns non-Error throws into `"undefined"` and prefixes Error throws with "Error:" — user-visible narration/error text changes (429/transport classification still matches, so no control-flow change). |
| 800 | BooleanLiteral (negation) / 551 | EQUIVALENT | Inverts only which thrown opens get a warnLog line — log text. |
| 800 | ConditionalExpression `→ true` / 552 | EQUIVALENT | Only removes the warnLog guard — log text. |
| 800 | ConditionalExpression `→ false` / 553 | EQUIVALENT | Only silences warnLog — log text. |
| 800 | StringLiteral `→ `` ` / 555 | EQUIVALENT | warnLog template — log text. |
| 812 | ConditionalExpression `→ true` / 559 | TESTED-IDEA | Narrates "provider looks wedged" even when observeProviderFailure did NOT open the breaker — spurious user-visible narration. |
| 812 | ConditionalExpression `→ false` / 560 | TESTED-IDEA | Never narrates the breaker open even when it trips — the user-visible "looks wedged" line disappears. |
| 812 | StringLiteral `'provider_error' → ""` / 561 | TESTED-IDEA | countsAsProviderEvidence returns true for any kind ≠ 'provider_error', so 429/auth open failures become breaker evidence and the breaker opens where it must not. |
| 812 | CallExpression `→ ;` / 562 | TESTED-IDEA | Same missing "looks wedged" narration as 560. |
| 813 | StringLiteral `→ `` ` / 564 | TESTED-IDEA | Empties the user-visible "> [router] Trying next model (ref unavailable: …)" narration line. |

**Sketches:** (550) stub tryStream to reject with a plain string `'bridge exploded'`;
assert the narration contains `unavailable: bridge exploded` (mutant: `undefined`).
(559) one thrown open below the trip threshold → assert NO "looks wedged" line in
the proxy output. (560/562) enough connection-error opens to trip the breaker →
assert the "looks wedged" line IS present. (561) repeat 429-text opens up to the
threshold → original: no wedge narration; mutant: wedge narration + later refs of
that provider skipped with "provider breaker open". (564) single thrown open →
assert the "Trying next model" line.

## I. silent-skip path — lines 817–824

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 817 | CallExpression `→ ;` / 569 | TESTED-IDEA | Skipped attempts never abort their AbortController — if tryStream threw after opening provider work, it keeps running (the exact claude-bridge token-burn bug abandon exists for), and the outer-signal listener leaks per skip. |
| 823 | ConditionalExpression `→ true` / 574 | EQUIVALENT | tryStream's contract routes every null return through `skip()`, which always sets skipReasons — `why` is always defined on this path, the guard is vacuously true. |
| 824 | StringLiteral `'provider_error' → ""` / 578 | EQUIVALENT | Hard/soft classification is identical (skip reasons are never 429-shaped, so isPaidCloudRateLimitFailure is false either way); only the session-error ring-buffer reason label changes — observability. |

**Sketch (569):** stub ctx.tryStream to capture `attempt.options.signal` and then
throw; after the walk assert the captured signal is `aborted` (original abandons,
mutant leaves it live).

## J. served-ref narration — lines 829–830

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 829 | StringLiteral `→ `` ` / 579 | TESTED-IDEA | Empties the label half of the prefix, corrupting the user-visible "> [router] label · ref" line to "> [router] ". |
| 830 | StringLiteral `→ `` ` / 581 | TESTED-IDEA | Removes the user-visible "> [router] <ref>" narration line for the served model entirely. |

**Sketch:** walk with `label: 'code'` succeeding on `mistral/glm`; assert the proxy
received the exact line `> [router] code · mistral/glm`.

## K. success bookkeeping — line 844

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 844 | CallExpression `→ ;` / 589 | TESTED-IDEA | recordOk clears the rate-limit streak, closes the provider breaker (recordProviderSuccess) and clears blocklist streaks; without it a successful model keeps its failure history and later walks skip it / escalate faster. |

**Sketch:** two-turn harness, provider X with refs A and B: turn 1 A throws a
connection-error open (breaker evidence 1), B streams OK; turn 2 A throws again —
original: evidence was reset by B's success, no wedge narration; mutant: evidence
accumulates to the trip threshold, "X looks wedged" narration appears.

## L. blocklist observer gate — line 848

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 848 | LogicalOperator `&& → \|\|` / 596 | TESTED-IDEA | observeFailure is called with `detail === undefined` (classify/streak on undefined text) and for non-provider_error reasons — the learned blocklist accumulates streaks it must not, leading to spurious Tier-2 blocks. |
| 848 | ConditionalExpression `→ true` / 597 | TESTED-IDEA | Feeds every non-ok result (empty responses, rate limits) into the blocklist streaks — same spurious-block direction. |

**Sketch (kills both):** walk where consumeWithDetection returns repeated
`{ ok: false, reason: 'empty_response' }` (no detail) for one ref up to
TIER2_MIN_FAILURES; assert `ctx.cache.model_failure_streaks` (and the blocklist)
stays empty for that ref — original never calls observeFailure on this path.

## M. free-day-cap branch — lines 851–877

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 851 | StringLiteral `'' → "Stryker was here!"` / 607 | EQUIVALENT | Only substitutes the nullish fallback fed to isFreeTierDailyCapText; both strings are non-cap text, same boolean. |
| 854 | StringLiteral `'' → "Stryker was here!"` / 611 | EQUIVALENT | Same nullish fallback inside a routerLog call — log text, same boolean. |
| 856 | StringLiteral `→ ""` / 614 | TESTED-IDEA | Empties the 'rate_limit_exceeded' reason in the user-visible aggregated failure message. |
| 870 | LogicalOperator `?? → &&` / 618 | EQUIVALENT | limitedCount feeds only the routerLog line — log text. |
| 870 | OptionalChaining removed / 619 | TESTED-IDEA | The seam is declared optional; with a ctx that omits limitFreeDayCap (production always provides it, but the interface contract allows omission) the mutant throws TypeError and the turn dies with "Routing failed" instead of the cap narration. |
| 872–873 | StringLiteral `→ `` ` / 621, 622 | EQUIVALENT | routerLog template — log text. |
| 877 | StringLiteral `'' → "Stryker was here!"` / 625 | TESTED-IDEA | When no next ref is attemptable the narration suffix becomes literal garbage text in the user-visible "free-tier daily request cap reached" line. |

**Sketches:** (614) rate-limited candidate → assert the terminal error lists
`ref: rate_limit_exceeded`. (619) free-day-cap 429 body + ctx WITHOUT
limitFreeDayCap → assert the cap narration still renders (mutant: "Routing failed"
terminal error). (625) free-day-cap 429 with all later candidates limited → assert
the narration ends right after the reset message, no suffix (mutant appends
"Stryker was here!").

## N. wait-for-reset gate — lines 895–899

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 895 | ConditionalExpression `→ true` / 628 | EQUIVALENT | With a nullish/non-finite resetAtMs the mutant yields NaN instead of -1 — both fail `resetInMs > 0`, so the wait branch is never taken either way. |
| 895 | LogicalOperator `&& → \|\|` / 630 | EQUIVALENT | Truthy-but-non-finite resetAtMs yields Infinity or NaN instead of -1 — both fail the `> 0 && <= waitMaxMs` gate. |
| 898 | ConditionalExpression `→ true` / 638 | EQUIVALENT | `waitMaxMs > 0` is mathematically implied by `resetInMs > 0 && resetInMs <= waitMaxMs`, so forcing it true changes nothing. |
| 898 | ConditionalExpression `→ true` / 640 | TESTED-IDEA | Kills the once-per-walk livelock guard: a second near-reset rate limit later in the SAME walk would wait again. |
| 898 | EqualityOperator `> → >=` / 641 | EQUIVALENT | With waitMaxMs = 0 the gate still requires `resetInMs > 0 && resetInMs <= 0`, a contradiction — no wait either way. |
| 899 | EqualityOperator `> → >=` / 645 | TESTED-IDEA | Boundary: resetAtMs exactly `now` (reset already passed) makes the mutant wait 2s and retry a model whose window has elapsed, instead of cascading. |
| 899 | EqualityOperator `<= → <` / 648 | TESTED-IDEA | Boundary: resetInMs exactly equal to waitMaxMs makes the mutant skip the wait the config explicitly allows. |

**Sketches:** (640) two candidates both returning rate_limit_exceeded with small
finite resetAtMs (waitMaxMs large, fake timers for sleepMs) → assert exactly ONE
"waiting … then retrying" narration per walk. (645) resetAtMs = now → assert NO
wait narration and the next candidate is attempted. (648) resetAtMs = now +
waitMaxMs → assert the wait narration IS present. (Matches the tracked
"identity/boundary mutants" TODO cluster from the B3 round.)

---

## Summary

| Verdict | Count | Mutant ids |
|---|---|---|
| TESTED-IDEA | 33 | 478, 479, 481, 498, 500, 501, 502, 503, 522, 523, 524, 525, 527, 537, 545, 550, 559, 560, 561, 562, 564, 569, 579, 581, 589, 596, 597, 614, 619, 625, 640, 645, 648 |
| EQUIVALENT | 22 | 470, 471, 473, 476, 482, 483, 528, 551, 552, 553, 555, 574, 578, 607, 611, 618, 621, 622, 628, 630, 638, 641 |
| REDUNDANT | 0 | — (two §7 candidates noted inline: the `waitMaxMs > 0` conjunct at 898 is mathematically implied by the reset-window conjuncts; the walk-start group sync at 709 is a no-op in reachable states — both owner-call, not blind removals) |
| GONE | 0 | all mutated lines still exist on current main (a69abd3), shifted +1…+5 lines |
| UNSURE | 0 | — |

Notable: (1) the drive-stream-never-rejects test already drives failStream but its
substring-only assertion lets the twin pushStreamError mutants mask each other;
(2) the equivalent wait-gate mutants (628/630/638/641) are neutralized by the gate's
own conjuncts, which is also why the boundary mutants (645/648) are the only real
gaps there; (3) mutant 481 arguably *fixes* a stale router.activeGroup label after
a non-restore model_select — if the owner prefers the clearing semantics, the fix
belongs in event-handlers, not via accepting the mutant.
