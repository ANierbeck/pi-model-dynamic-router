<!--
Slice-2 triage verdict inventory (driveStream survivors, recheck report
docs/mutation-data/slice2-driveStream.json). Produced 2026-11-05 by four
parallel reading agents against the INSTRUMENTED tree c101b27 (the tree the
recheck instrumented; NOT fde54f8), cross-checked against then-current main.

EMPIRICAL CORRECTIONS (hand-applied mutants + full-suite runs on main @ 9c57cda,
see docs/mutation-triage.md "Slice 2 triage" for the runs):
- probe: no corrections — this file's verdicts stood as written.

Verdict key: TESTED-IDEA = real gap, needs a red-first test (sketch in the row);
EQUIVALENT = behavior-identical, rationale per line; REDUNDANT = dead code,
removal candidate (AGENTS.md §7); "already killed"/"false survivor" claims in
these files were CHECKED — see the corrections above for which held.
-->

# Mutation triage — driveStream probe region (`surv-probe.json`, 86 survivors)

## Method notes

- **Line base:** the mutant lines do **not** match the provided pristine copy (fde54f8, `fb?.candidates?.length` at 1083). They match commit **`5db71f3`** exactly, by content anchors (1123, 1135, 1153, 1180, 1206, 1256). The region's code is identical in fde54f8 (−40) and on current main (≈ +10/+11, plus a `hasTools` arg) — no GONE verdicts. Numbers below are the mutant/base lines.
- **Operand mapping:** where several `CondExpr→true` mutants share a line, ids follow AST operand order (consistent with killed siblings absent here, e.g. tie-comparison mutant 922 at L1161, killed by breaker case 2's `x1Calls===2`). Flagged where inferred.
- **Empirical spot-check:** mutant 974 (`if (result.ok)`→`if (false)`) on a /tmp scratch copy of main: `provider-breaker-orchestration` still passes 5/5. After a successful probe consume the scripted `done` closes the proxy and the later aggregate error event is **dropped** — the stream is identical; the mutation is visible only via recorded state (`recordOk`/`recordStreamFailure`). So the "survived" statuses are credible — genuine gaps, not false survivors.
- **Existing coverage:** breaker cases 1/2/2b (probe target, `probing wedged provider` substring, failed-probe label), cooldown-collapse tests, subcall-scope test. Fallback cascade head, overflow short-circuit and most of the probe lifecycle are untested.

## Cluster 1 — L1123–1127: fallback cascade head

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 1123 | CondExpr→true / 880 | TESTED-IDEA | Body entered when `fb` is null → `fb.candidates` throws → `failStream` "outside the candidate loop" instead of falling through. |
| 1123 | CondExpr→false / 881 | TESTED-IDEA | Cascade never taken; a fallback group with healthy candidates is never tried (case 2 passes either way — the probe then fires one walk earlier, verified by trace). |
| 1123 | OptChain / 882 | TESTED-IDEA | Crashes when `fb.candidates` is undefined; `resolve` returns `{selected, candidates}|null`, so only the null case diverges — same fixture as 880. |
| 1123 | OptChain / 883 | TESTED-IDEA | Crashes when `resolve(fallbackGroup)` returns null (configured-but-empty group) — same fixture as 880. |
| 1123 | Block→`{}` / 884 | TESTED-IDEA | Empties the body incl. the `return` — same divergence as 881. |
| 1124 | StringLit→`` / 886 | TESTED-IDEA | Empties the user-visible "All models in X failed, trying Y…" narration — stream content, assertable (B3 precedent). |
| 1127 | StringLit→`` / 887 | TESTED-IDEA | Cascade label emptied → recursive walk's "A→B · ref" attempt prefix degrades — assertable in the same test (low value). |
| 1127 | LogicalOp→`label && groupName` / 888 | EQUIVALENT | `label` is only ever `undefined` or a non-empty built template — `??` and `&&` agree in both cases. |

## Cluster 2 — L1135–1142: context-overflow short-circuit

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 1135 | LogicalOp &&→\|\| / 891 | TESTED-IDEA | Mixed batch (1 window-skip + 1 other failure) wrongly triggers the compaction error. |
| 1135 | CondExpr→true / 892 | TESTED-IDEA | (operand `allFailed`, inferred) Compaction error on every all-failed walk, e.g. all-rate-limited. |
| 1135 | CondExpr→true / 894 | EQUIVALENT | (operand `skips > 0`, inferred) Subsumed: skips=0 forces allErrors=0 via the strict equality, which makes `allFailed` false. |
| 1135 | CondExpr→true / 897 | TESTED-IDEA | (operand equality, inferred) Mixed batch wrongly triggers compaction. |
| 1135 | EqualOp→`>= 0` / 895 | EQUIVALENT | Differs only at skips=0, where the equality operand forces allErrors=0 → `allFailed` false. |
| 1138 | StringLit→`` / 901 | TESTED-IDEA | Empties the compaction error content pushed to the user stream. |

## Cluster 3 — L1153–1154: `allBehindBreaker` gate

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 1153 | CondExpr→true / 906 | EQUIVALENT | (operands `allFailed`/`length>0`, inferred — both subsumed) `allFailed` false means no candidate pushed an error, yet every breaker-open candidate in this walk always pushes one; `length>0→true` only matters for an empty list where `allFailed` is false anyway. |
| 1153 | CondExpr→true / 908 | EQUIVALENT | Same subsumption; the divergent third operand (`every→true`) was killed by the collapse tests. |
| 1153 | EqualOp→`>= 0` / 909 | EQUIVALENT | Differs only at length===0, where `allFailed` is necessarily false. |
| 1153 | MethodExpr every→some / 911 | TESTED-IDEA | Forced probe fires when only SOME candidates are behind breakers. |
| 1154 | CondExpr→true / 913 | TESTED-IDEA | Same divergence as 911: any one open breaker makes the block set `probeRef` and probe. |

## Cluster 4 — L1161–1169: probe selection + narration

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 1161 | CondExpr→true / 921 | EQUIVALENT | (operand `st.open`, inferred) Subsumed: open=false ⇒ until undefined ⇒ `undefined < soonestUntil` false — same outcome as the short-circuit. |
| 1161 | CondExpr→true / 923 | EQUIVALENT | (operand `st.until !== undefined`, inferred) Subsumed by the `<` comparison (NaN comparisons are false; defined until passes anyway) — defensive guard, removal would need a type-level companion. |
| 1166 | CondExpr→true / 929 | EQUIVALENT | Vacuous: `allBehindBreaker` guarantees a non-empty list and the first loop iteration always sets `probeRef` (finite until < Infinity) — TS null-narrowing only. |
| 1167 | StringLit→`""` / 932 | TESTED-IDEA | `split('')` garbles the provider name in the user-visible probe narration — full-line narration assertion kills it (weak). |
| 1169 | StringLit→`` / 934 | EQUIVALENT | `routerLog` text — observability per open decision 2, not a pinned line. |
| 1169 | ArithOp ×2 / 935, 936 | EQUIVALENT | Expiry arithmetic inside the same `routerLog` template — log text only. |

## Cluster 5 — L1180–1185: probe wait-guard (known B3 "L1107" cluster)

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 1180 | CondExpr→false / 940 | TESTED-IDEA | Never waits for a near reset — the self-poisoning retry the guard prevents. |
| 1180 | LogicalOp &&→\|\| / 941 | TESTED-IDEA | Waits 2 s with a bogus "Waiting 0s" narration when the probe ref is NOT limited. |
| 1180 | CondExpr→true / 942 | TESTED-IDEA | (operand `isLimited`, inferred) Same bogus wait when the ref is not limited. |
| 1180 | CondExpr→true / 944 | EQUIVALENT | (operand `waitMaxMs > 0`, inferred) Subsumed: divergence needs limitSecs()===0 while limited — impossible (`refLimitSecs` = max(0, ceil(…)), ≥1 while limited). |
| 1180 | CondExpr→true / 947 | TESTED-IDEA | (operand boundary, inferred) Waits even for a LONG cooldown — minutes of sleep instead of force-probe. |
| 1180 | EqualOp→`>= 0` / 945 | EQUIVALENT | Same subsumption as 944: waitMaxMs=0 with a limited ref makes `probeSecs*1000 <= 0` false. |
| 1180 | EqualOp→`<= 0` / 946 | TESTED-IDEA | Inverts the gate — the positive wait fixture never waits. |
| 1180 | EqualOp→`<` / 948 | TESTED-IDEA | Boundary `probeSecs*1000 === waitMaxMs`: original waits, mutant force-probes (B3's noted boundary follow-up). |
| 1180 | EqualOp→`>` / 949 | TESTED-IDEA | Waits only for FAR resets — positive fixture never waits. |
| 1180 | ArithOp→`/ 1000` / 950 | TESTED-IDEA | Wait duration collapses to ~2 s — duration assertion. |
| 1180 | Block→`{}` / 951 | TESTED-IDEA | Never waits — positive fixture. |
| 1183 | StringLit→`` / 953 | TESTED-IDEA | Empties the branch-distinctive "Waiting Ns … then probing" narration. |
| 1185 | ArithOp ×2 / 954, 955 | TESTED-IDEA | Wrong sleep duration (can go negative / ms-vs-s) — same duration assertion. |

## Cluster 6 — L1187–1226: probe attempt lifecycle

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 1187 | CallExpr→`;` / 956 | TESTED-IDEA | `recordServedRef` removed — probed ref never becomes curModel/active group/lastDynamicModel. |
| 1189 | Block→`{}` / 957 | TESTED-IDEA | Thrown probe open neither recorded nor labeled (`probeTarget` undefined ≡ null for the falsiness check). |
| 1191 | StringLit→`` / 959 | TESTED-IDEA | Thrown-open probe loses its "probing wedged provider" label in the terminal error. |
| 1192 | StringLit→`""` / 961 | TESTED-IDEA | Records reason `""` — changes cooldown/ring-buffer classification (weak, recorded-state assertion). |
| 1193 | StringLit→`""` / 963 | TESTED-IDEA | Breaker-evidence reason garbled (weak, same fixture). |
| 1196 | BoolLit / 964 | TESTED-IDEA | `!probeTarget`→`probeTarget`: abandons the LIVE probe's controller right after a successful open — signal assertion. |
| 1196 | CondExpr→true / 965 | TESTED-IDEA | Always abandons immediately after tryStream — same signal assertion. |
| 1196 | CondExpr→false / 966 | TESTED-IDEA | Never abandons a failed open — the abort-signal leak the attempt machinery exists for. |
| 1196 | CallExpr→`;` / 967 | TESTED-IDEA | Removes the abandon call — same as 966. |
| 1197 | CondExpr→true / 968 | TESTED-IDEA | Consume block entered with null target → `null.stream` TypeError recorded as a bogus probe error line. |
| 1198 | BoolLit→`true` / 971 | TESTED-IDEA | Failed probe never abandoned — signal assertion. |
| 1206 | CondExpr→false / 974 | TESTED-IDEA | Probe success not returned: `recordOk` skipped (breaker stays open) + bogus `'undefined'` failure recorded — stream identical (post-done error dropped, verified empirically), assert via a second request. |
| 1206 | Block→`{}` / 975 | TESTED-IDEA | Same as 974, same test. |
| 1207 | BoolLit→`false` / 976 | TESTED-IDEA | Finished probe's controller aborted post-hoc — signal assertion (weak). |
| 1208 | CallExpr→`;` / 977 | TESTED-IDEA | `recordOk` removed — breaker not closed, cooldown not cleared; second-request fixture. |
| 1211 | CondExpr→false / 979 | TESTED-IDEA | Aborted probe (user cancel) recorded as a failure — abort-mid-probe fixture. |
| 1211 | StringLit→`""` / 981 | TESTED-IDEA | Aborted branch never matches — same fixture. |
| 1212 | 982, 983, 984, 985, 986, 987, 988 (CondExpr ×3, LogicalOp, EqualOp, StringLit, CallExpr) | TESTED-IDEA | All seven skew the `observeFailure` blocklist-observer gate (wrong reasons/details counted or none) — one fixture: probe consume fails with provider_error + detail, assert the blocklist streak/evidence. |
| 1216 | CallExpr→`;` / 991 | TESTED-IDEA | Probe consume-failure not recorded — no cooldown / session-error entry ("⚠N err == N events" contract). |
| 1217 | CallExpr→`;` / 992 | TESTED-IDEA | Probe failure not fed as breaker evidence — same recorded-state fixture. |
| 1218 | Block→`{}` / 993 | TESTED-IDEA | Thrown consume error swallowed silently (caveat: harness must make consumeWithDetection throw — a mid-iteration throwing mock stream should). |
| 1220 | StringLit→`` / 995 | TESTED-IDEA | Thrown-consume probe loses its terminal-error label — same throwing fixture. |
| 1221 | CallExpr→`;` / 996 | TESTED-IDEA | Blocklist observer misses the thrown failure — same family as 982-988. |
| 1222 | StringLit→`""` / 998 | TESTED-IDEA | Recorded reason garbled (weak). |
| 1223 | StringLit→`""` / 1000 | TESTED-IDEA | Breaker-evidence reason garbled (weak). |
| 1224 | Block→`{}` / 1001 | TESTED-IDEA | Finally emptied: no abandon-on-failure, no `releaseLocalSlot`. |
| 1225 | 1002, 1003, 1004, 1005 (BoolLit, CondExpr ×2, CallExpr) | TESTED-IDEA | Skew the final abandon (abandon-on-success / never-on-failure / removed) — same signal assertions. |
| 1226 | CallExpr→`;` / 1006 | TESTED-IDEA | Local concurrency slot never released — ollama breaker-dead-end fixture (weak). |

## Cluster 7 — L1256–1257: cooldown-collapse head

| line | mutator / id | verdict | rationale |
|---|---|---|---|
| 1256 | CondExpr→true / 1007 | TESTED-IDEA | (operand `allFailed`, inferred) The no-pushError paths (free-day-cap skip, wait-retry silent null) end with allErrors EMPTY and all limited — original ends silently, mutant force-retries via the collapse. |
| 1256 | LogicalOp &&→\|\| / 1009 | TESTED-IDEA | After a FAILED forced probe (all behind breaker AND all limited) the mutant runs the cooldown collapse instead of the terminal error. |
| 1256 | CondExpr→true / 1010 | TESTED-IDEA | (operand `!allBehindBreaker`, inferred) Same post-failed-probe divergence as 1009. |
| 1256 | LogicalOp &&→\|\| / 1011 | TESTED-IDEA | Collapse fires when NOT all limited — retries an unlimited ref (limitSecs 0 wins the "shortest" pick). |
| 1256 | MethodExpr every→some / 1013 | TESTED-IDEA | Collapse fires when only SOME limited — retries an unlimited ref instead of the terminal error. |
| 1257 | CondExpr→true / 1015 | TESTED-IDEA | (operand `allInCooldownNow`, inferred) Collapse fires without the all-limited precondition — same mixed fixture as 1013. |
| 1257 | LogicalOp &&→\|\| / 1017 | TESTED-IDEA | `allInCooldownNow \|\| length>0` true whenever candidates exist — same mixed fixture. |
| 1257 | CondExpr→true / 1018 | EQUIVALENT | (operand `length>0`, inferred) Diverges only at length===0, where `allInCooldownNow` is necessarily false. |
| 1257 | EqualOp→`>= 0` / 1019 | EQUIVALENT | Same subsumption as 1018. |

## Test sketches (red-first, groupStream harness à la `provider-breaker-orchestration.test.ts`)

1. **Fallback cascade (880-884, 886, 887):** group A (`fallback_groups: ['B']`) fails via `errorStream`; B healthy. Assert B's answer, narration `All models in A failed, trying B…`, prefix `A→B · <ref>`. Variant (880/882/883): B resolves to null/empty → assert the plain `candidate(s) failed` error, not a `failStream` "outside the candidate loop" error.
2. **Overflow short-circuit (891, 892, 897, 901):** all stubs `contextWindow: 10` → all window-skipped → assert error content `exceeds every available model's context window` + `prompt is too long: …`. Mixed variant (891/897): one window-skip + one plain-400 → NO compaction error.
3. **Mixed breaker gate (911, 913):** wedge-provider trips via empties; spare y-1 fails with a non-tripping 400. Assert x-1 attempted exactly once, no `probing wedged provider` narration, terminal `All 4 candidate(s) failed`.
4. **Probe wait-guard (940-955):** all behind breaker AND probe ref limited with near reset, `rate_limit_wait_max_ms` > 0 → assert the `Waiting Ns …` narration and that the probe's tryStream runs after `sleepMs` (fake timers; duration `probeSecs*1000+2000`). Negative (941/942): ref not limited → no waiting narration. Boundary (948): `probeSecs*1000 === waitMaxMs` → waiting fires. Long reset (947/949): force-probe narration, no wait.
5. **Probe lifecycle (956-1006):** (a) recorded state — after a probe-success turn a SECOND `groupStream` must attempt the provider normally (breaker closed by `recordOk`; 974/975/977/956 leave it open or cooldown-armed); after a failed probe exactly one new session-error entry with the right reason (991, 992, 961, 963) and the blocklist streak counted (982-988, 996). (b) abort signals — capture `options.signal` in the `streamSimple` mock: aborted when the probe open throws/returns null (957, 966, 967, 1001-1005), not aborted during/after a successful probe (964, 965, 971, 976). (c) thrown paths — probe stream throws on open (957/959) and mid-iteration (993/995) → failure recorded and labeled. (d) aborted probe (979/981): abort the caller's signal mid-consume → no failure recorded. (e) probeTarget null (968): silent skip → no bogus `Cannot read` line.
6. **Collapse head (1007, 1009-1013, 1015, 1017):** x-1 limited (429 with reset), y-1 plain-400 failure, no breaker → assert terminal `All 2 candidate(s) failed`, NO `All models in cooldown` narration. Post-failed-probe variant (1009/1010): all-behind-breaker + all limited + probe fails → terminal error, no second collapse retry. FreeDayCap variant (1007): one `:free` candidate with a daily-cap 429 body → NO error event at all.

## Summary

| verdict | count |
|---|---|
| TESTED-IDEA (real gap) | 70 |
| EQUIVALENT | 16 (888, 894, 895, 906, 908, 909, 921, 923, 929, 934, 935, 936, 944, 945, 1018, 1019) |
| REDUNDANT | 0 |
| GONE | 0 |
| UNSURE | 0 standalone — 993 carries an in-row caveat (harness throwability); the id→operand mappings marked "inferred" (AST order) are 892/894/897, 906/908, 942/944/947, 1007/1010, 1015/1018 |

The 16 EQUIVALENTs are log-text (4), subsumed defensive operands (11), one vacuous null-guard (929). The 70 gaps concentrate in six sketches; highest-value: the fallback-cascade fixture (nothing today proves a fallback group ever answers), the probe recorded-state assertions (the stream alone cannot see 974/975), and the wait-guard cluster already tracked as B3's next slice.
