# Turn ↔ decision join: reproducible base for the continue-switch measurement

**Status:** measurement, 2026-10-27. Supersedes nothing; replaces the
unreproducible join in `2026-10-27-continue-switch-measurement.md` as the
basis for any future number.

## Method

`scripts/turn-decision-join.ts` (tests: `test/turn-decision-join.test.ts`).

- Turn = user message in a pi session file (memory-block messages skipped).
- Match = decision-log record with the same prompt hash (`input.sha`, sha256
  prefix, computed the same way as the log) within 2 s before to 30 s after
  the message. `comparator` records never route and are never candidates.
- Exactly one candidate → `matched`; none → `unmatched`; more than one →
  `ambiguous`, never picked.
- `served` = provider/model of the first assistant reply to the turn;
  `switched` = differs from the last served model of the same session.

## Result (bounds fixed, log read at 2026-10-27 16:00Z)

| window | turns | matched | ambiguous | unmatched |
|---|---|---|---|---|
| since 2026-10-15 | 121 | 106 | 1 | 14 |
| all time | 2309 | 181 | 13 | 2115 |

Since 2026-10-15, per decided category (matched turns only):

| category | turns | switches |
|---|---|---|
| code_complex | 28 | 8 |
| continue | 5 | 1 |
| design | 11 | 6 |
| planning | 11 | 4 |
| simple | 3 | 1 |
| standard | 48 | 18 |

Fingerprint of the window above: `1b01114b7b712ee3` (rerun identical).

## What this does and does not show

- **Reproducible:** the same bounds give the same fingerprint. Whether the
  earlier 54-vs-217 discrepancy came from the old unpinned join is **not
  verified**; its cause is still open. This join does not reproduce either
  old number, because it counts turns, not pairs.
- **Too small for `continue`:** 5 matched turns, 1 switch. No conclusion about
  whether `continue` keeps or switches the model can be drawn from this.
- **Most history is unjoinable:** only 181 of 2309 session turns have a
  decision record. The decision log starts 2026-10-09, and sessions before
  that have no record at all.
- **Unmatched since 10-15 (14):** cause not yet examined.
- **Served = first assistant reply of a turn:** a model change inside a turn
  (tool loop, fallback) is not seen by this measure.

## Next

Option A: widen the sample by collecting more turns with the decision log
enabled, then rerun this join with fixed bounds. Option B: examine the 14
unmatched turns first, in case a systematic gap hides part of the data.
