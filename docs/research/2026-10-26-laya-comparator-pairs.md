# Laya vs the background chain — first pair evaluation

**Date:** 2026-10-26. **Plan:** `docs/plans/2026-10-25-laya-sole-classifier.md`,
Step 2. **Tool:** `scripts/laya-pair-stats.ts` (`npx tsx
scripts/laya-pair-stats.ts`), tests in `test/laya-pair-stats.test.ts`.

**Data:** the decision log `~/.pi/logs/classifier-decisions.jsonl`, 54 acted
`laya` records and 54 `comparator` records, 2026-10-25 09:49 to 2026-10-26
16:59. All 54 pair up (0 unpaired). Counts and category names only; no prompt
text is stored in this note.

## Method

- Pair: each acted `laya` record with the first unused `comparator` record of
  the same `input.sha` that follows it within 5 minutes.
- Compare `raw.category`, the classifier's own answer. `final` is not
  comparable: Laya's `final` already carries the router's `continue`
  inheritance, the comparator's does not.
- `continue` is resolved on both sides with that record's `prev.category`,
  like `inheritPreviousCategory` (`src/content-classifier.ts:602`).
- Group agreement uses a category → group map observed in the log, not a
  hard-coded table. Two pairs have no group (a `continue` without
  predecessor), so the group base is 52.

## Result

| | agree | 95 % CI (Wilson) |
|---|---|---|
| category | 25 of 54 (46.3 %) | 33.7…59.4 |
| group | 26 of 52 (50.0 %) | 36.9…63.1 |

| Laya category | n | agree |
|---|---|---|
| code_complex | 16 | 43.8 % |
| standard | 15 | 53.3 % |
| design | 10 | 60.0 % |
| planning | 8 | 25.0 % |
| simple | 4 | 50.0 % |
| continue (unresolved) | 1 | 0 % |

| Laya confidence | n | agree |
|---|---|---|
| ≥ 0.80 | 3 | 66.7 % |
| 0.70–0.80 | 5 | 80.0 % |
| < 0.70 | 46 | 41.3 % |

Raw `continue` answers: both 7, Laya only 4, chain only 16, neither 27.
Median latency: Laya 935 ms, chain (background) 13 188 ms.

Disagreements (Laya → chain), the ten most frequent rows: `planning →
code_complex` 4, `standard → code_complex` 4, `code_complex → design` 3,
`code_complex → standard` 3, `code_complex → planning` 2, `design →
standard` 2, `simple → code_complex` 2, `code_complex → continue` 1,
`continue → standard` 1, `design → code_complex` 1. Eight of those ten rows
have `code_complex` on one side.

## What this does and does not say

- **Agreement is not accuracy.** The chain is a second opinion. Which side is
  right needs owner labels (`live_label.py`); this note makes no claim about
  that.
- **85 % of Laya's answers (46 of 54) sit below 0.70 confidence.** With no
  confidence gate, Laya decides almost every prompt in the zone where it
  agrees with the chain least. The buckets above 0.80 hold 8 pairs, too few
  to conclude anything about them.
- **The chain says `continue` far more often than Laya** (23 vs 11 of 54).
  After inheritance this mostly cancels (2 of the listed disagreement rows
  involve `continue`), but it shows the two disagree on what counts as "no
  new work".
- **`code_complex` is the hub of the disagreements** among the listed rows.
  Whether that is Laya's or the chain's boundary error is open.
- **The sample is small and not independent.** 54 pairs from a day and a
  half, one owner, long sessions with related prompts. The Wilson intervals
  assume independent draws, so the true uncertainty is wider than shown.

## Correction of an earlier figure

The first look at the live pairs reported 8 of 27 group agreements. That
figure compared `final.group` of the two records. Re-running that naive
comparison reproduces it exactly (8 of 27 for the first 27 pairs, 24 of 54
for all 54). It is not a like-for-like comparison: it treats the chain's
`continue` as `tactical` (the default group) while Laya's `final` carries the
inherited category. The numbers in this note use the method above.
