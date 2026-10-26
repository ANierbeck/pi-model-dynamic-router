# Which groups actually select different models? (measurement)

**Status:** measurement, 2026-10-26. No code or config changed.

**Problem:** The router ships 13 groups and the classifier knows 7
categories. The owner's question: if several groups end up with the same
models, why do they exist — and why separate categories that lead to the same
group's models?

**Solution (this note):** compare the candidate lists the router really
computed per group. Decisions about merging belong to
`docs/plans/2026-10-25-category-group-mismatch.md`; this note is its input.

**Verified against:** `~/.pi/logs/router.log` (lines `[routing] group=… candidates: …`
from 2026-10-20 to 2026-10-26, flags `[limited]`/`[unhealthy]`/`[paced]`
parsed but not used for grouping), `router-config.json` on `laya-spike`.

## Method and limits

- One log line is one candidate computation. Cascades (a group failing over
  to the next) and non-prompt lookups are counted too, so the counts are
  **not** the number of user prompts.
- The order inside a list changes with provider state. A `[paced]` provider
  (Mistral budget pacing) is sorted to the back, which moves other models to
  the front. A single log line therefore shows one provider state, not the
  group's normal behaviour. Always read the counts, not one line.
- Only the top four candidates were compared.
- No prompt text is used or stored here.

## Group parameters and live entries (since 2026-10-20)

| Group | Entries | Method | `max_cost` | `min_gdpval` | Configured `fallback_groups` |
|---|---|---|---|---|---|
| trivial | 38 | tiered | 0 | 0 | simple, operational, fallback |
| simple | 38 | tiered | 0 | 0 | operational, fallback |
| scout | 64 | tiered | 0 | 0 | fallback |
| fallback | 170 | tiered | 0 | 0 | (none) |
| operational | 80 | tiered | 2.0 | 300 | standard, scout, fallback |
| standard | 63 | tiered | 5.0 | 500 | complex, operational, scout, fallback |
| complex | 67 | tiered | 10.0 | 600 | strategic, tactical, operational, scout, fallback |
| strategic | 59 | best | – | 700 | tactical, complex, operational, scout, fallback |
| tactical | 59 | best | – | 1630 | strategic, complex, operational, scout, fallback |
| planning | 52 | best | – | 1700 | strategic, tactical, operational, fallback |
| bulk_reader | 57 | tiered | 2.0 | – | operational, scout, fallback |
| code_writer | 51 | tiered | 2.0 | – | operational, scout, fallback |
| dynamic | 0 | dynamic | – | – | – |

## Findings

1. **`trivial`, `simple` and `scout` select the same models in every sample**:
   `gemma-4-31b-it:free`, `gemma-4-26b-a4b-it:free`, `openrouter/free`, then
   local `gemma4:12b-mlx`. `fallback` uses the same two Gemma models first,
   then the local model and `qwen3.5` (near-identical). The `cloud_first` /
   `local_before_payg` preferences are not visible in the resulting order.
   Category `simple` routes to `scout` and `code_simple` routes to `simple`,
   so **these two categories reach the same models**.
2. **`standard`, `complex`, `operational`, `bulk_reader`, `code_writer`
   (and `strategic` with three) start with the same candidates**, either
   Mistral's `zai-glm-5-3` / `glm-5-2` / `mistral-medium-3-5` /
   `magistral-medium-latest`, or — while Mistral is `[paced]` — the two free
   Gemma models first. For `operational` the first pick was Gemma 38 times and
   `zai-glm-5-3` 36 times (of 80). Their floors (300 / 500 / 600) are low
   enough that the same models pass.
3. **`tactical`** most often lists exactly one model (`zai-glm-5-3`): the
   1630 band leaves little.
4. **`planning`** lists `claude-sonnet-5-5` then `claude-opus-5-5` in the
   sessions that have the claude-bridge provider; in 26 of 52 entries the
   list is empty (`candidates: (none)`), all of them from the log lines of
   the process `[pi/…]`. Not investigated here.
5. **`fallback` is the most used group** (170 entries, 7–45 per day). Likely
   causes are cascades and the tool follow-up route recorded in `TODO.md`
   (follow-up falls into the `fallback` pool). Not separated here.

## Equivalence classes by what they select

| Pool | Groups | Categories that reach it |
|---|---|---|
| cheap (free Gemma, local last) | trivial, simple, scout, fallback | simple, code_simple |
| tank (Mistral GLM/Medium, Gemma when paced) | standard, complex, operational, strategic (+ bulk_reader, code_writer) | standard |
| tactical band (one model) | tactical | code_complex (`continue` only when the session has no previous category) |
| planning (claude-bridge) | planning | design, planning |

Reachable today: scout, simple, operational, tactical, planning (+ the
infrastructure group `fallback`), per `2026-10-25-category-group-mismatch.md`.
Measured, that is **four** distinct pools, not five.

`continue` is not a pool of its own: `inheritPreviousCategory`
(`src/content-classifier.ts:602`) replaces it with the previous category, so
it reaches `tactical` (its default group in `CATEGORY_TO_GROUP`) only in a
fresh session. In the decision log, with Laya or the cloud chain as the acting
stage, such `continue` answers inherited `code_complex` 28 times, `standard`
23 times and `design` 14 times; 9 had no predecessor and stayed `continue`.
Comparator records are log-only and show no inheritance.

## Correction of an earlier statement

During the 2026-10-26 discussion I said that `operational` starts with the
same two Gemma models as `scout`/`simple`, based on the **last** log line. That
line was taken while Mistral was `[paced]`. Over the whole period `operational`
starts with Gemma and with `zai-glm-5-3` about equally often, so `standard`
is **not** generally the same pool as `simple`/`scout`. The `simple` /
`code_simple` finding (1) holds in every sample.

## Open decisions (owner)

- **Principle:** a category or group exists only if it leads to different
  models or a documented, measured need. Proposed by the assistant,
  confirmed by the owner for the plan on 2026-10-26.
- **Target count:** the owner finds 5 sensible (the two special groups
  `bulk_reader` and `code_writer` are outside the count). Not yet fixed
  whether 5 means groups, categories, or both 1:1. Measured pools: four.
- **`dynamic`:** not routed in the period; special or part of the count?
