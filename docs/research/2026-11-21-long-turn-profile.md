# Long-turn profile (Phase 0 of the long-turn model-use plan)

**Date:** 2026-11-21. **Plan:** `docs/plans/2026-11-21-long-turn-model-use.md`.
**Method:** `scripts/long-turn-profile.py` over the 349 session files of this
repository (`~/.pi/agent/sessions/--Users-anierbeck-git-pi-model-router-fork--/`).
A turn runs from one user message to the next; a step is one assistant
message. Tokens = input + cacheRead + cacheWrite + output. Session files are
read linearly (branches are not followed).

## Does the decision log hold the data?

No. `~/.pi/logs/classifier-decisions.jsonl*` records routing per turn (stages
`pool`, `outcome`, `comparator`, `laya`, `hint`, `compaction`, `momentum`,
`observation`, `fallback`, `llm-cloud`). It holds no tool steps. The session
files hold every step with its model, usage and tool calls, so Phase 0 reads
those. No logging change was needed for the measurement.

## Results

Turns by length (steps). "Token share" is of all 5.67 billion tokens.

| Steps per turn | Turns | Token share | Mechanical steps | Cache-read share |
|---|---|---|---|---|
| 1–9 | 1,602 | 9 % | 60 % | 68 % |
| 10–49 | 841 | 39 % | 81 % | 85 % |
| 50–99 | 142 | 22 % | 80 % | 88 % |
| 100+ | 66 | 30 % | 83 % | 94 % |

- Turns of 50 or more steps: 208 of 2,651 (8 %), in 26 sessions. They hold
  52 % of all tokens. The top 5 % of turns hold 45 %.
- Context per step (median, long turns): 103k tokens at step 1, 98k at step
  10, 119k at step 50, 120k at step 100. Most of it is cache reads. The
  per-step base is large; growth inside a turn is small.
- Tool-result characters in long turns: `bash` 78 %, `read` 17 %, `edit` 1 %.
- Expensive Claude models (claude-bridge and pi-claude, Opus and Sonnet; a
  proxy for the `expensive_groups`, since the corpus does not record groups)
  make up 25 % of long-turn tokens. Of their 3,962 steps in long turns, 86 %
  are mechanical (only read, bash, grep, find, ls or bulk_read). Those
  mechanical steps are 21.6 % of long-turn tokens, or 11 % of all tokens.
- Other models in long turns are mostly cheaper ones (the GLM and DeepSeek
  routes lead at about 25 %, then deepseek-flash and mistral-medium). So the
  expensive-model share is about a quarter, not the whole turn.

## What the big tool results cost

- Bash results of 3.5k characters or more in long turns: 890. Of these, 849
  (95 %) are piped or grep/sed/awk commands, which the delegation exemption
  currently passes through unsummarised. They carry 96 % of the characters.
- Context tokens re-read by long-turn steps: 3,820 million. The big bash
  results that the exemption keeps account for 5.2 % of them. Shrinking every
  big bash result would account for at most 5.6 %.

## Conclusions

1. The lever is the number of expensive steps, not the size of their results.
   Mechanical expensive steps are about 11 % of all tokens; result shrinking is
   worth at most about 5 % of context re-reads.
2. Phase 1 (remove the piped/grep exemption above a size cap) is small but
   cheap, and it is the only place the data shows a leak.
3. Phase 2 (a worker tool that runs a fully specified mechanical task on the
   delegation group) is where the saving is. It replaces several expensive
   steps with one.

## Limits

- Tokens, not dollars. `claude-bridge` reports cost 0, so no price sheet is
  applied.
- "Mechanical" is judged by tool name only. A bash call can still need
  judgment, and `sed -i` counts as mechanical; the mechanical share may be
  overstated.
- The corpus mixes sessions run on concrete models (before the router) and
  on router groups. "Expensive" uses a model-name proxy, not the configured
  groups.
- One user, one repository, linear reads of session files.
