# Laya r3: retrain on the v2-r3 taxonomy with live owner labels, honest calibration, and a de-emphasized `continue`

**Status:** proposed 2026-11-15, owner decision recorded the same day:
`continue` variant **B** (inherit-relabel) is chosen — see Solution 2 and Open
decisions. Nothing is trained or published yet; the r2 artifact
(`router@1.0.0`, tag `laya-router-v1.0.0`, head `5f12495d…`) stays the served
model until r3 passes the pre-registered gate below. Publishing any artifact
is a separate owner decision (AGENTS §1; the manifest entry stays
`published: false`).

**Related plans (reused, not changed):** `2026-10-08-laya-finetuning-state.md`
(training pipeline), `2026-10-15-laya-shadow-evaluation.md` (live labels +
pre-registered rules R1–R4), `2026-10-25-laya-sole-classifier.md` (Laya decides,
chain as comparator; NO-GO gate for sole-classifier release),
`2026-11-08-laya-model-artifact.md` (manifest/installer/parity),
`2026-11-11-onnx-sidecar-package.md` (ONNX sidecar). Research:
`docs/research/2026-11-12-laya-r2-owner-accuracy.md` (r2's measured numbers).

## Problem

r2 was trained on the reduced 7-category v2-r3 taxonomy already
(`~/.laya-ft/to_laya_jsonl_v2.py`, `CATS = [simple, code_simple, standard,
code_complex, design, planning, continue]`), so "fewer categories" is not the
new information. What is new since r2:

1. **r2 is weak exactly where it over-answers.** Held-out golden `test` (92
   items, never trained on): group accuracy **43.2 %**, teachers (GLM-5.3,
   Opus 5.5) on the same items **53.4 %**. Golden `dev` reads 95.3 % but is
   in-sample (85/88 dev items were in r2's training set) — dev is burned as an
   eval split. Live shadow (246 labeled prompts at the 12-11 measurement):
   **22.8 %** group accuracy vs **30.5 %** for the always-`code_complex`
   majority. Confusion mass is `standard→continue` (22), `code_complex→standard`
   (23), `continue→code_complex` (19); r2 answered `continue` 60 times, only 10
   matched. Pre-registered rule R3 (continue recall ≥ 60 %) fails at 27.8 %.
2. **281 live shadow labels with owner truth now exist**
   (`~/.laya-ft/data/shadow-eval/labels.jsonl`, all 281 joinable to queue
   prompts by `key` = sha1-16 of the normalized `[prompt, prev, snip]` tuple).
   r2 never saw them.
3. **Owner boundaries ≠ taxonomy prompt.** Even Opus/GLM agree with the owner
   on only ~53 % of golden `test`; the live cloud chain on 29 % of shadow
   items. Teacher labels alone cannot close this — owner labels must carry the
   weight.
4. **The confidence number is not calibrated on held-out data.** r2's
   `rl_agent_config.json` ships `temperature: [2.0488, 1, 1]` from the training
   run's own calibration slice, not from the untouched test split. Measured on
   90 live laya/comparator pairs (2026-11-15): confidence percentiles p50=0.53,
   p90=0.79, and group agreement with the chain is flat across confidence bands
   (38/40/35/56 %) — the number does not predict correctness, so the
   `confidence_threshold` gate is currently meaningless (owner runs it at 0).

## Solution

One retrain, `runs/r3`, four corpus sources, one hard rule: **golden `test`
(92 items) is never in any training, calibration or selection step.** Eval
happens once, pre-registered, on `test`.

### 1. Corpus (`to_laya_jsonl_v3.py`, new; v2 script untouched)

Sources, in priority order (weight implemented as row repetition, since
laya-train has no sample weights — the v2 mechanism, `OWNER_REPEAT`):

| Source | Rows | Label | Weight (repeat) |
|---|---|---|---|
| Shadow live labels (`shadow-eval/labels.jsonl` ⋈ `queue.jsonl` on `key`) | 281 | owner truth (v2-r3) | 5× |
| Golden `dev` (`golden.jsonl`, split=dev, truth_v2 ∉ {None, ambiguous}) | ~88 | owner truth | 3× (as in r2) |
| Session train split, teacher-labeled (`v2labels-train/labels-…glm-5-3.jsonl`, ok && category ∈ CATS && confidence ≥ min-conf) | ~2000 | GLM v2-r3 teacher | 1× |
| Golden `test` | — | — | **never** |

Dedup by `key` across sources (owner label wins over teacher label for the
same key). The head question is byte-identical to r2
(`SHORT_INSTRUCTIONS` + `CATS`, also identical to the router's
`LAYA_HEAD_V2_INSTRUCTIONS`/`VALID_CATEGORIES` in `src/classification-prompt.ts`),
so `head.json` and the head sha256 `5f12495d…` stay unchanged and the parity
gate (`checkHeadParity`, `src/laya-model-manifest.ts`) keeps passing without a
router change.

### 2. `continue` handling — owner decision 2026-11-15: variant B

r2 over-predicts `continue` (60 answers in shadow, 10 correct; confusion is
continue↔standard/code_complex). Two variants were on the table:

- **A: downweight, keep the class.** `continue` rows get repeat 1 (same as
  teacher rows) while other owner rows get 5×/3×. The class stays (the
  router's `inheritPreviousCategory` and the ≤4-word momentum rule still use
  it), but the model learns it is the rare case.
- **B (CHOSEN by the owner, 2026-11-15): model `continue` as an inherit
  signal.** Relabel every training `continue` whose `prev` exists to the
  *resolved* category (the category `continue` would inherit), and drop
  `continue` rows without `prev`. The model learns "this continues act X" as
  "X" — which combines the owner's label with the context the router actually
  acts on, instead of teaching a class the router immediately rewrites.

Known risk of B, accepted by the owner: short go-aheads without a stored
`prev` lose their training label entirely. The router's deterministic
momentum rule still catches ≤4-word prompts at runtime, so those are routed
correctly anyway; they are just absent from training. A remains the fallback
if B fails gate G2.

Both variants keep the 7-class head (parity gate unchanged).

### 3. Calibration on held-out data (fixes the confidence number)

laya-train already carves a `calibration_slice` (r2: 227 items from the
training pool). For r3: fit the choice `temperature` (and the histogram
binning map, issue #871 hook in `laya-sidecar/src/laya/agent.ts`) **on that
calibration slice only**, then report ECE (expected calibration error) on
golden `test` alongside accuracy. The served `rl_agent_config.json` carries
the fitted values. This makes `confidence` mean something, so the owner can
set `integrations.laya.confidence_threshold` to a real gate (default proposal:
the confidence at which held-out precision ≥ 0.8, measured — not 0.8 by fiat;
with 7 classes p90 of raw max-prob is only ~0.79).

### 4. Pre-registered gate (decided BEFORE the r3 run, evaluated once on golden `test`)

Extending the R1–R4 scheme of `2026-10-15-laya-shadow-evaluation.md`
(`shadow_eval/evaluate_shadow.py` constants):

| Rule | Threshold | r2 measured |
|---|---|---|
| G1 group accuracy on golden test ≥ teacher level | ≥ 53.4 % | 43.2 % |
| G2 continue recall on golden test | ≥ 60 % (old R3) | 27.8 % (shadow) |
| G3 ECE on golden test | ≤ 0.10 | not measured |
| G4 live shadow re-run (≥150 labeled items) group accuracy | ≥ 30.5 % (majority baseline) and ≥ r2's 22.8 % | 22.8 % |

If r3 fails G1–G3, r2 stays the served artifact; r3 is kept for analysis only.
G4 alone is not sufficient (live labels are selected). Sign test for paired
shadow items as in R2 (alpha 0.05, one-sided).

### 5. Artifact and rollout (only if the gate passes)

1. Package `runs/r3` → `~/.laya-ft/artifacts/r3-1.0.0/release/` with the same
   file set as r2 (`encoder.onnx(.data)`, `head.onnx(.data)`, `head.json`,
   `tokenizer.json`, `rl_agent_config.json` with fitted temperature,
   `LICENSE`, `NOTICE`); head.json unchanged → head sha unchanged.
2. New manifest entry `router@1.1.0` (tag `laya-router-v1.1.0`,
   `published: false`) in `laya-models/manifest.json`; parity tests
   (`laya-sidecar/test/parity*.test.mjs`, `test/laya-model-manifest.test.ts`)
   must pass unmodified.
3. Local swap for the owner: install record under
   `~/.pi/agent/laya-models/router/1.1.0/` (or point the sidecar's
   `--model-dir` at the r3 release dir), sidecar restart, `/health` head sha
   must still read `5f12495d…`.
4. Publish (GitHub Release assets, manifest flip) is a separate owner
   decision (AGENTS §1).

## Decisions

1. **`continue` variant: B (inherit-relabel).** Owner decision 2026-11-15,
   recorded in the session ("Ich find B … am besten geeignet"). A stays the
   fallback if B fails gate G2.

## Open decisions (owner)

1. Owner-row weight for shadow labels: 5× (proposed) or higher — laya-train
   repeats rows, so this is coarse; the corpus stats print the resulting
   distribution for review before training.
2. Gate thresholds G1–G4: accept as proposed, or tighten G1 to ≥ 60 %.
3. Whether r3 training uses only MPS locally (as r2, ~5 h) or also a cloud
   GPU run — cost decision.

## Verified against

- Repo HEAD `49536f1` (2026-11-15): `LAYA_HEAD_V2_INSTRUCTIONS` /
  `VALID_CATEGORIES` at `src/classification-prompt.ts:178`, parity gate at
  `src/laya-model-manifest.ts:130-140`, manifest `laya-models/manifest.json`
  (`router@1.0.0`, `published: false`, head `5f12495d…`).
- `~/.laya-ft` on 2026-11-15, measured: `data/golden.jsonl` 180 rows (test 92,
  dev 88, all with `owner_cat` and `truth_v2`); `data/shadow-eval/queue.jsonl`
  286 rows, `labels.jsonl` 281 rows, 281 labeled keys join the queue;
  `data/corpus_train_v2.jsonl` 2019 train rows; `to_laya_jsonl_v2.py`
  (`CATS`, `SHORT_INSTRUCTIONS`, `OWNER_REPEAT = 3`); `runs/r2/train.log`
  ("train items 2043, calibration items 227, eval items 227
  (calibration_slice), device mps, 3 epochs").
- r2 numbers from `docs/research/2026-11-12-laya-r2-owner-accuracy.md` (test
  43.2 % vs teachers 53.4 %, dev 95.3 % in-sample, shadow 22.8 % vs 30.5 %
  majority, continue recall 27.8 %, NO-GO for sole-classifier) and from a
  fresh pair analysis of `~/.pi/logs/classifier-decisions.jsonl` on
  2026-11-15 (90 laya/comparator pairs; group agreement 45.6 %; confidence
  p50/p90 = 0.53/0.79; agreement flat across confidence bands).
- Not checked: whether `laya-train` supports per-row weights natively (r2 used
  row repetition; assumed same for r3); current GPU availability.
