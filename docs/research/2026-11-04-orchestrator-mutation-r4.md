# Orchestrator mutation triage, nightly R4 — numbers

**Date:** 2026-11-04 · **Plan:** `docs/plans/2026-11-04-orchestrator-mutation-triage.md` · **Report:** run 41817385588, `main` @ `fde54f8`

## Baseline (`src/stream-orchestrator.ts`)

| | R3 (2026-10-08, local) | R4 (2026-11-04, nightly) |
| --- | --- | --- |
| mutants | 1085 | 1084 |
| killed | 342 | 420 |
| survived | 464 | 449 |
| no coverage | 279 | 214 |
| undetected | 743 | 663 |
| score | 31.5 % | 38.7 % |

## Where the 663 are

| region | lines | undetected |
| --- | --- | --- |
| `groupStream` | 305–643 | 272 |
| `driveStream` | 644–1347 | 337 |
| helpers / breaker narration | 49–180 | 49 |
| other | — | 5 |

Largest single lines: breaker-probe wait guard L1140 (12), HINT start-group thresholds L565 (11), name matching L478 (9), explicit-hint usability L517 (8).

## Slice 1 (`groupStream`, 272)

| step | killed | alive |
| --- | --- | --- |
| first test file (49 tests) | 203 | 69 |
| + 21 targeted tests (70) | 245 | 27 |
| + HINT log-format tests (73–74) | 257 | 15 |

The 15 survivors are equivalent (rationale in `docs/mutation-data/nightly-r4.json`). Projected score of the file after slice 1 alone: (420 + 257) / 1084 = 62.5 %.

## Tooling cost

`scripts/mutation-recheck.ts --tests <file> --jobs 8 --max-workers 2`: 272 mutants ≈ 25 min (most of it the serial confirmation pass). The pristine tree must be a `git worktree` checkout of the report's commit; the new test file is copied in.
