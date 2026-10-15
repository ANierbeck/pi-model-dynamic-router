# Laya shadow evaluation — protocol

Status: **PROPOSED — owner to confirm the decision rule before the first label is written.**
Date: 2026-10-15. Branch: `laya-spike`. Related: `docs/research/2026-10-14-laya-finetuning-state.md`.

## Question

Does the fine-tuned Laya checkpoint (run r2, frozen v2-r3 head) classify real,
unseen router prompts well enough to be promoted from shadow to active use?
The earlier verdict (NO-GO on test-88, group accuracy 53.4 % vs teacher 62.5 %)
stands until this protocol produces a new verdict.

## Data

- **Source:** the classifier decision log (`~/.pi/logs/classifier-decisions.jsonl`),
  which stores full prompt text (`classifier_log.store_text: "full"`, user layer).
  Historical records from before the shadow started are included on purpose:
  they are real prompts the model has never seen.
- **Selection:** unique, non-HINT prompts. HINT prompts are excluded because
  they are resolved deterministically before any classifier runs.
- **Exclusions (leakage):** a prompt is dropped if its normalized text matches
  any training prompt (`corpus_train_v2.jsonl`) or any golden item. **test-88 is
  never used**, not even as a check: it was measured once, for r2.
- **Truncation parity:** the sidecar receives the prompt through the production
  Laya truncation (`truncatePromptForLaya`, `src/laya-classifier.ts`), applied by
  calling that function, not a re-implementation. 46 of 158 items are truncated.
- **Context limitation:** the log stores `previousUserMessage` capped at 150
  characters, and before the memory-block fix the classifier's "previous user
  message" was often the memory block. Memory blocks are dropped (`prev` = none,
  flagged `prev_memory_block_dropped`), which removes context from 73 of 158
  items. Laya and the rater see the same, reduced context.
  The assistant snippet is not in the log; the sidecar receives the previous
  user message only.

## Blinded labeling

- The rater (owner) sees the prompt and the previous user message only.
- Laya's answer and the logged chain category are not shown.
- Categories: the seven v2-r3 categories. `unsure` items are kept out of the metrics.
- Each item is rated once; the last rating in `labels.jsonl` counts.
- Labels and queue live in `~/.laya-ft/data/shadow-eval/` (mode 600/700). They are
  private user text and are never committed.

## Metrics

Computed by `~/.laya-ft/shadow_eval/evaluate_shadow.py`:

1. Category accuracy and group accuracy (group via the production
   `CATEGORY_TO_GROUP`). Group accuracy is the routing metric and the primary one.
2. Accepted coverage and accepted group accuracy, at the configured
   `classifier_laya.confidence_threshold` (0.8 in the user config).
3. `continue` recall and precision.
4. Paired comparison with the live cloud classifier on the same items: group
   accuracy delta, and an exact one-sided sign test on the discordant items.
   **Not yet measured.** Until a comparator run exists, the verdict stays PENDING.

## Decision rule (pre-registered, PROPOSED)

The constants are fixed in `evaluate_shadow.py`. Changing them later needs a dated
note in this document, not a silent edit.

| Rule | Condition |
|------|-----------|
| R1 | at least 150 owner-rated, non-`unsure` items |
| R2 | Laya group accuracy exceeds the comparator by at least 5 pp **and** the sign test gives p < 0.05 |
| R3 | `continue` recall at least 60 % |
| R4 | group accuracy of accepted answers at least 80 %, with accepted coverage at least 30 % |

- All four hold → "PROMOTE candidate". Promotion still needs a separate, explicit
  owner decision; this rule only decides whether the question is open.
- Any failure → NO-GO: Laya stays shadow or is parked.
- R2 undecided without a comparator run → PENDING.

## Known limits (read the verdict with these)

- **Sample size:** at n ≈ 150, a 5 pp difference is within noise. R2 therefore
  requires the sign test, not just the delta.
- **Single rater:** all labels come from the owner. There is no inter-rater check.
- **Queue composition:** the queue is not a random sample of real traffic (it
  is the set of non-HINT prompts in the log). Class mix is skewed, e.g. toward
  `code_complex`. Group metrics are read with this in mind.
- **Teacher and comparator comparability:** the old teacher numbers (62.5 %) were
  measured on test-88 with the old owner labels. They are not directly comparable
  to this queue.
- **Pre-shadow prompts:** part of the queue predates the current v2 prompt. This
  affects only the comparator (its era), not the owner truth.

## Re-running

    cd ~/.laya-ft/shadow_eval
    python3 build_queue.py        # append new non-HINT prompts from the log
    python3 label_shadow.py       # blinded rating; q to quit, resumable
    python3 label_shadow.py --stats
    python3 evaluate_shadow.py    # metrics + verdict
