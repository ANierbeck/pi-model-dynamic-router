# Turn latency includes tool and sub-call time (M3)

**Status:** done 2026-11-08 (implemented, PR #126). Approved 2026-11-07
(owner decision, TODO post-merge review 2026-11-04 item M3); plan opened
2026-11-07.

**Problem:** `turn_end` computes `ms = Date.now() - rt.turnStart`
(`src/event-handlers.ts`) — the WHOLE turn duration, including every tool
execution and every delegation sub-call — and feeds it to
`updateMetrics(ref, latMs, …)` as the latency sample
(`src/metrics.ts:761+`, EMA α = 0.3). A turn that runs a 30 s `bulk_read`
sub-call therefore books 30 s+ of latency on the model that merely answered,
and `avg_latency_ms` drifts down the ranking sort. Throughput
(`throughput_tps`, `cache.benchmarks`) is computed from the same turn-level
`durMs`, so it is deflated by the same tool time. The ranking reads
`benchmarks`, so M3 is a ranking defect, not only a cosmetics one.

**Solution:** measure the latency of the STREAM, not the turn. Concretely:

1. Stamp the stream start where the router opens it (the `tryStream` call
   sites in `src/stream-orchestrator.ts`, or one stamp in `recordServedRef`
   per ref per turn) and the stream end where it finishes, in the session's
   turn state (`src/turn-state.ts` — the per-session store from
   `2026-11-07-session-keyed-turn-state.md` already keeps turn state; a
   stream-duration field belongs there).
2. `turn_end` then passes the SUM (or the max — open decision 1) of the
   turn's stream durations as `latMs` to `updateMetrics`, and the stream-only
   duration as `durMs` for the throughput sample, keeping the token basis
   unchanged (`tpsTok` stays input+output, never cacheRead).
3. The whole-turn duration stays logged as its own field (the footer /
   `/router` cost line may keep showing turn wall time) — it is real
   information, just not a per-model latency sample.
4. Sub-call streams (delegation, `bulk_read`) are excluded from the parent
   turn's stream durations (`inSubCall()` guard, same scope as
   `recordServedRef`) — they already do not touch the parent's turn model.

**Open decisions — all decided 2026-11-08:**

1. `latMs` = **sum** of the turn's stream durations (not max). The
   measurement (`docs/research/2026-11-08-turn-latency-stream-share.md`)
   shows multi-step turns dominate the non-model share; the sum keeps the
   sample comparable to the wall time the user waited for.
2. Failed attempts **count** their duration too — the user waited for them,
   and the failover narration already counts the wait. Implemented as one
   timer around the whole `consumeWithDetection` call, so the winning stream
   and every retry inside it are booked once each.
3. **No reset** of existing `avg_latency_ms` / `benchmarks` values (same call
   as TODO C2, owner 2026-11-07): they decay via EMA and the health windows.
   Intervene only if a model ranks oddly after the change.

**Verified against:** `main` `31eb726` (2026-11-07). Checked: the `turn_end`
handler and `ms` at `src/event-handlers.ts:303`, the `updateMetrics` call at
`src/event-handlers.ts:353`, the EMA and placeholder defaults in
`src/metrics.ts` (`updateMetrics`, `getM`), the `limit-glue.ts` pass-through,
and the `tryStream`/`recordServedRef` sites in `src/stream-orchestrator.ts`.
Not checked: how large the tool-time share actually is on the owner's real
sessions (measure in step 1 before deciding open decision 1); whether Pi
reports a per-request duration itself (check the host's `message_end` /
usage payload in the next host alignment round).

**Steps:**

1. ✅ Measured: `docs/research/2026-11-08-turn-latency-stream-share.md`
   (20 270 paired streams; 11–32 % of active time is not stream time).
2. ✅ Red-first test: `test/turn-latency-stream-time.test.ts` (8 tests).
   Red evidence: with the pre-fix handler the two `turn_end` cases book
   ~5000 ms instead of the 37/120 ms stream time; with the four
   `addTurnStreamMs` calls removed the three walk cases fail; without the
   boundary reset the reset case fails; with `ms = streamMs` (no fail-open)
   the fail-open case fails.
3. ✅ Implemented: `TurnState.streamMs`/`streamCount` (per session, reset at
   the turn boundary); the walk books each stream at the four
   `consumeWithDetection` sites in `src/stream-orchestrator.ts` (main attempt,
   post-wait retry, forced half-open probe, cooldown-collapse retry) — NOT in
   the stream proxy: an extra `await` layer there released the local
   concurrency slot one microtask after the stream ended, which
   `test/rate-limit-retry-abort.test.ts` catches (a real ordering change, so
   the measurement lives in the existing `finally` blocks instead).
   `turn_end` uses the sum and falls back to the turn time when nothing was
   measured (fixed-session models). Sub-calls run in their own session scope,
   so they never reach the parent's accumulator.
4. ✅ Decisions 1–3 above.
5. ✅ tsc, lint gate, format gate, full suite, coverage thresholds, build.
