# Failover walk — baseline on the old 13-group layout

Status: measurement, 2026-10-28/29. Baseline for the old layout only; the
five-group layout is measured separately once its first sessions have run.
Numbers and model refs only; no prompt text.

Reproduce: `npx tsx scripts/failover-walk.ts --since=2026-10-15T00:00:00Z --until=2026-10-28T16:20:00Z`
(tool: `scripts/failover-walk.ts`, tests `test/failover-walk.test.ts`, 11 green).

## Bounds

- **From 2026-10-15**: the start the earlier join analysis used
  (`2026-10-28-unmatched-turns.md`). Completeness of the decision log was not
  re-checked for earlier days.
- **Until 2026-10-28 16:20 UTC**: first moment of the five-group code in this
  checkout. The earliest `code_complex` / `design` decisions are 19:29 UTC.
- `router.log` is complete from 2026-09-27; older rotated logs are not used.

## Method

- A decision is a routed record of `classifier-decisions.jsonl` with a group
  (comparator, pool and hint-without-group records are not routed).
- The walk of a decision is the list of `tryStream streaming "<ref>"` events of
  the same process from the decision until the first `[stream] <ref> finished`.
  The window ends at the next decision of the process or ten minutes later.
- `firstAttempt` = the first stream attempt — the observed first choice. This
  is the measure used below.
- The pool line (`[routing] group=…`) gives the candidate list only when a pool
  was recomputed. It is missing for 51 of 92 `operational` turns, so it is kept
  as a cross-check (`erstwahl`, `erstwahlSource: turn | earlier`, the latter up
  to 30 min old) and not used for the headline numbers.

## Result (291 routed turns)

| group | turns | success | first attempt served | first attempt failed | attempts avg / max |
|---|---:|---:|---:|---:|---|
| operational | 92 | 92 | 15 | 77 | 2.90 / 9 |
| tactical | 104 | 104 | 103 | 1 | 1.01 / 2 |
| planning | 59 | 58 | 55 | 4 | 1.14 / 5 |
| scout | 29 | 17 | 3 | 26 | 4.55 / 8 |
| simple | 7 | 6 | 0 | 7 | 4.43 / 5 |

Success = a `finished` line inside the window; 14 turns have none (error or
cooldown paths; not explained here).

What the first-attempt failures are, for `operational` (92 turns):

- `openrouter/google/gemma-4-31b-it:free` → `mistral/zai-glm-5-3`: 41
- `openrouter/google/gemma-4-31b-it:free` → `claude-bridge/claude-haiku-5-5`: 35
- `openrouter/google/gemma-4-31b-it:free` → `ollama/gemma4:12b-mlx`: 1
- the remaining 15 were served by the first attempt

The free Gemma model, the first candidate of `operational` in this period, is
the one that fails. The classifier-probe log shows `429 … free-models-per-day`
for this model on the same days (63 probe lines). Whether the turn-time
attempts fail for the same reason was not checked line by line.

## Caveats

- The baseline describes the **old** chains (13 groups). It does not predict
  the five-group chains; those are derived from the old ones by the rename
  mapping in the plan, so the first choice of `simple`, `standard` and
  `code_complex` changes, which is the point of the measurement.
- An attempt of a cross-group cascade (`All models in X failed, trying Y`) is
  attributed to the decided group X. For `scout` and `operational` this is the
  common case, which is why their attempt averages are high.
- Small samples: `simple` has 7 turns, so its numbers are anecdotal.
- `firstAttempt` is the first attempt the router made, not the first candidate
  of the pool. They agree where both are known (the pool cross-check).

## Next

- Run the same command on the five-group layout after its first sessions; the
  first complete table needs roughly 170 routed turns per the earlier sample
  estimate (`±15 percentage points`).
