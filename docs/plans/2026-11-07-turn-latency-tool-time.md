# Turn latency includes tool and sub-call time (M3)

**Status:** approved 2026-11-07 (owner decision, TODO post-merge review
2026-11-04 item M3) — not started. Plan opened 2026-11-07.

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

**Open decisions:**

1. `latMs` = sum of the turn's stream durations, or max? Proposal: **sum** —
   a turn with three model calls really took that long, and the turn is the
   unit the user waits for; max would hide multi-call turns. To be decided
   against the first measurement (step 3 of the steps).
2. Streams that fail (soft failure, retry) — do they contribute their partial
   duration? Proposal: yes for the winning stream only, plus the failed
   attempts' durations, because the user waited for them too (the failover
   narration already counts the wait). Fail-closed alternative: winning
   stream only.
3. Migration of existing `avg_latency_ms` / `benchmarks` values (written with
   turn-level durations): the values decay via EMA and `samples` counters;
   proposal is NO reset (same call as TODO C2, owner 2026-11-07), unless a
   model ranks oddly after the change.

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

1. Measure on real session logs: share of turn duration that is tool/sub-call
   time (parse `router.log` try/finished lines per turn).
2. Red-first test: a turn with a slow tool step must not book the tool time
   as model latency (drive a fake slow tool through the harness, assert the
   `updateMetrics` input).
3. Implement stream-duration stamping (per session, sub-call excluded) and
   feed `updateMetrics`.
4. Decide open decisions 1–3 against the measurement; adjust if needed.
5. Full suite + tsc + lint gate + format gate; review round before merge.
