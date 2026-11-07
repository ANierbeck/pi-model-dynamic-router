# How much of a "turn" is actually model stream time?

Measurement behind `docs/plans/2026-11-07-turn-latency-tool-time.md` (M3),
step 1. Read 2026-11-08 against the owner's live log
`~/.pi/logs/router.log` (2026-09-27 → 2026-11-07, 20.8 MB, the rotated
`router.log.1` was not needed).

## How it was measured

`router.log` logs every stream attempt twice:

```
2026-11-07T17:57:26.926Z  [diag] tryStream streaming "mistral/deepseek-v4-1-flash-1017" via host runtime
2026-11-07T17:57:28.822Z  [stream] mistral/deepseek-v4-1-flash-1017 finished (stopReason: toolUse, 0 chars)
```

Pairing each `finished` with the most recent `tryStream` of the same ref
(LIFO — a FIFO pairing mispairs whenever a start never finishes, which is
common for aborted streams: it produced 39-day "durations") gives 20 270
paired streams. The gaps between consecutive streams are the time the router
was NOT streaming: tool execution, delegation sub-calls, and the user's own
thinking time between turns.

## Result

| | p50 | p90 | max | sum |
|---|---|---|---|---|
| stream duration | 4.3 s | 17.1 s | 705.6 s | 164 942 s |
| gap between streams | 1.0 s | 12.8 s | — | 232 962 s |

Non-stream share of active time, by gap cap (a cap excludes user idle time
between turns, which is not tool time):

| gaps ≤ | pairs | gap sum | non-stream share |
|---|---|---|---|
| 10 s | 17 004 | 20 976 s | 11.3 % |
| 30 s | 17 923 | 36 095 s | 18.0 % |
| 60 s | 18 204 | 48 060 s | 22.6 % |
| 120 s | 18 553 | 77 566 s | 32.0 % |

587 gaps are longer than 120 s (155 398 s total) — those are overwhelmingly
user idle, not tool time.

## What it means for M3

- The pre-fix sample (`Date.now() - turnStart`) contained **at least ~11 %**
  and plausibly **20–30 %** non-model time on this log, concentrated in
  multi-step turns: the median gap between two streams of the same session is
  1 s, the p90 gap 12.8 s. A turn that runs a `bulk_read` sub-call books the
  whole sub-call on the model that answered.
- The bias is one-directional (latency too high, throughput too low) and it
  lands exactly on the models that do agentic work — the ones the ranking is
  supposed to reward.
- The gap distribution is also why `latMs` = **sum** of the turn's stream
  durations (open decision 1) rather than max: a turn with three model calls
  really did spend three streams' worth of model time, and the sum keeps the
  sample comparable to the wall time the user waited for (minus tools).

## Caveats

- Turn boundaries are not in `router.log`, so "gap" mixes tool time with user
  idle time; the capped shares above are the honest reading, not an exact
  tool-time number.
- Logs from before 2026-09-27 are in the rotated file and were not parsed.
- The pairing assumes one in-flight stream per ref at a time (true for the
  router's serial cascade; concurrent sessions using the same ref would pair
  LIFO, which is the closest available approximation).
