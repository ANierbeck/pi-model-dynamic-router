# Task-type balancing remainder — what is still worth building?

Measurement behind the closing review of
`docs/plans/2026-10-05-task-type-balancing.md`, read 2026-11-08. Two open
questions from that plan had no data until now: what the compaction summary
costs (step 5d) and whether the router itself breaks the prompt prefix
(Phase 0 step 6, "short-gap cache misses").

## Data and method

- Source: the owner's Pi session files for November 2026 (main sessions only;
  forks and subagent artifacts excluded), router decision log
  (`classifier-decisions.jsonl`) and `router.log`. The analysis scripts were
  throwaway and are not committed; every number below can be re-derived with
  the recipe next to it.
- Costs are the `usage.cost.total` Pi stores per message, i.e. list prices.
  Subscription models (claude-bridge) report $0, so dollar figures only cover
  pay-per-token providers.
- Caveat: one owner, one month. The shape of the result matters more than the
  third digit.

## 1. Compaction summary (5d): the cost at stake is tiny

Recipe: session entries of `type: "compaction"` carry the `usage` of the call
that wrote the summary.

| | value |
|---|---|
| compactions in November | 27 |
| input tokens summarized (input + cacheRead) | 2.97 M |
| output tokens (the summaries) | 0.22 M |
| **cost of all compaction calls** | **$2.97** |
| median context before compaction | 235 k tokens |
| median summary size | 45 k characters |

For comparison, the same session files hold about $74 of pay-per-token spend
for the month (Mistral, list prices), so compaction is about 4 % of it — and
that already includes the calls that ran on a mid-tier model. Routing every
summary to a free model would save at most ~$3 a month; on the subscription
side the 3 M tokens are about 1 % of the claude-bridge volume (308 M tokens in
the same month).

How the router routes a compaction call today (decision log, 44 compaction
records 2026-11-03..08): 36 keep the last model because it is large enough
("Model continuity during compaction", `src/content-classifier.ts`), 8 go to
`code_complex` for lack of a large last model. Targets seen: the cheap
deepseek flash model 11×, GLM 7×, Sonnet 6×, Opus 6×, others 14×.

What a cheaper summarizer would risk: the summary replaces the whole older
conversation, so a weak summary degrades every later step of the session,
while the saving is about $3. The asymmetry argues against building it.

## 2. Short-gap cache misses (Phase 0 step 6): not the router's prefix

Recipe: consecutive assistant messages of one session, both with more than
20 k tokens of context and less than 120 s apart (6 117 pairs). A *miss* is a
step whose cacheRead share is below 50 %.

| | pairs |
|---|---|
| hit, same model | 5 983 |
| hit, model changed | 2 |
| miss, same model | 119 |
| miss, model changed | 13 |

Only 13 of the 132 misses follow a model switch, so failover and group
changes are not the main cause. The 119 same-model misses are a property of
the provider's cache, not of one model class, and are rare where it counts:

| model | steps | misses | miss-step cost / model total |
|---|---|---|---|
| zai-glm-5-3 | 2 673 | 29 (1.1 %) | $3.63 of $51.40 |
| mistral-large-4 | 725 | 12 (1.7 %) | $0.90 of $8.70 |
| deepseek v4.1 flash | 1 203 | 49 (4.1 %) | $1.57 of $3.81 |
| openrouter/free (meta-router) | 44 | 26 (59 %) | $0.00 |
| claude-sonnet-5-5 | 849 | 2 (0.2 %) | n/a (subscription) |

`openrouter/free` is a meta-router that picks a different backing model per
request, so a high miss rate is expected there and costs nothing. The
remaining suspects (router narration text near the top of the context, a
provider-side partial prefix match) would be worth at most a few dollars a
month on this data. No router-side prefix break is evident, so step 6 is
closed as measured.

## 3. bulk_read thresholds (5d, second half): no data to decide on

`router.log` records 65 blocked full-file reads and 115 shrunk tool results in
the window, but the block line does not log the file size, so the question
"is 350 lines the right threshold?" cannot be answered from existing logs. A
review would first need the line count (and the replaced size) in the log
line. That is instrumentation, not a threshold change, and only worth doing if
the owner feels the threshold is wrong.

## Conclusion

Of the plan's remainder, nothing is cost-justified by the data: 5d's summary
model saves ~$3 a month at a quality risk, and the prefix investigation found
no router-side cause. 5c stays deferred to 2.0.x by owner decision.
