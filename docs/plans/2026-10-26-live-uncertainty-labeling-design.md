# Live labeling of uncertain Laya decisions (design)

**Status:** implemented 2026-10-26 (separate terminal, as decided).
`~/.laya-ft/shadow_eval/live_label.py` (20 unit tests, red-first observed on
the missing module; loop smoke-tested with a synthetic log, torn lines and
`q` re-offer verified). Dry run against the live log: 17 uncertain + 1
sample within the 24-hour window. The back-fill of `log_sha` into the
hand-made queue row of 2026-10-25 is done (backup `queue.jsonl.bak-20261026-logsha`).
Owner workflow fit to be re-checked after a week of use.
Owner open point: practicality of the workflow (separate terminal) — accepted
for now, to be re-checked after a week of real use.

**Verified against:** `laya-spike` (fda3722) — `src/classifier-decision-log.ts`
(`input.sha` = first 12 hex of sha256(prompt)), `~/.laya-ft/shadow_eval/common.py`
(queue key = sha1(normalised prompt)[:16]), `build_queue.py`, `label_shadow.py`.

**Related:** `docs/plans/2026-10-25-laya-sole-classifier.md` (Laya decides alone,
chain runs as comparator). This design adds the owner labels that the
disagreements and the uncertain decisions need.

## Problem

Laya now decides every prompt alone. Its uncertain decisions are the most
useful training material, but the owner only sees them in the shadow queue
hours or days later, when the context is gone. Labeling has to happen while
the prompt is still fresh, without touching the live turn.

## Solution

A standalone script `~/.laya-ft/shadow_eval/live_label.py`, outside the
repository. It is never shipped; the router code is unchanged.

1. **Tail the decision log.** Read `~/.pi/logs/classifier-decisions.jsonl`
   every ~2 s, skipping torn lines. Resume position is stored in a state file,
   so a restart continues without duplicates.
2. **Select `laya` records only** (the comparator is never shown as a
   candidate):
   - `uncertain`: margin between top-1 and top-2 probability < 0.1, **or**
     confidence < 0.4. Roughly 44 % of prompts (measured on 32 records).
   - `sample`: every 10th of the remaining prompts, deterministic (seeded by
     the log `input.sha`), to estimate overall quality without bias.
   - Prompts older than 24 hours are skipped (owner decision 2026-10-26).
3. **Skip** prompts already in the queue, in training or in the golden set
   (same checks as `build_queue.py`).
4. **Blinded dialogue.** The terminal shows the prompt and the logged previous
   user message. Layas answer and the chain answer are **not** shown. Keys:
   1–7 category, `u` unsure, `s` skip, `q` quit.
5. **Write immediately** to `queue.jsonl` and `labels.jsonl` via `append_jsonl`.
   The queue row stores `log_sha` (the decision-log `input.sha`), Laya's
   category, confidence and probabilities, and `selection` (`uncertain` or
   `sample`). The comparator record is joined later by `log_sha`; the terminal
   does not wait for it (it arrives about 15 s after Laya).

Files stay mode 600. Prompt texts stay local.

## Error handling

- Terminal not running: nothing happens in the router. The backlog is read on
  the next start, limited to 24 hours.
- Torn or invalid log lines: skipped, as in `_read_log`.
- Crash during a label: at most the open item is lost; it reappears on restart
  because its queue row is only written together with the label.
- Duplicates: deduplicated by queue key before showing an item.

## Testing (red first, pure functions)

- Selection rule: margin < 0.1 or confidence < 0.4 selects; other records do not.
- Sampling: seeded, every 10th of the remaining prompts.
- Resume: restart continues at the stored offset, no duplicates.
- Torn lines are skipped.
- 24-hour window applies.
- Excluded prompts (training, golden, already labeled) are not shown.
- The terminal UI is checked by a manual smoke test, not automated.

## Implementation steps

1. Back-fill `log_sha` into the one hand-made queue row of 2026-10-25
   (`c3fd8b8ed540a3ea`, log sha `c3565155c479`) so the pair evaluation can join it.
2. Tests first, observed RED: `~/.laya-ft/shadow_eval/test_live_label.py`
   (unittest, synthetic records only, no prompt text), covering the testing
   list above.
3. Pure core in `live_label.py`: `select`, `read_new_records`, state offset
   (log rotation resets it), `build_queue_row`.
4. Terminal loop on top (reuses `MENU` keys and rendering of `label_shadow.py`).
5. Manual smoke test against a copy of the log; real run only after that.
6. Commit the plan status update to `laya-spike`. The tool itself lives in
   `~/.laya-ft` (outside the repository) and is not versioned there.

## Found on the way

- `build_queue.py` keeps the FIRST decision-log record per prompt. Since the
  comparator snapshot that is the `laya` record, so a new run would store
  Laya's category as `chain_category`. It also stores no `log_sha`. Not
  changed here (separate problem): either retire `build_queue.py` in favour
  of `live_label.py` or make it join the comparator by `log_sha`.

## Context handling (2026-10-26)

The dialogue shows exactly the context Laya receives: `previousUserMessage`
truncated to 120 chars and `lastAssistantSnippet` truncated to 150 chars
(`buildContextBlock` in `src/classification-prompt.ts`), plus the raw prompt.
The snippet is stored in the queue row so the comparator can be joined later.

## Open decisions

- **Workflow fit (owner):** The owner would have preferred the question
  directly after the prompt. The separate terminal shows it within seconds, but
  only while it is open. Alternative considered and not chosen yet: a
  user-level Pi extension on `turn_end` that asks via `ctx.ui.select` once the
  agent is idle. That keeps the context fresh without taking focus during
  streaming, but it lives in Pi's interaction flow. Revisit after one week of
  use.
- **Sampling rate:** 1 in 10 (owner decision). Adjustable without code change.

## Out of scope

- Any change to the router's classification or routing.
- Automatic labeling by any model (the owner labels, blinded).
- Shipping this to end users.
