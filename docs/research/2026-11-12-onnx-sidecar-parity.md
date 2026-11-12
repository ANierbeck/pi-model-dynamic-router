# ONNX sidecar parity against the MLX reference (2026-11-12)

Measurement for plan `docs/plans/2026-11-11-onnx-sidecar-package.md`, step 2.
Recorded by `laya-sidecar/scripts/record-reference.mjs` and checked by
`laya-sidecar/scripts/parity.mjs`. The item files and reference outputs live
outside the repository (`~/.laya-ft/data/parity/`, mode 600): they contain
prompts from the owner's own sessions.

## Setup

- Reference: MLX reference server `spikes/laya-http/server.py` on port 8089,
  head `5f12495d95d8` (`head_sha256`), model directory `~/.laya-ft/runs/r2`.
- Candidate: `laya-sidecar` (vendored `laya-ts` at `3a38cbe`, `onnxruntime-node`
  1.31.1), artifact set `~/.laya-ft/artifacts/r2-1.0.0/onnx`.
- Items: the 180 golden items, and a 300-item corpus sample drawn with a seeded
  PRNG (seed 20261112; prompts capped at 2500 characters as in the spike).
- Both sides receive the prompt after the production truncation rule
  `truncatePromptForLaya` (`src/laya-classifier.ts`), which the router applies
  before it calls the sidecar.
- `items_sha256` in the reference binds it to the exact items it was recorded on.

## Result

| Set            | Agreement (argmax) | Gate  | Max prob. delta | Confidence drift > 0.05 |
| -------------- | ------------------ | ----- | --------------- | ----------------------- |
| Golden (180)   | 180/180 (100 %)    | 100 % | 0.098           | 3                       |
| Corpus (300)   | 298/300 (99.3 %)   | 297   | 0.126           | 7                       |

The two corpus disagreements are `83e005f34d64e3fb` and `8df420525e9f1712`.
They pass the gate and are not analysed further here.

## Finding: the first run was wrong, not the sidecar

The first golden run without truncation gave 179/180. The one disagreement
(`b477fe963eff3720`, 2646 characters, an over-budget prompt) moved from
`design` 0.50 (MLX) to `planning` 0.46 (ONNX). Twelve of the 180 golden prompts
are longer than the production budget, so the parity harness had compared
different inputs. The router never sends those; it truncates first. With the
production truncation on both sides the result is 180/180.

## Checked and ruled out as the cause of that first gap

- MLX is deterministic: three repeated requests returned identical values.
- `laya-ts` at `6880462` (spike) and at `3a38cbe` (vendored): same result.
- `onnxruntime-node` 1.30.0 and 1.31.1: same result.
- A fresh ONNX export from `runs/r2` (`export_onnx.py`, opset 18, torch vs ONNX
  within 1e-6): same result; `encoder.onnx.data` of the shipped artifact is
  byte-identical to that export.

## Not checked

- Platforms other than darwin/arm64 (plan decision D5): no run.
- Latency on the candidate machine beyond the single 60-second sample run.
