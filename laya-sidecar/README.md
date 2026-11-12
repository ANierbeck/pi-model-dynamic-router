# @anierbeck/laya-sidecar

Local HTTP sidecar that serves one installed Laya router model through ONNX
Runtime. The router (`integrations.laya`, see the repository README) calls it
on `POST /classify`; `GET /health` reports which model it serves.

The package is **not published yet**. It is released together with the router
2.0.0 (plan `docs/plans/2026-11-11-onnx-sidecar-package.md`, decision D8), and
the model weights (`laya-router-v1.0.0`) follow the same release. Until then the
commands below describe the installed package, not something `npm` can fetch.

## Platforms

| Platform                              | Status                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| macOS, Apple Silicon (darwin/arm64)   | **Tested.** The only platform the maintainer has run end to end.                                    |
| Linux x64 and arm64                   | Binaries are in the package. It should work; **it is not tested.**                                  |
| Windows x64 and arm64 (win32)         | Binaries are in the package. It should work; **it is not tested.**                                  |
| macOS, Intel (darwin/x64)             | **Not supported.** ONNX Runtime ships no darwin/x64 binding, and the MLX path is Apple Silicon only. |

Node.js 22.19.0 or newer is required (`engines`).

## Install

Set `ONNXRUNTIME_NODE_INSTALL=skip`. Without it, `onnxruntime-node` downloads
CUDA execution-provider libraries from NuGet while the package installs (on
Linux x64). The sidecar runs on the CPU provider and does not need them.

macOS and Linux:

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm install -g @anierbeck/laya-sidecar
```

Windows PowerShell:

```powershell
$env:ONNXRUNTIME_NODE_INSTALL = "skip"; npm install -g @anierbeck/laya-sidecar
```

## Start

The model directory is written by the router's installer,
`pi-laya-model install router@1.0.0 --backend onnx`, into the Pi agent
directory (`~/.pi/agent` by default):

```bash
laya-sidecar \
  --model-dir "$HOME/.pi/agent/laya-models/router/1.0.0" \
  --head-json "$HOME/.pi/agent/laya-models/router/1.0.0/head.json"
```

Options:

- `--port <n>`: default `8089`, which is the router's default endpoint, so the
  router needs no configuration change.
- `--head-json <file>`: the question head to serve. Without it the sidecar uses
  the head named in the install record; if neither exists it refuses to start.
  It never falls back to a built-in prompt.

Check what it serves:

```bash
curl -s http://127.0.0.1:8089/health
```

`head_sha256` and `artifact_sha256` must equal the values in the install record.
The router reads both fields from this answer; a mismatch means a different
model is being served.

## What the sidecar does not do

- It listens on `127.0.0.1` only.
- It makes no network calls and downloads nothing. A directory with missing
  files is refused before the runtime loads anything.
- It does not write the router's configuration and does not start itself.

## Parity and the reference server

`scripts/parity.mjs` compares a running sidecar with a stored reference
recorded from the MLX reference server (`spikes/laya-http/server.py`, Apple
Silicon). The gates are golden 180/180 and corpus at least 297/300 of the
300-item sample. `scripts/record-reference.mjs` records the reference.

## Licence

The sidecar's own code is MIT, like the repository (see `LICENSE`). The vendored
inference code in `src/laya/` is from `laya-ts` (upstream commit `3a38cbe`,
tag `v0.4.31`) under Apache-2.0; see `LICENSE-laya` and the provenance header
of each vendored file.
