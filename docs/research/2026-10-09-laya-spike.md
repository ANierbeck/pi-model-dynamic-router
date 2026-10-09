# Laya spike — first measurements (2026-10-09)

Branch `laya-spike`. Task 0 of `docs/plans/2026-10-05-laya-classifier-integration.md`,
MLX variant only (steps 0 and the measurement part of 3). Nothing here touches
router code; the wrapper lives in `spikes/laya-http/server.py` and speaks the
replay contract (`POST /classify {prompt} -> {category, confidence, ...}`).

## Pinned setup

| What | Value |
|---|---|
| Package | `laya-mlx==0.3.0` (+ `mlx==0.32.3`), Python 3.12 venv outside the repo |
| Checkpoint | `aac6fef/laya-multilingual-mlx`, revision `f2b4faf51023039425946074e2cf1361d2db11d5` (12 files, downloaded in 26 s) |
| Machine | Apple Silicon, macOS (Darwin 25.6) |

## Measured

| Metric | Result |
|---|---|
| Checkpoint load (warm disk cache) | 0.46 s |
| First `predict` after load | ~1.2 s (kernel compile); wrapper warms up at start |
| Round-trip via the HTTP wrapper, 120 real prompts | p50 12.2 ms, p95 49.8 ms, max 79.8 ms |
| Server-side predict | p50 11.5 ms, p95 49.0 ms (long prompts dominate p95) |
| Resident memory of the wrapper process | ~1.1 GiB RSS |
| Replay of the 383 unique router-era prompts, 4 workers | 9 s total, 0 endpoint errors |

The corpus is the router-fork project's session store since 2026-09-27
(2,785 user prompts, 383 unique at measurement time). 30 % of the unique
prompts exceed 1,500 characters (reviewer prompts, pasted logs); the
State-truncation boundary at 512 tokens was NOT characterized yet.

## What the replay can and cannot say

**There is no ground truth yet.** The session backfill has no recorded
decision of the known classifier (the decision log, ADR-0027, started
2026-10-09), so "0 % agree" in the replay report is an artifact, not a
result. Quality numbers need either (a) decision-log records with
`store_text: "full"` collected over a few days, or (b) a labeled golden set.

## Observations (anecdotal where stated)

1. **The model sees only the `criteria` labels and the `instructions`
   string.** The first wrapper kept per-category descriptions in a dict that
   never reached the model — a spike-design trap worth remembering for any
   adapter.
2. **Prompt design moves the distribution a lot.** Same 383 prompts:
   - labels only (variant A): simple 167, code_simple 96, fallback 63,
     exploration 23, trivial 17, design 9, planning 7, standard 1, code_complex **0**;
   - descriptions in `instructions` (variant B): fallback 109, simple 88,
     trivial 60, exploration 59, code_simple 35, design 13, planning 10,
     standard 5, code_complex 4.
   Neither is "right" — without labels the shift cannot be scored.
3. **Confidence is high only on semantically distinct classes.** On 8 hand
   probes (anecdotal), design/planning/exploration reached 0.89–0.98 in
   variant B while the complexity axis (trivial/simple/code_simple/
   code_complex) stayed at 0.3–0.6. On the full corpus (variant B) only
   **9.4 %** of prompts reach confidence >= 0.8 (36 of 383; exploration 17,
   fallback 9, planning 5, trivial 2, design 2, standard 1); median
   confidence 0.42. The complexity axis is exactly what drives routing cost.
4. **Consequence for the integration design (hypothesis, not a result):**
   a confidence gate of 0.8 in front of the cloud chain would let Laya
   handle roughly a tenth of the traffic; whether those answers are correct
   is unmeasured. The 9 `fallback` answers at >= 0.8 deserve an eyeball
   (long inputs?).

## Next measurements (need data, not code)

1. Let the decision log collect `store_text: "full"` records for a few days,
   then re-run `scripts/classifier-replay.ts --records ... --endpoint ...`:
   first real agreement rate, per-category confusion, agreement among the
   >= 0.8 subset.
2. Characterize truncation: prompts > 512 tokens, start vs end of State.
3. Prompt-design sweep (label vocabulary, instruction wording, multilingual
   prompts) scored against the golden set, not by eye.
4. Plan Task 0 steps 1-5 still open: upstream PyTorch `laya`, `laya-serve`,
   in-process ONNX numbers, and the process-management comparison
   (launchd / extension-spawned / manual).
