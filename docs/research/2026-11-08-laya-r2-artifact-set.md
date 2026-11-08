# Laya r2 artifact set: file lists, metadata strip, install end to end

**Date:** 2026-11-08. **Plan:** [`2026-11-08-laya-model-artifact.md`](../plans/2026-11-08-laya-model-artifact.md).
**Builds on:** [`2026-11-08-onnxruntime-node-spike.md`](2026-11-08-onnxruntime-node-spike.md)
(the ONNX export and its golden-set parity).

## What was measured

The shipped manifest (`laya-models/manifest.json`) names the file sets of
`r2@1.0.0`. These checks back the values in it.

### 1. Minimal file sets

| Backend | Files | Bytes |
|---|---|---|
| onnx | `encoder.onnx`, `encoder.onnx.data`, `head.onnx`, `head.onnx.data`, `head.json`, `rl_agent_config.json`, `tokenizer.json` | 1 322 195 665 |
| mlx | `model.safetensors`, `questions.json`, `rl_agent_config.json`, `encoder/config.json`, `tokenizer/tokenizer.json`, `tokenizer/tokenizer_config.json` | 678 207 221 |

`rl_agent_config.json` and `tokenizer.json` are byte-identical in both sets and
share one release asset each. The training directory's `train_report.json`,
logs and the duplicate checkpoint copy are not part of either set.

- **MLX:** `laya_mlx.load()` on a directory with only the six files answers
  5 probe prompts with exactly the live sidecar's categories and confidences
  (5/5, identical to 3 decimals).
- **ONNX:** `laya-ts` `Agent.load()` on the seven files gives the same 5
  categories, confidence drift ≤ 0.001 against MLX (fp32 vs bf16, as in the
  spike).

### 2. The ONNX export embeds local paths — stripped

The torch exporter writes per-node source metadata (`metadata_props`, stack
traces) into the graph: `encoder.onnx` contained 1289 references to the
exporter script under the owner's home directory and several thousand to the
throwaway venv; `head.onnx` 267. Publishing those graphs would publish the
owner's home path.

Stripped with `onnx` (nodes, subgraphs, value infos, functions, graph and
model doc strings): 6744 + 904 metadata entries removed, then 0 path hits.
The external weight files (`*.onnx.data`) contained none and are untouched
(loaded with `load_external_data=False`, so their references stay the same).
Graph sizes: 2 467 344 → 166 947 bytes (encoder), 222 079 → 23 723 (head).

**Parity after the strip:** the full golden set (180 items) through the
stripped graphs against the spike's run on the original graphs: argmax
180/180, max |Δp| = **0** — bit-identical outputs.

Consequence for every future export: strip the metadata before hashing, or the
manifest pins a graph that must not be published. Upstream `export_onnx.py`
does not do this; a candidate for an upstream contribution, next to the
`intraOpNumThreads` finding in the spike report.

### 3. Head hash

`head.json` of the ONNX set is written from the checkpoint's own
`questions.json` as compact JSON `{"instructions":…,"categories":[…]}`. Its
sha256 `5f12495d…` equals `headSha256()` of the router's
`LAYA_HEAD_V2_INSTRUCTIONS` + `VALID_CATEGORIES` — r2 was trained on exactly
the head the router builds today. Pinned in `test/laya-model-manifest.test.ts`.

### 4. Install end to end

A flat release directory (one file per asset name, hard links into the two
sets; what a release upload will carry) served as `file://` base URL through a
local manifest override (`published: true`):

- `pi-laya-model install r2 --backend onnx` and `--backend mlx` from the built
  `dist/laya-model-install.js`: 2.2 s / 2.4 s (local disk; hashing included),
  `verify` ok for both.
- The model loaded **from the install directory**, both backends: the same 5/5
  answers as above.

## Not measured

- Download over a real GitHub release (redirect to the asset host, `Range`
  honoured or not): needs the release, which needs the owner's go (AGENTS.md §1).
- `pi-laya-model` on PATH: npm links a package `bin` only for a global or
  project install; whether Pi's package install exposes it was not checked
  (the skill can always call `node <package>/dist/laya-model-install.js`).

## Where the artifacts are

Durable copy outside the repository (owner's machine, private directory): the
two sets plus the flat release directory. The throwaway spike tree in `/tmp`
is no longer needed for the publish.
