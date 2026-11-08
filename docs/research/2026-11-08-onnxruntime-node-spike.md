# ONNX Runtime Node spike: can `onnxruntime-node` replace the Python sidecar?

**Date:** 2026-11-08 (one afternoon, Apple Silicon M3 Max, 14 cores)
**Answers open decision 4 of `docs/plans/2026-10-31-laya-sidecar-distribution.md`**
(is a Python runtime acceptable as a user requirement, or does in-process
`onnxruntime-node` remove it?).
**Scope:** spike only — no repo code changed, all artifacts stayed in `/tmp`.
The fine-tuned checkpoint `r2` and the corpus/golden material are local
(`~/.laya-ft`); the corpus sample used for latency/parity is mode 600 and was
never copied into the repo.

## Setup

- Upstream Laya checkout `~/.laya-ft/upstream-laya` at `6880462` (release
  0.4.2), which ships `laya-ts` (TypeScript inference on split ONNX:
  `encoder.onnx` + `head.onnx`, `onnxruntime-node` as an optional dependency)
  and `laya-ts/scripts/export_onnx.py` (torch.export-based, verifies torch vs
  ONNX within 1e-4 at two sequence lengths before writing anything).
- Export of `~/.laya-ft/runs/r2`: `python laya-ts/scripts/export_onnx.py
  --model-dir ~/.laya-ft/runs/r2 --out-dir model-r2` in a throwaway venv
  (torch 2.15.0, onnx 1.23.2, onnxruntime 1.31.1, transformers 5.22.2,
  onnxscript). Took 29 s. Verification passed (logits max diff 1.7e-06).
- Artifacts: `encoder.onnx` + `encoder.onnx.data` 1.23 GB, `head.onnx` +
  `head.onnx.data` 60 MB, `tokenizer.json` 34 MB, `rl_agent_config.json`
  (fp32, external data).
- Runner: `laya-ts` built with `npm install && tsc -p tsconfig.json`
  (TypeScript 7), `onnxruntime-node` 1.30.0, Node v26.11.1. The runner
  mirrors the production state layout of `spikes/laya-http/server.py`
  (context header + `Current request: "<prompt>"`) and serves the trained
  head (`~/.laya-ft/data/laya_head_v2.json`), so train/serve parity holds.
- Reference: the live MLX sidecar on port 8089 (same `r2`, same head), called
  over HTTP exactly as the router calls it.

## Results

### Parity vs the MLX sidecar (the plan's parity gate, golden part)

**Golden set (180 owner-rated items):**

- Argmax agreement MLX vs ONNX: **180/180 (100 %)**.
- Accuracy vs owner labels on the 169 in-taxonomy items (11 `fallback`
  items are pre-v2-r3 and out of scope for both): MLX 90/169 (53.3 %),
  ONNX 90/169 (53.3 %) — identical, as expected from identical argmax.
- Confidence drift > 0.05: 2 of 180 items (0.38→0.45, 0.71→0.81); both keep
  the same argmax.

**Corpus sample (300 items, median 123 chars, capped at 2500):**

- Argmax agreement: **297/300 (99.0 %)**. The 3 disagreements are all
  low-confidence prompts (0.22–0.35) near category boundaries
  (`code_complex`↔`code_simple`/`continue`, `simple`→`continue`); the MLX
  reference is equally unsure on them.
- Max per-category probability delta: median 0.0007, p95 0.0236,
  max 0.156 (on a disagreement item).

The corpus-sample disagreement is consistent with bf16 (MLX) vs fp32
(ONNX) numeric drift on near-ties, not with a conversion defect: the golden
set shows zero disagreements, and the export script's own torch-vs-ONNX
verification passed at 1e-4.

### Latency (single item, sequential, process warm)

| Configuration | p50 | p90 | p99 | max |
|---|---|---|---|---|
| ONNX fp32, default threads (all cores) | 167 ms | 620 ms | 778 ms | 794 ms |
| ONNX fp32, intraOp 1 thread | 846 ms | 3112 ms | 3811 ms | 4130 ms |
| ONNX fp32, intraOp 2 threads | 436 ms | 1626 ms | 1971 ms | 1992 ms |
| ONNX fp32, intraOp 4 threads | 236 ms | 881 ms | 1068 ms | 1207 ms |
| MLX sidecar (same window, HTTP) | 46 ms | 606 ms | — | 2117 ms |

- Model load (encoder + head, from local disk): 0.8–2.7 s; RSS ~1.5 GB
  (fp32), ~1.1 GB (int8).
- The long tail comes from prompt length (up to 2500 chars ≈ 600+ tokens
  through a 1024-window mmBERT); short prompts are far below p50.
