# `continue` model switches — reproducible measurement

**Date:** 2026-11-08. **Status:** done, reproducible.
Answers Step 1 of `docs/plans/2026-10-26-continue-keeps-model.md`.
Supersedes the non-reproducible attempt of 2026-10-27
(`docs/research/2026-10-27-continue-switch-measurement.md`): this run uses a
committed script and pinned bounds.

## Question

How often does a `continue` turn serve a different model than the turn before
it, and what explains the switch? The plan's premise: these switches are
ranking changes (nothing new was said, but health demotion, pacing or a cost
tie moved the group's ranking) and each costs a cold prompt cache.

## Method

Committed script: `scripts/continue-switch-measure.ts` (test:
`test/continue-switch-measure.test.ts`). It reuses the join of
`scripts/turn-decision-join.ts` (prompt hash `input.sha`, window 2 s before to
30 s after the message; pool and comparator records never route; ambiguous
matches are never picked).

- **Turns:** every user message in every `~/.pi/agent/sessions/*/*.jsonl`
  (one run per project directory, 28 directories); `served` is the first
  assistant reply's `provider/model`.
- **Kind:** the decision record's RAW category — `continue` is replaced by
  the inherited category in `final`, so the final category can never see it.
- **Pair:** two consecutive turns of one session whose served models are both
  known. `switched` compares them.
- **Cause:** a `router.log` line in the 45 s before the turn that names the
  previous model and matches a failure pattern (`rate limit` / `backing off` /
  `still failing after waiting` → limit; `looks wedged` / `breaker` → breaker;
  `context window` → overflow). No such line → `unexplained` — the
  ranking-change bucket. (The router logs were pre-filtered to those patterns
  with grep before the run; the classifier only needs lines that match a
  pattern, so the prefilter cannot hide a cause.)
- **Bounds pinned:** `--since=2026-10-09 --until=2026-11-07T16:00:00Z` (the
  decision log's rotation: `.jsonl.1` covers 2026-10-09 → 2026-11-03,
  the current file continues from there). Same bounds, same numbers.

## Result

| kind | pairs | switches | same group | group changed | causes |
|---|---|---|---|---|---|
| `continue` | 152 | 23 (15.1 %) | **8** | 15 | 22 unexplained, 1 limit |
| other | 430 | 203 (47.2 %) | 29 | 174 | 200 unexplained, 3 limit |
| unmatched | 104 | 34 | – | – | 34 unexplained |

(582 matched pairs in total; turns without a matched routing decision are
counted separately and excluded from the kind split.)

Reading:

1. **`continue` turns switch far less than other turns** — 15 % vs 47 %. The
   category inheritance already keeps most of them stable.
2. **Most `continue` switches are group changes** (15 of 23): the inherited
   group differs from the previous turn's routed group (e.g. the previous turn
   was routed by a HINT or a different category). Those are classifier
   decisions, not ranking changes — out of the plan's scope by design.
3. **The plan's target set is small: 8 same-group switches on 152 `continue`
   pairs (5.3 %)**, all but one without a failure cause. Minus the one
   rate-limit switch (the model is not usable — the plan would correctly NOT
   keep it), the fixable set is **7 switches in a month** of heavy daily
   traffic across all projects.
4. Other turns' switches are also mostly group changes (174 of 203) — the
   classifier re-decides on every substantive prompt; that is its job.

## Spot check (one target case, verified in the raw log)

2026-11-04T22:00:34Z, session `…3-8d3de423241b.jsonl`: the previous turn was
served by `mistral/mistral-large-4` (finished 21:59:15, stopReason stop — no
failure), the `continue → standard` turn routed
`[routing] group=standard method=tiered candidates: 1. claude-bridge/claude-haiku-5-5`
and served it. No rate-limit, breaker or context-window line names the previous
model in the window. A pure ranking change — exactly the case the plan would
prevent by putting `lastDynamicModel` first.

## Consequence

The premise holds (same-group ranking switches on `continue` exist and are
unexplained by failures), but the share is small: ~5 % of `continue` turns,
~7 events in the measured month. Whether the change is worth its code is the
owner's decision (the plan's Step 1 says so explicitly). The cost side — a cold
cache re-pays the whole context once per event — is not measured here; on long
coding sessions (six-digit token contexts) a single event is costly, which is
the argument for implementing despite the small share.
