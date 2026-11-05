<!--
Slice-2 triage verdict inventory (driveStream survivors, recheck report
docs/mutation-data/slice2-driveStream.json). Produced 2026-11-05 by four
parallel reading agents against the INSTRUMENTED tree c101b27 (the tree the
recheck instrumented; NOT fde54f8), cross-checked against then-current main.

EMPIRICAL CORRECTIONS (hand-applied mutants + full-suite runs on main @ 9c57cda,
see docs/mutation-triage.md "Slice 2 triage" for the runs):
- collapse: mutant 1034 'ALREADY COVERED (stale)' CONFIRMED: killed by the full suite on current main (18 failures, timeout-based). Mutants 1059/1060/1061 (unconfirmed) RESOLVED: 1059 (if(true) abandon) is a real gap — it survives the full suite because mock streams do not honor abort signals; a kill needs a signal-respecting fixture. 1060/1061 are EQUIVALENT (defensive cleanup; target null means no stream was ever opened). Mutants 1137-1141 (UNSURE catch block) are resolved EQUIVALENT-defensive: consumeWithDetection never throws by contract (test/drive-stream-never-rejects.test.ts); the catch stays as the never-rejects guard, no §7 removal.

Verdict key: TESTED-IDEA = real gap, needs a red-first test (sketch in the row);
EQUIVALENT = behavior-identical, rationale per line; REDUNDANT = dead code,
removal candidate (AGENTS.md §7); "already killed"/"false survivor" claims in
these files were CHECKED — see the corrections above for which held.
-->

# Mutation triage — driveStream total-cooldown-collapse (src/stream-orchestrator.ts)

69 survivors, report lines 1262–1375.

**Line numbers (verified):** the `line` fields match commit **5db71f3**, not the provided fde54f8 pristine copy (guard at 1276; verified on 40+ lines). The region is semantically identical in fde54f8, 5db71f3 and current main (a69abd3, guard at 1287; drift = lint refactor above). Tables give report line → pristine-fde54f8 line.

**Provenance caveat:** an empirical spot-check (mutated copy in /tmp, repo untouched) showed mutant **1034** is *killed* by the current suite (single-pass test times out under it) — its `survived` verdict is **stale** carry-over. All other survivors were checked by reading; only 1034 was confirmed covered.

## A — shortest-cooldown pick (1262→1223, 1264→1225)

| Mutant | Verdict | Rationale |
|---|---|---|
| 1025 `secs <= bestSecs` | TESTED-IDEA | Tied cooldowns: retries the LAST tied candidate instead of the first. |
| 1028 `if (bestRef)`→true | EQUIVALENT | `refLimitSecs` (rate-limit.ts:33) is always finite, so the first candidate always sets bestRef; invariant-true when reached (candidates.length > 0 checked at entry). |

**Sketch (1025):** PR#61-style two-model fixture, both fail once with the same reset-free rate-limit error (identical backoff tier); assert `mock.calls[2]` is the FIRST candidate / the narration names it.

## B — wait-vs-force guard (1276→1237)

| Mutant | Verdict | Rationale |
|---|---|---|
| 1033 `&&`→`\|\|` | TESTED-IDEA | With cap enabled and cooldown > cap the mutant WAITS (unbounded sleep) instead of force-retrying. |
| 1034 guard→true | **ALREADY COVERED (stale)** | Empirically RED on main: single-pass test (wait_max 0) asserts `, retrying` and times out under the mutant. Not a gap. |
| 1035 `waitMaxMs >= 0` | EQUIVALENT | Differs only if `waitMaxMs===0 && bestSecs*1000<=0`; bestSecs ≥ 1 whenever limited (limitSecs ≥ 1 for unexpired cooldowns), so the second conjunct is false either way. |
| 1037 2nd conjunct→true | TESTED-IDEA | Same scenario as 1033: cap enabled + long cooldown → waits instead of force-retry. |
| 1038 `<=`→`<` | TESTED-IDEA | Boundary `bestSecs*1000 == waitMaxMs` flips wait→force (the known "identity/boundary" gap). |
| 1040 `*`→`/` | TESTED-IDEA | `bestSecs/1000 <= waitMaxMs` ~always true → mutant waits whenever the cap is enabled. |

