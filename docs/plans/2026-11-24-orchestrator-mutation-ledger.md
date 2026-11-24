# Orchestrator mutants without a carry-over ledger

**Status:** done — 2026-11-24. The agent chose the approach under
the owner's standing go for the mutation triage ("1, jetzt machen",
2026-11-22). The owner can overrule it under Open decisions. The 210 mutants
left OPEN continue in `2026-11-24-orchestrator-pin-round.md`.

**Verified against:** `main` @ `98e6259` (`src/` unchanged since `7ce2502`);
the report of nightly run 45406167652 (main @ `7ce2502`);
`docs/mutation-data/slice2-driveStream.json`,
`docs/mutation-data/slice2-triage/*.md`, `docs/mutation-data/nightly-r4.json`;
`scripts/mutation-carryover.ts`, `scripts/mutation-instrument-one.ts`.

## Problem

The nightly carry-over (`scripts/mutation-carryover.ts`) sends **293 of the
299** undetected `src/stream-orchestrator.ts` mutants to triage. Yet the
orchestrator rounds of 2026-11-04 to 11-08
(`2026-11-04-orchestrator-mutation-triage.md`, status done) gave every one of
them a verdict. Two causes, both checked on the data:

1. **The slice 2 and 3 verdicts never became a ledger.**
   `slice2-driveStream.json` is a `mutation-recheck.ts` result array, not a
   `{ columns, rows }` ledger. Passing it to the carry-over crashed with a
   bare `TypeError`. The final per-mutant verdicts live in four Markdown
   files. They are keyed by report **line** plus a text description, with a
   different line offset per file. Slice 3 exists only as prose in
   `docs/mutation-triage.md`.
2. **Code drift.** Slice 1 has a ledger (`nightly-r4.json`), but only 6 of
   the 49 undetected `openGroupStream` mutants still match it. The ADR 0037
   migration edited that region.

Where the 293 sit (the function that encloses each mutant in the report
source): `walkCandidates` 211, `openGroupStream` 43, helpers (lines 54–217)
13, the rest 26, spread over 11 small methods.

A probe on whether the conversion would pay off:
`mutation-instrument-one.ts` on `c101b27` reproduces all 642 slice-2 ids
exactly (same line, mutator and replacement). With those rows backfilled,
**at most 118** of the 211 `walkCandidates` rows match a historical key. The
remaining 175 of the 293 match none.

## Solution — recheck first, history as a reading aid

Converting the Markdown verdicts (option A) is rejected. Mapping by line and
description is fuzzy. It reaches at most 118 rows, and its killed verdicts
would only produce `recheck` rows, which need the same full-suite run anyway.
Instead:

1. `mutation-carryover.ts` refuses non-ledger input by name (red-first test
   in `test/mutation-carryover.test.ts`).
2. Full-suite recheck of the 293 open mutants on `98e6259`
   (`scripts/mutation-recheck.ts`). Each killed mutant becomes a
   `SUITE-KILLED` row in a new ledger `docs/mutation-data/nightly-orch-n12.json`
   (columns of `nightly-n11.json`), backfilled against the run 45406167652
   report.
3. The survivors are triaged on the current code. The historical verdicts
   serve as a reading aid only: the regenerated `c101b27` report maps a
   survivor to its slice-2 id and Markdown row where the code is unchanged.
   Each verdict is EQUIVALENT (with a reason) or a real gap.
4. Real gaps: a few are pinned in this round, red-first, with kill evidence
   from `mutation-recheck.ts --tests`. If many remain, they get their own
   test-round plan (§11) and are recorded as open, not dropped.
5. `slice2-driveStream.json` and the Markdown files stay as history. The
   triage record says they are recheck results and reading notes, not
   ledgers.

## Open decisions

- None blocking. The owner may overrule the rejection of option A (convert
  the Markdown verdicts into a ledger).

## Steps

- [x] 1. Carry-over refuses non-ledger input (red evidence: both new tests
      failed with the old `TypeError`).
- [x] 2. Full-suite recheck of the 293 → `nightly-orch-n12.json` (65 killed).
- [x] 3. Survivors ruled where the reason was verified: 18 EQUIVALENT; the
      other 210 stay OPEN (a new ledger category the carry-over keeps in triage).
- [x] 4. Too many for this round → `2026-11-24-orchestrator-pin-round.md`.
- [x] 5. `docs/mutation-triage.md` section, AGENTS §4 count, plan index rows.
