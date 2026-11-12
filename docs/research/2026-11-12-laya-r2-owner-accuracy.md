# Laya r2 against owner labels — state on 2026-11-12

Measured 2026-11-12 against the r2 checkpoint served by the MLX reference
sidecar (`http://127.0.0.1:8089`, head `5f12495d95d8`, the head the ONNX
sidecar reproduces 180/180 on the golden set). Linked from
`docs/plans/2026-10-25-laya-sole-classifier.md` (risk section) and
`docs/plans/2026-10-15-laya-shadow-evaluation.md` (verdict). Numbers only, no
prompt text; the inputs live under `~/.laya-ft/data/` (mode 600).

## Question

Owner question (2026-11-12): what does the labelling done so far say about
the current Laya model? The previously recorded risk (41.7 % group accuracy
on 151 labels, sole-classifier plan) predates 95 further labels and the
five-group layout.

## Method

- **Shadow labels:** all 248 owner labels in
  `~/.laya-ft/data/shadow-eval/labels.jsonl` (246 with a v2-r3 category).
  The queue's stored Laya answers came from whichever sidecar ran when an item
  was added (209/248 categories match today's r2), so every labelled prompt was
  classified again with r2 — same request shape as the router (`prompt` plus
  `context.previousUserMessage`, production `truncatePromptForLaya` applied).
- **Leakage check:** no labelled prompt is a training item (`train_v2.jsonl`,
  0 key matches; 0 of 233 prompts of ≥ 40 chars appear in a training state).
  12 match corpus prompts, all in the corpus `test` split.
- **Golden set:** `golden.jsonl` `truth_v2` (owner) against the recorded r2
  answers (`data/parity/mlx-golden-prod.json`).
- **Group accuracy** uses the five-group `CATEGORY_TO_GROUP`
  (`src/content-classifier.ts`: simple/code_simple → simple, the others 1:1,
  `continue` as its own answer). 95 % intervals are Wilson intervals.

## Results

| Set | n | r2 category | r2 five-group | Comparison | Majority baseline |
|---|---|---|---|---|---|
| Shadow, all labels | 246 | 22.8 % (18.0–28.4) | 24.0 % (19.1–29.7) | — | 30.5 % (`code_complex`) |
| Shadow, build_queue sweep (2026-10-15, unselected) | 151 | 20.5 % (14.9–27.7) | | | 31.8 % (`standard`) |
| Shadow, live_label (uncertain + every 10th) | 95 | 26.3 % (18.5–36.0) | | | 30.5 % |
| Shadow, items with a live cloud answer | 55 | 23.6 % (14.4–36.3) | 25.5 % | cloud chain 29.1 % (18.8–42.1) | 36.4 % |
| Golden `test` (held out) | 88 | 43.2 % (33.3–53.6) | | GLM-5.3 teacher 53.4 %, Opus 5.5 53.4 % | 28.4 % (`continue`) |
| Golden `dev` | 85 | 95.3 % | | GLM-5.3 54.1 %, Opus 5.5 56.5 % | |

Pre-registered rule (`~/.laya-ft/shadow_eval/evaluate_shadow.py`, constants
unchanged, run on the r2 answers): R1 holds (246 ≥ 150); R3 fails (continue
recall 27.8 % < 60 %); R4 fails (accepted group accuracy 38.6 % < 80 %); R2
is undecided (55 comparator items; Laya-only right 17, chain-only right 11,
sign test p = 0.17). **Verdict unchanged: NO-GO.**

Confusion highlights (shadow, truth → r2): `standard` → `continue` 22,
`code_complex` → `standard` 23, `continue` → `code_complex` 19. r2 answers
`continue` 60 times; 10 of those match the owner.

## Findings

1. **r2 is below the majority baseline on live prompts.** 22.8 % against
   30.5 % for always answering `code_complex`. Selection does not explain it:
   the unselected sweep is lower (20.5 %) than the uncertainty-selected items,
   and r2's confident answers (top-2 margin ≥ 0.1 and confidence ≥ 0.4) match
   26–31 %.
2. **The golden figure must not be read as 68.8 %.** 85 of the 88 `dev` items
   are in the training set (source `owner-dev`), so `dev` is in-sample
   (95.3 %). Held out, r2 reaches 43.2 %, about 10 points below both cloud
   teachers; the intervals overlap.
3. **Owner agreement is low for every classifier.** Opus 5.5 and GLM-5.3 agree
   with the owner on 53 % of golden `test`, the live cloud chain on 29 % of the
   shadow items. The category boundaries the owner applies are not the ones
   the taxonomy prompt conveys — a limit no fine-tune on teacher labels can
   pass.
4. **The 41.7 % in the sole-classifier plan used the old group mapping.**
   `~/.laya-ft/shadow_eval/common.py` `GROUP` still mirrors the pre-five-group
   table (scout/operational/tactical), which merges categories the router now
   separates. With the current mapping the figure is 24.0 %.
5. **The background comparator cannot reach R2.** `comparator_of` in
   `evaluate_shadow.py` counts only `chain_stage == "llm-cloud"`; the cloud
   answers written since 2026-11-08 have stage `comparator` (1 queue item has
   it), so R2 stays at the 55 pre-switch items however much is labelled.

## Update 2026-11-12 — evaluation tooling fixed, R2 decided

Finding 5 above is resolved the same day: `comparator_of` now accepts the
era-2 `comparator` records (joined on `input.sha`), and `GROUP` mirrors the
five-group layout. Re-run on the same 246 labels: `comparator_n` 150
(was 55), paired group delta **−2.7 pp** (95 % CI −11.7…+6.4, sign test
p = 0.76) — Laya is not ahead of the chain, R2 fails, the verdict stays
NO-GO. Dated note in `docs/plans/2026-10-15-laya-shadow-evaluation.md`.

## Limitations

- The shadow queue has no `lastAssistantSnippet`, which production sends.
  Removing it on golden changes r2 by −12.9 points on `dev` and +5.7 on `test`,
  so its absence does not explain the shadow result, but the shadow figures
  are for a slightly poorer input than production.
- `previousUserMessage` in the log is capped at 150 characters, and memory
  blocks were dropped (shadow protocol).
- **Protocol deviation:** the shadow protocol says golden `test` is never used
  again after its one r2 measurement. It was used here as a measurement only;
  nothing was selected or tuned on it. Its result agrees with the 2026-10-15
  verdict (teacher ahead of r2).
