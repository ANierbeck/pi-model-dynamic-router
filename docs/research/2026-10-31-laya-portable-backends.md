# Portable Laya backends: what third parties report — 2026-10-31

Question: can the Laya classifier run on every platform, not only on Apple
Silicon (MLX)? Input for `docs/plans/2026-10-31-laya-sidecar-distribution.md`.

**Nothing below was measured by us.** Every figure is copied from a public
model card or README seen on 2026-10-31; none was reproduced, and none covers
our fine-tuned weights (`~/.laya-ft/runs/r2`) or our taxonomy.

## Findings (as reported)

| Item | Reported | Source |
|---|---|---|
| Base model | `convaiinnovations/laya-multilingual`, mmBERT-base encoder (307M) + decision head, 322M parameters, 1,024-token context, Apache-2.0 | model card, huggingface.co/convaiinnovations/laya-multilingual |
| GPU speed | 103–332 questions/s batched on one T4 | same model card |
| MLX port | independent (not official) port, `laya-mlx` 0.4.0 on PyPI; inference and conversion only, no training | pypi.org/project/laya-mlx |
| ONNX (CPU) | community conversion, `model_fp32.onnx` and weight-only `model_int8.onnx` (~0.5 GB) | huggingface.co/yehor-oleksiuk/laya-multilingual-onnx (README) |
| ONNX latency | fp32 ~169 ms single thread, ~64 ms with 4 threads on a 4-CPU cloud box, batch 1; int8 ~15 % faster | same README |
| ONNX parity | int8 argmax agreement with fp32 100 % on a 120-sample Russian set | same README |
| Calibration | same README: raw probabilities are miscalibrated (high ECE); recalibrate before thresholding | same README |
| GGUF | Q4_K_M 524 MB, Q8_0 362 MB, F16 663 MB, built with ggmlc (not llama.cpp) | huggingface.co/mys/laya-multilingual-GGUF |

## What this does and does not support

- A CPU backend exists in public and its reported latency (~64 ms, 4 threads)
  is far below the router's 1,500 ms timeout.
- The parity figure is for a different model (the base weights) and a
  different language set (Russian). It says nothing about whether an ONNX
  export of **our** fine-tuned weights gives the same answers.
- The calibration remark matters for us: the router's confidence handling
  (`classifier_laya.confidence_threshold`) would need to be re-checked on any
  new backend.

Open: the parity run and the latency measurement on Linux and Windows are
steps of the plan, to be recorded here when done.
