# Orchestrator mutants in nightly N12: distribution, probe, recheck

**Date:** 2026-11-24. **Plans:**
`docs/plans/2026-11-24-orchestrator-mutation-ledger.md`,
`docs/plans/2026-11-24-orchestrator-pin-round.md`.
**Input:** the report of nightly run 45406167652 (main @ `7ce2502`); the
full-suite recheck on `98e6259` (`scripts/mutation-recheck.ts`), stored as
`docs/mutation-data/nightly-orch-n12.json`.

## Where the 293 unledgered mutants sit

The carry-over sent 293 of the 299 undetected `src/stream-orchestrator.ts`
mutants to triage. Grouped by the function that encloses each mutant in the
report source:

| function | mutants |
|---|---|
| `walkCandidates` | 211 |
| `openGroupStream` | 43 |
| helpers (lines 54–217) | 13 |
| 11 small methods | 26 |

Slice 1's ledger (`nightly-r4.json`) still matches 6 of the 49 undetected
`openGroupStream` mutants.

## Would converting the slice-2 verdicts pay off?

`scripts/mutation-instrument-one.ts` on `c101b27` reproduces all 642 slice-2
ids exactly (same line, mutator and replacement). With those rows
backfilled, **at most 118** of the 211 `walkCandidates` rows match a
historical key. The other 175 of the 293 match none.

## Full-suite recheck

| result | mutants |
|---|---|
| killed | 65 |
| survived | 224 |
| timeout | 3 |
| unconfirmed | 1 |

Rulings: 18 of the survivors are EQUIVALENT (reasons in the ledger). The
other 210 are OPEN.

## The 210 OPEN mutants by region

Text = string mutants; call = a removed call or block; cond = a condition,
operator or arithmetic mutant. The split is by mutator only. It is not a
verdict.

| region (lines on `98e6259`) | open | text | call | cond |
|---|---|---|---|---|
| helpers 54–217 | 5 | 4 | 0 | 1 |
| class helpers 366–546 | 7 | 3 | 0 | 4 |
| `openGroupStream` 555–1067 | 27 | 5 | 4 | 18 |
| `driveStream` / `classifyBehindPin` / `failStream` 1068–1148 | 6 | 3 | 3 | 0 |
| walk main loop 1149–1639 | 66 | 45 | 4 | 17 |
| cascade, overflow, breaker check 1640–1699 | 9 | 1 | 0 | 8 |
| breaker probe 1700–1799 | 42 | 10 | 10 | 22 |
| cooldown collapse 1800–1948 | 35 | 15 | 8 | 12 |
| final error, helpers 1949– | 13 | 3 | 1 | 9 |
