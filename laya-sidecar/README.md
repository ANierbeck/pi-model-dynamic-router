# Laya sidecar (source)

Local HTTP sidecar that serves one installed Laya router model through ONNX
Runtime. The router (`integrations.laya`, see the repository README) calls it
on `POST /classify`; `GET /health` reports which model it serves.

**The sidecar ships inside the router package** (plan
`docs/plans/2026-11-16-laya-sidecar-in-router-tarball.md`, decision D1). There is
no `@anierbeck/laya-sidecar` package and no separate release line. This
directory is where the source, the tests and the parity runner live; the built
sidecar is `dist/laya-sidecar.js` in the router tarball, and its
`package.json` + `package-lock.json` are the spec that
`pi-laya-model runtime install` hands to `npm ci`.

The native ONNX runtime (about 115 MB) is **not** shipped. It is installed on
demand, next to the models:

```bash
pi-laya-model runtime install     # npm ci on the lockfile above, no install scripts
pi-laya-model runtime verify
pi-laya-model serve router@1.0.0  # listens on 127.0.0.1:8089
```

`runtime install` runs `npm ci --omit=dev --ignore-scripts` on the shipped
lockfile, so npm checks every tarball against its integrity hash and the
`onnxruntime-node` postinstall never runs (on Linux x64 that script downloads
CUDA libraries without a digest check; the CPU binding the sidecar uses is in
the npm tarball). `serve` resolves the install directory, the head file and the
runtime directory itself; `--port <n>` moves it off 8089.

For development in this directory: `npm ci && npm run build && npm test`, and
`npm run parity` against a stored reference (see `scripts/parity.mjs`).

## Platforms

| Platform                              | Status                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| macOS, Apple Silicon (darwin/arm64)   | **Tested.** The only platform the maintainer has run end to end.                                    |
| Linux x64 and arm64                   | Binaries are in the package. It should work; **it is not tested.**                                  |
| Windows x64 and arm64 (win32)         | Binaries are in the package. It should work; **it is not tested.**                                  |
| macOS, Intel (darwin/x64)             | **Not supported.** ONNX Runtime ships no darwin/x64 binding, and the MLX path is Apple Silicon only. |

Node.js 22.19.0 or newer is required (`engines` of the router package).

## Start

The model directory is written by the router's installer,
`pi-laya-model install router@1.0.0 --backend onnx`, into the Pi agent
directory (`~/.pi/agent` by default). `pi-laya-model serve` finds it, the head
file and the runtime on its own:

```bash
pi-laya-model serve router@1.0.0
```

Options:

- `--port <n>`: default `8089`, which is the router's default endpoint, so the
  router needs no configuration change.
- `--root <dir>`: a different install root.
- `--runtime-dir <dir>`: a different runtime directory (default
  `<Pi agent dir>/laya-runtime`).

The bundle can also be started directly, which is what `serve` does:

```bash
node dist/laya-sidecar.js \
  --model-dir "$HOME/.pi/agent/laya-models/router/1.0.0" \
  --head-json "$HOME/.pi/agent/laya-models/router/1.0.0/head.json" \
  --runtime-dir "$HOME/.pi/agent/laya-runtime"
```
- `--head-json <file>`: the question head to serve. Without it the sidecar uses
  the head named in the install record; if neither exists it refuses to start.
  It never falls back to a built-in prompt.

Check what it serves:

```bash
curl -s http://127.0.0.1:8089/health
```

Windows PowerShell (the model directory under the user profile):

```powershell
laya-sidecar `
  --model-dir "$env:USERPROFILE\.pi\agent\laya-models\router\1.0.0" `
  --head-json "$env:USERPROFILE\.pi\agent\laya-models\router\1.0.0\head.json"
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
Silicon). The gates are golden 180/180, corpus at least 297/300 of the
300-item sample, and the live queue 259/260 (2026-11-13; the single
disagreement is a planning/code_complex near-tie with a top-2 margin under
0.005 — `docs/research/2026-11-13-laya-live-queue-parity.md`).
`scripts/record-reference.mjs` records the reference.

## Licence

The sidecar's own code is MIT, like the repository (see `LICENSE`). The vendored
inference code in `src/laya/` is from `laya-ts` (upstream commit `3a38cbe`,
tag `v0.4.31`) under Apache-2.0; see `LICENSE-laya` and the provenance header
of each vendored file.
