# Test-redundancy evidence for hygiene Phase 4 Step 4

**Date:** 2026-11-03
**Plan:** `docs/plans/2026-10-29-repo-hygiene.md`, Phase 4 Step 4 (owner decision 6)
**Question:** which of the 297 mutation "containment candidates" are safe to delete?

## Input

Nightly Stryker run 41434044059 (`/tmp/mut-art/mutation-report/mutation/mutation.json`,
2822 mutants: 1977 killed / 579 survived / 266 NoCoverage), per-test `killedBy`
attribution:

| bucket | count |
| --- | --- |
| covering tests | 834 |
| tests with ≥ 1 unique kill (untouchable) | 386 |
| tests with no unique kill, coverage contained in another test | 297 |
| of those: container in the SAME file | 186 |

The 186 same-file pairs are the candidate list. Owner decision 6 restricts
deletions to "clear cases": a test whose name, asserts and coverage show it
pins the same thing as a stronger test in the same file.

## Result: the containment signal does not survive assertion-level review

For every one of the 186 pairs, the candidate's `expect(...)` lines were
compared with the claimed container's:

| check | result |
| --- | --- |
| candidate's asserts are a subset of the container's | **0 of 186** |
| candidate body byte-identical to the container body | 0 |

Every pair pins a *different input or path* through the same helper. Typical
shapes: `mapLookup` exact / wildcard / no-match; `probeLaya` HTTP-500 vs
malformed-JSON vs connection-refused; `sortByBillingPreference` default vs
`local_first` vs `cloud_first`. Stryker's per-test attribution is also known
to be unreliable for static module constants (see
`docs/mutation-triage.md`), which fits: containment is a coverage artefact,
not a redundancy proof.

## The one signal that did hold: byte-identical bodies

Hashing the normalised body of every test in `test/` found exactly one
redundant group — the `CATEGORY_TO_GROUP` table pin, present verbatim in three
files (`category-groups`, `consolidated-classifier-pins`, `five-group-layout`).
Two of the three were deleted; the table stays pinned in
`five-group-layout.test.ts`, which also pins the shipped groups and the
unknown-category fallback.

A weaker signal (assert-subset within one file, 40 pairs suite-wide) was
reviewed as well: all 40 differ in inputs (a shared fixture line such as
`expect(c?.vision).toBe(false)` recurs across tests that exercise different
capability shapes). None was deleted.

## Consequence

Phase 4 Step 4 closes with 2 deletions, not with a list of 100. The 297 figure
is an upper bound on *coverage containment*, not on redundancy; the remaining
candidates stay, because deleting them would re-open Stryker survivors without
replacing the pinned behaviour.

Phase 4 Step 5 (split pin files over 1,000 lines) was measured and deferred:
splitting `consolidated-stream-error-pins` (2,735 lines) and
`consolidated-routing-cache-pins` (1,323) by `describe` raises the
file-based `repeatedBlocks` gate from 47 to 57 without changing a single
assertion — the same boilerplate simply lands in more files. Raising the
ratchet to absorb that is not allowed; the honest fix is to extract the
boilerplate the split reveals, which is a separate round.
