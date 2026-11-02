# Pool-content replay of the 5-group plan — 2026-10-28

Question (Step 3 of `docs/plans/2026-10-25-category-group-mismatch.md`): which
decisions get a different pool under the target layout, and does the head
change? Only two category changes move a pool
(`docs/research/2026-10-27-replay-category-changes.md`): `design` (floor 1700 →
1600, D5) and `continue` without predecessor (`tactical` → `standard`, D6). The
other categories are renames of groups with identical pools.

Method: `node --import tsx scripts/pool-replay.ts --replay --since=2026-10-15T00:00:00Z --until=2026-10-27T16:00:00Z`
(helpers `scripts/pool-delta.ts`, tested in `test/pool-delta.test.ts`).
Pools come from router.log's routing lines as of the decision time and process
(`docs/research/2026-10-28-route-calibration.md`), not from the scan cache.
Pool **content and head** are compared, never "who served" (failover decides).

## design — floor 1700 → 1600: first choice unchanged, pool gets longer

39 `design` decisions (all stages, not only joined turns), each with a planning
pool line.

| | result |
|---|---|
| head changed | 0 / 39 |
| head today and under the target | `claude-bridge/claude-sonnet-5-5`, 39 / 39 |
| added below the head | claude-haiku-5-5 (39), zai-glm-5-3 (39), zai-glm-5-3-flash (17) |
| removed | none |

Ranking uses the Briefcase column (`score_by` of `planning`), from the scan cache
as of today: sonnet-5-5 1823, haiku-5-5 1578, glm-5-3 1509. The floor admits
haiku (GDPval 1620) and glm-5-3 (1650) but Briefcase ranks both below the
current top, so the floor changes the **failover order, not the first choice**.
That holds unless the top is unhealthy or limited at the time (not modeled).

Limits: (1) the universe is the union of what the groups showed, so a model
with GDPval 1600–1630 and cost above 2.0 that no group listed is not
considered; (2) Briefcase values are today's, not those of the decision day.

## continue — D6, no predecessor: `tactical` → `standard`

12 routing `continue` decisions since 2026-10-15: **10 without a predecessor**
(D6 applies), **2 whose predecessor was itself `continue`** (D6 does not say
where they go), 10 of the 10 with both pool lines.

| | today (tactical) | target (standard) |
|---|---|---|
| head changed | | 9 / 10 |
| head | zai-glm-5-3 ×5, claude-sonnet-5-5 ×5 | gemma-4-31b-it:free ×8, minimax-m3.1-flash:free ×1, zai-glm-5-3 ×1 |
| head billing | free ×5, subscription ×5 | free ×10 |

Billing is the router's own classification (`billingTier`) with the billing
fields of the user layer (`claude-bridge` = subscription).

Reading: for a first prompt that the classifier could not categorize, the head
moves from a top coding model to a free OpenRouter model in 9 of 10 cases. No
money is saved on the subscription side (those models are flat-rate) and no
money is spent on the free side; what changes is **quality of the first answer
for ambiguous first prompts**, and cache stickiness (the first turn pins the
model for the following ones, `docs/plans/2026-10-26-continue-keeps-model.md`).
Whether that is acceptable is an owner question. The count does not answer it.

## Correction to an earlier number

`2026-10-27-replay-category-changes.md` said 11 of 12 `continue` records had no
predecessor. The reproducible count is 10 + 2 (continue after continue). The
cause of the old figure is unknown; the old note now carries the correction.

## Not covered

- Failover chains and the D2 re-pointing (`strategic` removal).
- Who served: a head can fail over before it serves (calibration: pool head =
  served in 51/100).
- The `code_complex`, `standard`, `simple`, `planning` renames are not replayed;
  their pools are identical by the equivalence note
  (`2026-10-26-group-candidate-equivalence.md`), which was measured on configs,
  not on decisions.
