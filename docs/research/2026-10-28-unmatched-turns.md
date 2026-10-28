# The unmatched turns of the turn↔decision join — 2026-10-28

Question: why do 14 turns (plus 1 ambiguous) of 121 since 2026-10-15 have no
decision (`docs/research/2026-10-27-turn-decision-join.md`)? Numbers and
timestamps only; no prompt text was read or quoted.

## What was ruled out

- **Not subagents / other projects.** All 121 turns come from one long-running
  session; the active provider was the router (`dynamic`) at every one of them,
  matched and unmatched alike.
- **Not mid-loop steering.** The entry before an unmatched turn looks like the
  entry before a matched turn (assistant `stop` ×10, system ×5, against 97 / 5 for
  the matched ones, plus 4 other kinds).

## Explained: 2 of 14 (+ the ambiguous one)

| turn | finding |
|---|---|
| 2026-10-22T17:15:43 | A routing decision exists 1.2 s later (`llm-cloud`, routed `standard → operational`) with a **different prompt hash** — the text the classifier saw is not byte-identical to the stored user message. |
| 2026-10-25T09:31:43 | The decision has the **same hash 44 s later** (`llm-cloud`), outside the 30 s window. |
| 2026-10-25T11:52:38 (ambiguous) | 38 `hint` records carry the same hash (one prompt, repeated); the join refuses to pick one, by design. |

## Not explained: 12 of 14

No decision with that hash anywhere in the log, and no routing narration or
`tryStream` within 15 s in router.log. For 5 of them the router log has no
event at all within ±20 s although the router was the active provider; for the
others only classifier probes or other processes appear. Hypotheses, none
tested: a message queued behind a running loop is answered under that loop's
routing without its own classification; or the classification of such a turn
is written under a text that differs from the stored message (as in the
10-22 case).

## Consequence

The join's `unmatched` rows are a measured 11.6 % (14/121) and must not be
re-read as "no decision was made". The reproducible fix for the future is
already in: the `pool` record (`4726c22`) is written per resolution with
`proc` and a timestamp, so a turn can be tied to a routing event without
relying on the prompt hash alone.
