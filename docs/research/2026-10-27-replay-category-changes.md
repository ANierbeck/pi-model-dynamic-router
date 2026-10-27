# Category-level change list for the 5-group layout (first cut of Step 2)

**Status:** measurement, 2026-10-27. Covers the group change per decision only.
It does NOT compare candidate pools or the chosen model; that is the pool
replay, still to do.

## Method

- Decisions: decision-log routing records since 2026-10-15 (joined turns,
  `2026-10-27-turn-decision-join.md`) for the category table; the record-level
  count for `continue` uses all routing records, joined or not.
- Target group per category from D4 and D7 (`simple` ← `simple`, `code_simple`;
  `standard`; `code_complex`; `design`; `planning`). `continue` follows D6:
  no predecessor → `standard`.
- Old group = `final.group` as logged.

## Joined turns (matched, since 2026-10-15): 106

| category | old group | new group | turns | kind of change |
|---|---|---|---|---|
| code_complex | tactical | code_complex | 28 | rename |
| standard | operational | standard | 48 | rename |
| simple | scout | simple | 3 | merge (lists identical per the equivalence note) |
| design | planning | design | 11 | **pool change**: new floor 1600 |
| planning | planning | planning | 11 | none |
| continue | tactical | standard (no predecessor) / tactical (predecessor) | 5 | D6 — see below |

## Record-level `continue` (routing stages, since 2026-10-15)

12 records. 11 have no predecessor (`prev` = null) → under D6 they move
`tactical` → `standard`. 1 has a predecessor and keeps `tactical`. This is more
than the 5 joined turns: most `continue` decisions are not joined to a session
turn, so the join sample understates D6.

## What this means

- The rename rows change no pool, if D4 is read as a rename. Equivalence of
  `standard` and `operational`, and of `code_complex` and `tactical`, is
  assumed, not measured here.
- `design` changes its pool. From the scan cache, Briefcase ordering keeps the
  top of `design` at the same model as `planning` (claude-sonnet-5-5 1823
  Briefcase, ahead of haiku 1578 and glm 1508). So the floor changes the
  fallback order below the top, not the first choice, unless the top is
  limited or unhealthy. **This is reasoning from the scan cache, not a replay
  run.**
- D6 moves the most decisions by count. Whether `standard` is an acceptable
  pool for a continuation with no predecessor is an owner question; it is not
  answered by this count.

## Open

- Pool replay: run the real `Router` with the target layout on the same
  decisions, to confirm the `design` and D6 statements above.
- Failover chains and D2 re-pointing (`strategic` removal) are not covered.