- **`numThreads` finding:** `laya-ts`'s `numThreads` option only sets
  `ort.env.numThreads` (the thread-pool size for JS-side ops), which had no
  measurable effect. The actual lever is the session option
  `intraOpNumThreads` on `InferenceSession.create`, which `laya-ts` does not
  expose (measured via a local patch of the built `dist/providers.js`).
  Upstream contribution candidate; for the sidecar use case the default
  (all cores) is fine — 4 threads already meet the 1500 ms router timeout
  with the p99 at ~1.1 s on this machine.

### int8 dynamic quantization: not usable

`quantize_dynamic` (MatMul only, QInt8, per_channel=False — the exact recipe
of upstream `scripts/export_onnx.py`, which warns about accuracy drift):

- Argmax agreement vs MLX: **207/300 (69 %)** — far past any parity gate.
- Confidence is destroyed: high-confidence MLX decisions (0.74–0.97) come
  back at 0.24–0.38; median probability delta 0.20.
- Latency gain is modest (p50 129 ms vs 167 ms) and size only drops from
  1.29 GB to 0.97 GB (the head stays fp32; the tokenizer is unchanged).

Confirms the upstream warning for this checkpoint: int8 is off the table
without QAT/SmoothQuant work. fp16 was parked after three conversion
attempts (see below).

### fp16: parked, with the root cause written down

`onnxconverter-common`'s `convert_float_to_float16(keep_io_types=True)`
leaves the graph unloadable on this export. Chain of causes, for whoever
picks it up:

1. The torch export keeps a float32 branch off the int64 position ids
   (`Cast → _to_copy_2`, rotary embedding copy) that multiplies with
   converted fp16 weights → "Type parameter (T) of Optype (Mul) bound to
   different types" at session load.
2. The exported graph carries stale fp32 `value_info` declarations; any
   shape-inference-based repair must delete `graph.value_info` first, or it
   reads phantom types (this also breaks `quantize_dynamic` unless cleared —
   upstream's own script does `del model.graph.value_info[:]` for exactly
   this reason).
3. Inserting Cast nodes for the mixed operands works mechanically, but the
   fp32 sources include graph inputs and initializer-derived values that
   shape inference does not fully type, so the repair needs a complete type
   pass, not a spot fix.

Benefit would be download size only (613 MB vs 1.23 GB; CPU computes fp32
anyway, so no latency win). Not worth the fragility now; revisit only if
weight size matters for packaging, ideally by exporting from an fp16-cast
torch model instead of post-converting.

## What this answers

1. **Parity gate (plan step):** conversion of `r2` exists and the golden-set
   parity run is through — 100 % argmax, confidence drift ≤ 0.10 on 2/180.
   The corpus-sample run (99 %) covers the queue-like material; the live
   queue parity run is still open until the queue has enough items.
2. **Open decision 4:** Python is NOT a hard runtime requirement for
   inference. `onnxruntime-node` runs `r2` in-process on CPU at p50 167 ms /
   p99 < 800 ms (default threads, this machine), well inside the 1500 ms
   router timeout, with 1.5 GB RSS and a 290 MB native dependency. The
   tradeoff shifts from "users need Python" to "the shipped extension needs
   a native dependency" (AGENTS.md §10 attack surface) plus 1.29 GB of
   weights — and the export step still needs Python once per checkpoint
   (or a pre-converted artifact shipped with pinned checksums, which the
   packaging step plans anyway).
3. **Linux/Windows latency:** still unmeasured (plan step open). CPU fp32
   ONNX is architecture-portable in principle; the numbers above are Apple
   Silicon and cannot stand in for x86 servers or Windows laptops.

## Verdict

The spike says: **the portable backend is viable**. fp32 ONNX through
`onnxruntime-node` meets the parity gate on the golden set and comfortably
meets the latency budget on this machine; int8 is ruled out; fp16 is parked.
The remaining plan steps (packaging, pinned revision + checksum, /health
contract, per-platform latency, install docs) are unaffected by this result
and still open.

## Reproduction sketch (all throwaway, nothing shipped)

```bash
# export (venv with torch, onnx, onnxscript, onnxruntime, transformers)
python laya-ts/scripts/export_onnx.py \
  --model-dir ~/.laya-ft/runs/r2 --out-dir /tmp/spike/model-r2
# runner (laya-ts built, onnxruntime-node installed)
node run_node.mjs /tmp/spike/model-r2 out.json     # feeds the trained head,
# mirrors server.py's state layout, writes per-item category/confidence/ms
# reference: the live MLX sidecar over POST /classify, same items
```
