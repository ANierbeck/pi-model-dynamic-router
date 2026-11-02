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

## Update 2026-10-29 — 15 turns, 12 still open, three causes found

Re-run with `--since=2026-10-15` after the router-style hash fix below: 130
turns, 115 matched, 1 ambiguous, 14 unmatched (was 130 / 114 / 1 / 15).
Numbers, timestamps and structural features only; no prompt text was read.

| turn | finding |
|---|---|
| 2026-10-22T17:15:43 | **Join defect, fixed.** The router hashes `stripRouterNarration(messageText(message))`; the join hashed the raw text. This message carries a `> [router]` line, so the hashes differed. With the router's normalisation the decision is found 1 s after the turn. The same fix aligns multi-block messages (router joins text blocks with `''`, the join used `' '`) and outer whitespace. |
| 2026-10-28T16:22:13 | **Not a router turn.** The session's last `model_change` before it is `claude-bridge/claude-sonnet-5-5`, a model picked directly, so no classification exists to find. (This also corrects the earlier note's "the router was the active provider at every turn": true for the 14 old ones, not for this new one.) |
| 2026-10-25T09:31:43 | Unchanged: decision with the same hash 44 s later, outside the 30 s window. |

### Still open: 12 turns, all on three days

| day | unmatched / turns |
|---|---|
| 2026-10-15 | 6 / 13 |
| 2026-10-16 | 2 / 10 |
| 2026-10-20 | 4 / 7 |
| every day from 2026-10-21 on | 0 unexplained / about 85 |

Ruled out (each checked against all 12):

- **Prompt text variants**: router-style hash, trimmed, narration stripped — no decision with any of these hashes anywhere in the log.
- **Repeated prompts / classification cache**: none of the 12 texts occurs twice in the session, none has a decision before or after.
- **Mid-loop messages**: the record before each is an assistant `stop` (8) or a Pi system entry (4), as for matched turns; the system entries (tools added/removed) precede 5 matched turns as well.
- **Prompt length**: the 15 turns unmatched at the time fall 1 / 3 / 3 / 5 / 3 into the buckets <20 / 20–49 / 50–99 / 100–299 / 300+, the matched ones 2 / 11 / 17 / 47 / 37 — no pattern.
- **Active model**: `dynamic/dynamic` at every one of the 12; served models are the same set as for matched turns.
- **Code path**: every `classifyPrompt` call writes a record (cache hits included); the only skip without a record is the tool follow-up branch, which needs a `toolResult` as the last message.

What the logs cannot tell: `router.log` has no event at all within ±30 min of
2 of the 12 turns (10-15 08:59 and 11:41) and none within ±60 s of 7 of them
(probably a quieter log level on those days — not verified), so the router's
own view of those turns is largely gone; the persisted session messages carry
neither the router narration nor the memory block. Remaining hypotheses, none
testable from existing data: a classification that threw before its record
was written (the orchestrator then routes to the `simple`/fallback group
without a record), or a decision-log write that failed (fail-open by design).
Since 10-21 there is no such turn in about 85, so this looks like a defect of
the code that ran on those days rather than a standing one. No action beyond
keeping the `pool` record (`4726c22`); if a turn without a record shows up
again, it now has a timestamp and process tag to tie it to.
