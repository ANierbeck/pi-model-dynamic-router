# Pool replay of the 5-group layout: first run failed calibration

**Status:** measurement, 2026-10-27. The replay driver is NOT committed; the
pure layout transform is (`scripts/pool-replay.ts`, `test/pool-replay.test.ts`).

## Question

For every matched decision since 2026-10-15, which first choice would the
router make under today's layout and under the 5-group layout? Plan Step 2.

## Method (as run)

- Joined turns from `scripts/turn-decision-join.ts` (fixed bounds).
- Router built from the layered config and the scan cache
  (`dist/.cache/scan-cache.json`), with the metric module loaded the same way
  `index.ts` does.
- Calibration: today's layout's first choice compared with the model that
  served the turn (`served`, first assistant reply).

## Result

Calibration: **11 of 101** replayed turns agree. The replay is not usable.

Observed first choices from the replay (today's layout, same cache):
`mistral/zai-glm-5-3` for every group, while the served models were
`claude-bridge/claude-sonnet-5-5`, `claude-bridge/claude-haiku-5-5`, and
(for 9 operational and 5 tactical turns) `zai-glm-5-3` itself.

## Cause

The scan cache has **0** `claude-bridge` entries (`available_models`, scan
2026-10-26 19:15). The live router logs the claude-bridge models in every
candidate list since at least 2026-10-27 14:47
(`~/.pi/logs/router.log`, `[routing] group=… candidates:`). They come from
Pi's runtime model registry, not from the scan. The replay therefore sees a
smaller pool than the one the decisions were made from. The planning rows
(`planning → (none)`) are an artifact of this, not a finding about the layout.

## Consequences

- The replay must take its pool from the decision time, not from the scan
  cache. Two sources are possible:
  1. the candidate lines in `router.log` (ranked list with gdp, cost,
     `[limited]`/`[unhealthy]`/`[paced]` flags, written at decision time) —
     available now, but only the candidates of each group, so the wider
     universe for the 1600 floor has to be reconstructed from other lines;
  2. a pool record written into the decision log at decision time — exact,
     but only for decisions made from now on.
- Until then, the 1600/1700 floor pair and the D6 effect stay unquantified
  at the level of the first choice. The category-level change list
  (`2026-10-27-replay-category-changes.md`) is the only quantified part.

## Not verified

- Whether the scan cache is the only pool source the router uses at replay
  time. The log shows that claude-bridge models are live; that they are
  absent from the cache is measured, the registry path is inferred.
