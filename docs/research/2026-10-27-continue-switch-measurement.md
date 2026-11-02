# Model switches on `continue` vs. other turns — measurement attempt

**Date:** 2026-10-27. **Status:** not reproducible yet. Results of the first
run are NOT confirmed. This note is the record of why.

**Question:** do `continue` turns change the serving model more often than
other turns? (Step 1 of `docs/plans/2026-10-26-continue-keeps-model.md`.)

## What was measured

- **Turns:** one per user prompt in `~/.pi/agent/sessions/*/*.jsonl`
  (prompts starting with `<memory>` skipped). The model is the first
  assistant reply after the prompt, as `provider/model`.
- **Verdict:** the nearest decision in `~/.pi/logs/classifier-decisions.jsonl`
  whose `ts` lies between 2 s before and 30 s after the prompt
  (`/tmp/same-group/turns_fix.py`, throwaway, not committed).
- **Pairs:** consecutive turns of one session. Kind `continue` when the raw
  category of the current turn is `continue`, otherwise `other`.

## Result of the re-run (2026-10-27, sessions from 09.10.)

| | value |
|---|---|
| pairs with a verdict | 54 (`other` 35, `continue` 19) |
| model switches, `continue` | 1 |
| model switches, `other` | 19 |
| `other`, same group | 5 |

The five same-group switches (`router.log` within 45 s before the turn):

- 4 with no log line in the window that explains the switch;
- 1 with `rate limit` and `backing off` on the previous model (ling-3.1-flash
  on OpenRouter, switched to apodex-1.1-mini:free).

## What does not match the first run

The first run (2026-10-27, earlier this day) reported **217 pairs**,
`continue` 3/44 switched, same group without `continue` 14/77 switched, other
group 73/96. Today's join yields **54 pairs** from the same inputs. The two
joins differ in how a turn is matched to a verdict. The first run's join is
not in the repo and its script was not kept as a reproducible file, so the
difference is not yet explained.

**Consequence:** the 3/44 and 14/77 figures are not usable for the plan
decision. They must not be quoted until a re-run reproduces them with a
committed join. Same for the 7 % / 18 % / 76 % split in
`docs/plans/2026-10-26-continue-keeps-model.md` (not yet written there; only
in the llmao notes).

## Open questions

1. Why does the verdict join match 54 pairs? Check how many decisions
   exist per prompt (`stage` values: hint, llm-cloud, compaction, laya,
   comparator, momentum, fallback) and which one the join picks.
2. Four of five same-group switches have no explaining log line. Candidates
   to test: the ranking within the group changes between turns (candidate
   order, `best`/`tiered` selection), a cooldown that ends, a context-window
   pre-flight guard (`stream-orchestrator.ts:729`). None is confirmed.
3. Does the plan's premise hold — are switches inside `continue` caused by
   something the plan would fix (model stickiness), or by the group
   selection itself?

## Next step

Commit the join as a repo script with a test, fixed to one stage and one
window, then re-run. Only then update the `continue-keeps-model` plan.