**Sketch (1033/1037/1040 + boundary 1038):** (a) `rate_limit_wait_max_ms: 3000`, `backoff_minutes: [1]` → assert `, retrying` present, `— waiting` absent, no long sleep; (b) `soft_backoff_ms: [2000]`, `rate_limit_wait_max_ms: 2000` → assert `— waiting`. No current test combines an enabled cap with a cooldown longer than the cap (force-retry tests set the cap to 0; PR#61 tests use short cooldowns).

## C — banner routerLog text (1278→1239, 1287→1248)

| Mutant | Verdict | Rationale |
|---|---|---|
| 1043 wait routerLog→`''` | EQUIVALENT | routerLog text is observability (plan open decision 2); the pushRouterInfoLogged twins are already branch-distinctively asserted (PR#61 test). |
| 1050 force-retry routerLog→`''` | EQUIVALENT | Same: the narration twin is asserted; this is the routerLog copy. |

## D — wait duration (1284→1245)

| Mutant | Verdict | Rationale |
|---|---|---|
| 1046 `+2000`→`-2000` | TESTED-IDEA | Sleeps 2 s less than the cooldown — only a duration assertion catches it. |
| 1047 `*1000`→`/1000` | TESTED-IDEA | Sleep degenerates to ~2 s regardless of cooldown. |

**Sketch:** wait-branch fixture, `soft_backoff_ms: [5000]`, `rate_limit_wait_max_ms: 6000`; assert elapsed ≥ 6 s (original ~7 s; mutants ~3 s / ~2 s).

## E — tryStream catch (1298→1261)

| Mutant | Verdict | Rationale |
|---|---|---|
| 1055 pushError removed | TESTED-IDEA | A retried model whose tryStream THROWS is missing from the aggregate `• ref: msg` list. |

**Sketch:** PR#61 fixture whose retry script throws; assert `errText` contains the retried ref's message in the failure block.

## F — `if (!target) collapseAttempt.abandon()` (1302→1265)

| Mutant | Verdict | Rationale |
|---|---|---|
| 1058 `!target`→`target` | TESTED-IDEA | Aborts the live attempt right after a successful tryStream — attempt signal aborted before consumption. |
| 1059 →true (unconfirmed) | TESTED-IDEA | Abandons even when target exists — same signal-aborted observable. |
| 1060 →false (unconfirmed) | EQUIVALENT | target null ⟺ tryStream threw/skipped ⟹ no live stream; abandon would only abort an unused controller and drop a per-turn listener — no public-API observable. |
| 1061 call removed (unconfirmed) | EQUIVALENT | Same as 1060: defensive cleanup with no stream ever opened. |

**Sketch (1058/1059 + success side of 1143/1144/1070):** signal-capturing mock — `streamSimple(model, ctx, options)` records `options.signal` (forwarded, stream-proxy.ts:76); after successful recovery assert `signal.aborted === false`.

## G — success path / collapseSucceeded (1304→1267, 1312-1314→1275-1277)

| Mutant | Verdict | Rationale |
|---|---|---|
| 1065 init→true | TESTED-IDEA | Failure path never abandons the discarded retry stream — still-live generator left running (the token-burn incident openCandidateAttempt's doc describes). |
| 1068 `if (result.ok)`→false | TESTED-IDEA | Successful recovery falls through to `pushError(bestRef, 'undefined')` and a bogus aggregate failure event after a good answer. |
| 1069 ok-block `{}` | TESTED-IDEA | Same as 1068: no recordOk, no return. |
| 1070 `= true`→`false` | TESTED-IDEA | Success path abandons the winner — kills a successful toolUse turn's SDK query (openCandidateAttempt doc); plain-text success is unobservable (stream drained). |
| 1071 recordOk removed | TESTED-IDEA | Model stays limited (cooldown/breaker/blocklist uncleared) after a successful retry. |

**Sketches:** (a) 1068/1069 — single-pass fixture, assert NO `candidate(s) failed` error after `recovered after 2 calls`; (b) 1065 + failure side of 1143/1145/1146 — PR#61 repetition fixture whose retry generator stays suspended after detection (yields repetition content, then more events) with a try/finally flag; assert the flag ran; (c) 1070 — Cluster F signal assertion, strongest with a toolUse-shaped success script; (d) 1071 — single-pass fixture then a SECOND groupStream call: original attempts live (no `All models in cooldown`), mutant collapses again.

## H — aborted return (1317→1280)

| Mutant | Verdict | Rationale |
|---|---|---|
| 1073 →false | TESTED-IDEA | Abort during the collapse retry becomes a model failure: cooldown armed + aggregate error pushed after the abort. |
| 1075 `'aborted'`→`''` | TESTED-IDEA | Never matches — same fall-through as 1073. |

**Sketch:** retry script yields an abort-shaped terminal (consumeWithDetection reports `reason: 'aborted'`); assert no `candidate(s) failed` event and a second call attempts the ref live.

## I — observeFailure guard (1318→1281)

| Mutant | Verdict | Rationale |
|---|---|---|
| 1077 →false | TESTED-IDEA | Provider-error detail no longer feeds the learned blocklist (ADR-0008 Tier 1). |
| 1078 `&&`→`\|\|` | TESTED-IDEA | Observes with undefined text on provider_error without detail, and on other reasons with detail. |
| 1079 →true | TESTED-IDEA | Observes on every failure with detail (e.g. repetition detail). |
| 1080 `===`→`!==` | TESTED-IDEA | Observes on every NON-provider_error failure with detail. |
| 1081 `'provider_error'`→`''` | TESTED-IDEA | Never matches — no observation. |
| 1082 call removed | TESTED-IDEA | No observation. |

**Sketch (all six):** (pos) retry yields provider error with detail → assert the parked router-cache blocklist observation for the ref (note: saveCache fires only when recordBlocklistFailure returns an entry — may need threshold repetition or in-memory read); (neg) PR#61 repetition retry → assert NO new provider-error observation.

## J — context_overflow on the collapse retry (1320-1327→1283-1290)

| Mutant | Verdict | Rationale |
|---|---|---|
| 1085 →false | TESTED-IDEA | Overflow on the retried model misroutes to the repetition/else branches. |
| 1087 `'context_overflow'`→`''` | TESTED-IDEA | Guard never matches — same misrouting. |
| 1088 block `{}` | TESTED-IDEA | recordStreamFailure + compaction pushStreamError skipped. |
| 1090 reason label→`''` | TESTED-IDEA | Recorded reason `''` changes the session-error record (weakest; state assertion). |
| 1092/1093/1094 strings→`''` | TESTED-IDEA | The compaction error event's title/detail vanish from the stream error. |

**Sketch:** PR#61 fixture whose retry script returns the overflow-shaped error from overflow-try-larger.test.ts; assert `streamErrorText` contains `rejected the prompt as too large for its context window — triggering compaction` (1085/1087/1088/1092), the exact detail (1093/1094), and the recorded `context_overflow` reason in parked state (1090).

## K — repetition/truncation record (1333→1296)

| Mutant | Verdict | Rationale |
|---|---|---|
| 1105 recordStreamFailure removed | TESTED-IDEA | Retried model's repetition/truncation failure unrecorded: no cooldown bump, no learned/session-error entry (PR#61 asserts only the narration, which precedes this call's effects). |

**Sketch:** PR#61 repetition fixture + assert parked session-error/cache entry for the retried ref (or a second call shows the stepped-up cooldown).

## L — hardLimited label ternary chain (1342-1347→1305-1311)

| Mutant | Verdict | Rationale |
|---|---|---|
| 1119 1st ternary→false | TESTED-IDEA | rate_limit_exceeded retries print the wrong tier's label. |
| 1121 `'rate_limit_exceeded'`→`''` | TESTED-IDEA | First tier never matches. |
| 1122 label→`''` | TESTED-IDEA | Label text vanishes from the narration. |
| 1124 2nd ternary→false | TESTED-IDEA | stall_timeout retries print the wrong label. |
| 1126 `'stall_timeout'`→`''` | TESTED-IDEA | Second tier never matches. |
| 1127 label→`''` | TESTED-IDEA | Stall label vanishes. |
| 1128 3rd ternary→true | TESTED-IDEA | 4th-tier hard-limited failures get the provider-error label instead of emptyResponseLabel. |
| 1134 label→`'Stryker was here!'` | TESTED-IDEA | Provider-error label replaced. |

**Sketch:** three narration fixtures asserting exact labels: (a) rate-limit retry → `rate limit/spend limit reached` (the existing PR#61 rate-limit test already drives this path, it just doesn't assert the label); (b) stall retry (content then silence past short `stall_timeout_ms`) → `stream stalled (likely rate limit)`; (c) provider_error-with-detail retry → `provider error: <detail> (likely rate limit)`; 1128 needs a hard-limited 4th-tier retry (paid-cloud 422-style, as in consolidated-stream-error-pins) asserting emptyResponseLabel's text.

## M — consumeWithDetection catch (1353-1357→1316-1320)

| Mutant | Verdict | Rationale |
|---|---|---|
| 1137 catch `{}` | UNSURE | consumeWithDetection swallows its documented throw sources internally (`streamThrew`, PR #79 review); no readable path makes it throw. If truly unreachable → REDUNDANT per §7, but it guards driveStream's never-rejects contract — owner decision. |
| 1138 pushError removed | UNSURE | Same reachability caveat; if reachable, missing aggregate `• ref: msg` line is observable. |
| 1139 observeFailure removed | UNSURE | Same caveat; if reachable, missing blocklist observation as in Cluster I. |
| 1141 `'provider_error'`→`''` | UNSURE | Same caveat; if reachable, changed reason alters recordStreamFailure classification/session-error record. |

## N — finally: abandon + slot release (1358-1362→1321-1325)

| Mutant | Verdict | Rationale |
|---|---|---|
| 1142 finally `{}` | TESTED-IDEA | Removes BOTH failure-path abandon and local-slot release. |
| 1143 `!collapseSucceeded`→`collapseSucceeded` | TESTED-IDEA | Inverted: abandons the winner on success, keeps the discarded stream alive on failure. |
| 1144 →true | TESTED-IDEA | Abandons even on success — kills the winning attempt's signal. |
| 1145 →false | TESTED-IDEA | Failure path never abandons the still-live discarded stream. |
| 1146 abandon removed | TESTED-IDEA | Same as 1145. |
| 1147 releaseLocalSlot removed | TESTED-IDEA | Local slot leaks (releaseLocalSlot, index.ts:666, only decrements ollama/lm-studio refs). |

**Sketches:** signal-capture (F) + generator-flag (G) kill 1142-1146; slot leak: `ollama/*` bestRef fixture (scripted local model rate-limited, collapse retries it) with `ollama_max_concurrent_streams: 1` — a second groupStream call must not be skipped with `local_concurrency_limit` (kills 1142/1147).

## O — final aggregate block (1369-1375→1332-1338)

| Mutant | Verdict | Rationale |
|---|---|---|
| 1148 →true | EQUIVALENT | Empty allErrors here requires an empty candidate list; `resolve()` guarantees non-empty (groupStream throws `No available models` on null) and every loop path pushErrors or returns — defensive guard, same outcome in reachable states. |
| 1150 `>`→`>=` | EQUIVALENT | `allErrors.length >= 0` ≡ `> 0` in the same reachable states. |
| 1155 join `'\n'`→`''` | TESTED-IDEA | The `• ref: msg` bullet list collapses — error event content changes. |
| 1156 `some`→`every` | TESTED-IDEA | Mixed lists (one overflow, one not) lose the overflow hint. |
| 1157 arrow→`() => undefined` | TESTED-IDEA | `some(undefined)` always false — hint never appended. |
| 1158 →false | TESTED-IDEA | Hint never appended. |
| 1159 →true | TESTED-IDEA | Hint appended even without overflow. |
| 1160 `\|\|`→`&&` | TESTED-IDEA | Messages matching only one overflow matcher lose the hint. |
| 1161 hint text→`''` | TESTED-IDEA | Hint text vanishes. |
| 1162 else→`'Stryker was here!'` | TESTED-IDEA | Every non-overflow aggregate gains garbage text. |
| 1165 errorLog→`''` | EQUIVALENT | errorLog text is observability; the pushStreamError twin is the behavior. |
| 1166 `??`→`&&` | EQUIVALENT | Only changes the errorLog'd group-name string. |
| 1168 errorLog→`'""'` | EQUIVALENT | errorLog template text — observability. |

**Sketch (1155-1162):** (pos) cascade where one candidate fails with an overflow-shaped error (delta-matcher-only variant for 1160) → assert errText contains `(Detected overflow in stream — Pi should compact and retry.)`; (neg) PR#61 errText → assert the hint is absent and the exact `All 2 candidate(s) failed:\n  • lim-provider/lim-model: …` bullet shape (kills 1155/1159/1162).

## Summary

| Verdict | Count | Mutants |
|---|---|---|
| TESTED-IDEA (real gap) | 53 | 1025, 1033, 1037, 1038, 1040, 1046, 1047, 1055, 1058, 1059, 1065, 1068-1071, 1073, 1075, 1077-1082, 1085, 1087, 1088, 1090, 1092-1094, 1105, 1119, 1121, 1122, 1124, 1126-1128, 1134, 1142-1147, 1155-1162 |
| ALREADY COVERED (stale survivor) | 1 | 1034 (verified RED empirically) |
| EQUIVALENT | 11 | 1028, 1035, 1043, 1050, 1060, 1061, 1148, 1150, 1165, 1166, 1168 |
| UNSURE (defensive catch, likely unreachable) | 4 | 1137, 1138, 1139, 1141 |
| REDUNDANT / GONE | 0 | — |

The 53 TESTED-IDEA mutants collapse into ~10 fixtures (force-retry/boundary guard, duration, tie-break, throw-retry, signal-capture, no-error-after-recovery, abort, observeFailure pos/neg, overflow-retry, three label narrations, slot leak, aggregate pos/neg) — consistent with the B3 strategy of orchestration-surface harness tests over mutant-by-mutant tests. Follow-ups: recheck 1034's carry-over verdict; owner decision on the Cluster M catch (unreachability vs never-rejects defense).
