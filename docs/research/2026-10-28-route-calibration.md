# Route-pool calibration from router.log — 2026-10-28

Question (route 1 of the pool replay, `docs/research/2026-10-27-pool-replay.md`):
can router.log's `[routing] group=…` lines serve as the decision-time candidate
pool for replaying past decisions?

## Setup

- New module `scripts/route-pool-log.ts` (parser + pool-in-effect lookup) and
  `--calibrate` driver in `scripts/pool-replay.ts`, tested in
  `test/route-pool-log.test.ts` (9 tests) and `test/turn-decision-join.test.ts`
  (+2: the join now carries `decisionTs` and `proc` per matched turn).
- Turn↔decision join exactly as in `docs/research/2026-10-27-turn-decision-join.md`:
  since 2026-10-15, until 2026-10-27T16:00Z, 101 matched turns.

## Key discovery: routing lines are change logs, not per-decision lines

`formatGroupDecision` is emitted via `debugLogOnce(key, msg)`: a line is written
only when the group's pool *changes* (`src/logger.ts:222`, `src/routing.ts:1193`).
The first matching attempt (line in a window after the turn) found a line for
only 18/101 turns and agreed with the served model in 7/18 — the window was
wrong, not the pool.

Correct lookup: **the latest routing line of the same group and process at or
before the decision time** is the pool in effect (dedupe is per process and
group). Implemented as `firstChoiceAsOf`; calibration then has a pool state for
100/101 turns.

## Calibration result (first pool candidate vs. served model)

`--calibrate` over the 101 matched turns (continue turns excluded): agree
**51/100**, 1 turn without a pool line. The per-rank diagnostic runs over all
106 matched turns including continue (it does not apply the category filter),
so its buckets add up to 106:

## Why the first candidate is not always served: failover

The router opens one stream per candidate in ranked order
(`src/stream-orchestrator.ts:696`); every attempt is logged as
`[diag] tryStream streaming "<ref>"`. The attempt sequence in the 60 s after
the decision, for the 50 turns whose pool first candidate ≠ served model
(49 disagreeing + 1 without pool state; one diagnostic counted `lastAttempt`
for all of them):

- the **first attempt** is the pool's first candidate in 38 of the 49 turns
  with a pool (the router tries the pool's head first),
- the **last attempt** is the served model in all 49 disagreeing turns — the
  walk ended on the model that served the turn,
- i.e. the pool as a *set* is correct (served model ∈ pool in all but 2 of
  106 turns), but the served model is often rank 2–10 because earlier
  candidates failed or were limited at open time.

Caveat: the 60 s attempt window can bleed into the next turn's attempts (3
turns show pool first = served but a later attempt = other model). Bounding
the walk by the turn instead of by time is still open.

So route 1 can reproduce *candidate pools* at decision time, but **not the
first choice** without also modeling the failover walk (attempt lines are
available per process and timestamp, but the 60 s window can bleed into the
next turn's attempts; the walk must be bounded by the turn, not by time).

## Consequences

1. Pool lines from router.log are a valid decision-time pool source (route 1
   for the past), with the *latest-line-before-decision* lookup.
2. A layout replay must compare **group membership and pool contents**, not
   "would the same model have been picked" — the pick depends on the failover
   walk, which is not yet modeled.
3. Route 2 (writing a per-decision pool record into the decision log) would
   remove both the lookup guesswork and the failover ambiguity for the future.

## Route 2 implemented (same day, follow-up commit)

The owner picked "pool with metrics" for the future source. Implemented:
`Router.resolveGroup` attaches the ranked pool (`GroupResolution.pool`: group,
method, candidates with gdp/cost/score/flags), and the resolve glue
(`src/model-resolve-glue.ts`, wired in `index.ts`) appends one `stage: 'pool'`
record to `~/.pi/logs/classifier-decisions.jsonl` per group resolution that
drives a stream — right after the turn's decision record, same `proc`.
No prompt text, no `input` field; `readDecisions` skips records without
`input.sha`, so the join is unaffected. Off unless the classifier log is
enabled; fail-open.

Correlation for future joins: `proc` + group + timestamp order. The failover
walk (which attempt served) stays in router.log until separately modeled.

## Open

- 1 turn with no pool line (process/tag mismatch or log rotation boundary) —
  not investigated.
- The failover walk bounding per turn (needed before any "first choice" replay
  claim) — not implemented.
- The join does not yet consume 'pool' records (they only start accumulating
  from this commit on).
