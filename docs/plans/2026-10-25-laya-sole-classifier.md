# Laya as the sole classifier, chain as background comparator

Status: owner decisions recorded 2026-10-25; implementation partly done (see
"State"). Branch: `laya-spike` (the former feat/laya-active-snapshot was
folded into it in the 2026-10-25 branch cleanup; the live build runs from this
branch).

## Owner decisions (2026-10-25)

1. **Only Laya categorizes.** Laya decides every prompt that reaches the model
   stage. There is no confidence gate: an unsure answer is still the answer,
   it is *logged* (confidence + full probability distribution), and bad
   decisions are analysed afterwards — the analysis feeds the next fine-tune.
2. **The cloud/ollama chain runs in the background on every Laya decision**
   and writes a `comparator` decision-log record for the same input. It never
   routes. Purpose: comparability on live traffic (speed, agreement, errors).
3. **Fallback only on failure.** If the sidecar is down, errors, or exceeds
   `timeout_ms`, the cloud/ollama chain decides as it did before Laya. Never
   because Laya is unsure.
4. **HINT and compaction behave as before** (deterministic, before Laya).
5. **Cost is secondary** for this experiment.
6. **`continue` keeps its meaning**: the model cannot tell whether the task
   changed, so the previous category stays (`inheritPreviousCategory`). It is
   a category Laya can answer, not a confidence fallback.
7. The overloaded word "fallback" is a code smell and gets its own
   investigation (own plan, see "Separate: fallback naming").

## State

- Done (`9c9e63b`): `classifier_laya.compare_in_background`, detached
  comparator run, `comparator` stage in the decision log, cache / global source
  protected from the detached run.
- Done (user config, no code): `mode: active`, `confidence_threshold: 0`,
  `compare_in_background: true`. With threshold 0 `vetAnswer` accepts every
  answer with a valid category; the comparator therefore runs for every
  Laya-decided prompt. Needs a Pi restart to take effect.
- Not covered by the comparator: prompts Laya never sees (HINT, compaction,
  short-prompt momentum) and prompts where Laya was unavailable (the chain
  decided; there is nothing to compare against).

## Risk the owner accepted — and its measured size

On the 151 owner-labelled items (shadow evaluation, 2026-10-15 protocol):
Laya group accuracy 41.7 %; on the 55 items with a real live-chain answer
Laya 47.3 % vs. chain 36.4 % (paired difference +10.9 pp, 95 % CI −7.9…+29.7,
not significant). Known weak spots when Laya decides alone:

- Top-tier work is under-routed: of 22 items labelled `design`/`planning`,
  Laya routed 5 correctly, 17 too low, none too high.
- `continue`: Laya answers it 34 times, 3 match the owner label.

These are what the live comparison must watch; they are not reasons to gate.

## Decided: short-prompt momentum observation

Prompts of up to 4 words with a known previous category inherit that category
without any model (`classifyPromptUncounted`, "Short-prompt momentum"). Owner
concern: after planning with a top-tier model, "ok, do it" should be able to
move to an implementation model — Laya sees the previous prompt and the last
assistant snippet and could make that call; momentum keeps the planning model.
Measured size: 10 of 666 decision records (1.5 %), one of them after
`planning`. Decided (owner go 2026-10-29): keep momentum routing as is, but
ask Laya + the chain about those prompts too and log them as observations
(`acted: false`), so the decision is made on data.

## Steps

1. **Verify live** after the restart: `laya` records with `acted: true` for
   (almost) every non-HINT/compaction prompt; a `comparator` record with the
   same `input.sha` follows. Latency per stage from `laya.ms` vs. comparator
   `ms`.
2. **Pair evaluation** — done 2026-10-26: `scripts/laya-pair-stats.ts`
   joins `laya` and `comparator` records by `input.sha` and reports
   agreement per category and per group, confidence buckets and the
   `continue` confusion (red-first, synthetic records). First result:
   `docs/research/2026-10-26-laya-comparator-pairs.md`. Re-run it as the log
   grows.
3. **Label the disagreements** (not the whole queue). They are the
   informative items and feed the next fine-tune.
4. **Failure behaviour test**: sidecar down / timeout → chain decides, no
   comparator, no error surfaced. (Covered for 500; add timeout.)
5. **Momentum observation** — owner go 2026-10-29, implemented as `classifier_laya.observe_momentum` (default off; `observation` / `observation-comparator` stages, `acted: false`, listed in `NON_ROUTING_STAGES`). Needs a Pi restart and the flag in the user config; evaluate once enough short prompts have accumulated (about 1.5 % of prompts, so weeks).
6. **Decide on `continue`** with data: Laya's `continue` precision/recall from
   the logged probabilities; whether the owner-defined inheritance is what
   the traffic needs.

## Separate: fallback naming

Not part of this plan (AGENTS.md §11): its own plan,
`docs/plans/2026-10-25-fallback-naming.md` (branch `docs/atomic-plans`).
