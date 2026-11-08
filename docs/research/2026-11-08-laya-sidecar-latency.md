# Laya sidecar latency vs. `timeout_ms`

Measurement behind step 4 of `docs/plans/2026-10-25-laya-sole-classifier.md`
(failure behaviour: "sidecar timeout → chain decides"), read 2026-11-08 on
the owner's machine against the running sidecar (fine-tuned checkpoint,
MLX, `timeout_ms: 1500`).

## What the log says

- `router.log` carries 56 `classifier_laya: classify failed — classify
  request timed out after 1500ms; stage disabled` warnings between
  2026-10-11 and 2026-11-07 (13 of them on 2026-11-05, 7 on 2026-11-07).
  On 2026-11-07 12:05:50 three Pi processes timed out in the same second —
  concurrent first calls, e.g. subagents starting together.
- Every one of those warnings switched the Laya stage off in that process
  for `UNAVAILABLE_TTL_MS` (5 min); all prompts in the window went to the
  cloud chain. That contradicts owner decisions 1 and 3 of the plan (Laya
  decides every prompt; the chain only answers on failure).
- The 20 logged Laya answers since the confidence gate stopped hiding
  them: client-side time (`laya.ms`) median 1 460 ms, p90 1 837 ms, max
  1 960 ms; 8 of 20 above 1 500 ms. (The `timeout_ms` in effect when each
  record was written is not logged.)

## What the sidecar does when asked directly

Recipe: `POST /classify` against the live sidecar, wall time per request.

| probe | result |
|---|---|
| first request after a long idle (short prompt) | 3.69 s |
| the same, repeated 3 / 6 in parallel | 0.38–0.59 s / 0.12–0.29 s per request |
| 14-char prompt, three calls | 453 / 345 / 280 ms |
| 461-char prompt with context, three calls | **2 030** / 195 / 56 ms |
| 3 688-char prompt with context, three calls | **2 612** / 378 / 138 ms |
| 16 prompt lengths, each: new text / repeat / new text of the same length | 17 ms – 1 924 ms with no pattern by length |
| after 30 s / 90 s / 180 s idle | 0.52 / 0.41 / 0.38 s |

The same work takes anywhere between ~20 ms and ~2.6 s. A first, cold call
is the slowest; repeats of the same input are fast; the spread between
similar inputs is large and not explained by length. The sidecar shares the
GPU with the rest of the machine, so contention is the likely driver; this
measurement does not isolate the cause. What it does show is that a single
call above 1.5 s says little about the next one.

## Consequence

A timeout is a per-prompt event, not a verdict on the sidecar. The stage now
hands only the timed-out prompt to the chain and keeps Laya on; three
timeouts in a row still take it down for the TTL, so a truly hung sidecar
cannot tax every prompt with the full timeout. Connection errors, HTTP
errors and malformed answers still disable it at once.

`timeout_ms` itself stays the owner's setting. With a p90 near 1.8 s,
1 500 ms would make about two real prompts in five (8 of 20) fall through to the chain;
a value with headroom above the p90 (the owner's call, trading routing
latency for Laya coverage) keeps more decisions with Laya.
