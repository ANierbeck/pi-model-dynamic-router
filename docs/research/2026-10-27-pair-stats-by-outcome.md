# Laya vs. chain compared by resolved outcome — result

**Date:** 2026-10-27. **Status:** done, no code change. **Question (owner
idea):** are Laya and the chain really that far apart, or does the
disagreement come from comparing raw category labels (`continue` vs. an
explicit category, equivalent groups under different names)? Evaluating by
the resolved outcome — group or model — would then show a higher agreement.

## Answer: no

Run of `scripts/laya-pair-stats.ts` on the decision log, 79 pairs
(2026-10-27):

| level | agreement |
|---|---|
| category (`continue` resolved with the previous category) | 39 of 79 (49.4 %, 95 % CI 38.6…60.2) |
| group (observed category -> group map) | 40 of 77 (51.9 %, 95 % CI 41.0…62.7) |

The script already compares at the resolved level in two ways: `continue`
takes the previous category, and the group comes from the map observed in the
log. Going from category to group gains 2.5 points, well inside the interval.

**Labels are not the cause.** Of the 37 group disagreements, none lies between
groups with an equivalent candidate pool (`scout`/`simple`/`trivial`/
`fallback`, see `2026-10-26-group-candidate-equivalence.md`). All 37 are
cross-tier: `planning`↔`tactical` 12, `tactical`↔`operational` 11,
`operational`↔`planning` 6, the rest cheap vs. a higher tier. Treating
equivalent groups as equal would change no pair.

## Why a model-level comparison is not possible

- The comparator runs detached and never routes, so it has no model. Only the
  group it would have chosen can be derived.
- The decision log has no model field. The model of Laya's side exists only in
  the session files, and the timestamp join to them is not reproducible yet
  (`2026-10-27-continue-switch-measurement.md`).
- Even with both, two different groups would pick different models anyway, so
  the model level adds nothing over the group level for the comparator side.

## Consequence

The Laya verdict still depends on owner labels (`live_label.py`), not on a
finer agreement metric. No change to `laya-pair-stats.ts`.
