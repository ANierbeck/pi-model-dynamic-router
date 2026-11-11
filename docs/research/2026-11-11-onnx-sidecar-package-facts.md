# ONNX sidecar package: facts measured before packaging

**Date:** 2026-11-11
**Feeds:** `docs/plans/2026-11-11-onnx-sidecar-package.md` (the plan decides; this note only measures)
**Repository state:** `main` @ `92a5eee`
**Method:** registry metadata (`npm view`), the published tarballs downloaded with `npm pack` into empty directories and read with `tar -t` / `tar -x` only. Nothing from the tarballs was executed. `npm audit` ran against a lockfile generated with `--ignore-scripts`.

## 1. `onnxruntime-node` tarballs

| version | tarball (compressed) | unpacked (registry) | licence | node engines |
|---|---|---|---|---|
| 1.30.0 (spike version) | 113.5 MB | — | MIT | none declared |
| 1.31.1 (latest stable) | 115.4 MB | 307.6 MB | MIT | none declared |

Native binding per platform, from the tarball listing (both versions identical in shape):

| platform | binding | ORT core | notes |
|---|---|---|---|
| darwin/arm64 | yes | `libonnxruntime.1.dylib` | the only macOS build |
| darwin/x64 | **no** | — | Intel Mac has no binary in the package |
| linux/x64 | yes | `libonnxruntime.so.1` | CUDA provider libs are **not** bundled |
| linux/arm64 | yes | `libonnxruntime.so.1` | |
| win32/x64 | yes | `onnxruntime.dll` + DirectML, dxcompiler, dxil | |
| win32/arm64 | yes | same DLL set | |

Musl (Alpine) is not listed anywhere in the package. Not tested here.

## 2. Install-time behaviour (`script/install.js`, `script/install-metadata.js`)

- `package.json` declares `"postinstall": "node ./script/install"`. The script runs on every install.
- `install-metadata.js` `requirements`:
  - `linux/x64: ['cuda12']` — **on Linux x86-64 the default install tries to fetch the CUDA execution-provider libraries** (`libonnxruntime_providers_cuda.so`, `…_shared.so`, `…_tensorrt.so`) from the NuGet package `Microsoft.ML.OnnxRuntime.Gpu.Linux` on `https://api.nuget.org/v3/index.json`, version pinned to `1.30.0` in `install-metadata-versions.js`. The same requirement is in 1.31.1.
  - all other platforms: `[]`, nothing to fetch.
- Skipping: `ONNXRUNTIME_NODE_INSTALL=skip` (or `npm_config_onnxruntime_node_install=skip`, or `--onnxruntime-node-install=skip`). `parseInstallFlag()` in `install-utils.js` reads them. With `skip` the script exits before any download (`install.js`, `INSTALL_FLAG === false`).
- **Integrity:** `install-utils.js` downloads the NuGet index, the package index and the `.nupkg`, then extracts it. A grep for `sha`, `hash`, `checksum`, `integrity` and `verify` in `install-utils.js` returned no hit. The download is not checked against a digest.
- The `nuget_nightly` feed (`aiinfra.pkgs.visualstudio.com`) is declared in `feeds`. Whether a package candidate ever references it was not traced.
- `global-agent` is bootstrapped at the top of `install.js` so that the download honours proxy variables. It is a declared dependency of the package. Whether the runtime `require`s it was **not** checked (only `install.js` was read).

Consequence for us: a sidecar that installs `onnxruntime-node` without the skip flag performs an unverified network download on Linux x64 at install time, and the CPU path does not need it.

## 3. `npm audit` on the dependency set

Lockfile generated for `onnxruntime-node@1.30.0` alone (`npm install --package-lock-only --ignore-scripts`):

- 17 packages in the tree: `onnxruntime-node`, `onnxruntime-common` 1.30.0, `adm-zip` 0.6.1, `global-agent` 4.1.7, `semver` 7.8.6 and their transitive dependencies.
- `npm audit`: **0 findings** (info/low/moderate/high/critical all 0) on 2026-11-11.
- `onnxruntime-node` carries `hasInstallScript`.

This is the registry advisory state today, not a guarantee. The plan makes `npm audit` a CI gate for the sidecar package.

## 4. `laya-ts` (upstream TypeScript inference)

- **Not on npm:** `npm view laya-ts` → 404. The sidecar cannot take it as a registry dependency.
- Upstream checkout `~/.laya-ft/upstream-laya` at `6880462` (`release: 0.4.2`, the Python package version). `laya-ts/package.json` says `version 0.1.0`, `license Apache-2.0`.
- Size: 5,691 lines of TypeScript in `laya-ts/src/` (agent, common, dx, email, hooks, lang, presets, providers, router, shortlist, structured, tokenizer). The only static external import is in `agent.ts`/`providers.ts` and points at node built-ins. `onnxruntime-node` is loaded with a dynamic `import()` inside `providers.ts` and declared as an optional dependency; `onnxruntime-web` is the browser path.
- `tokenizer.ts` is an own parser of the HuggingFace `tokenizer.json`. No tokenizer library is needed.
- `providers.ts` verifies the artifacts' digests before importing the native runtime (comment at line ~480).
- Licence: `LICENSE` is the Apache-2.0 text. A `NOTICE` file was not found in the checkout.

## 5. Model artifacts (`laya-models/manifest.json`, `r2@1.0.0`)

| backend | files | total bytes |
|---|---|---|
| onnx | 7 (`encoder.onnx` 0.17 MB, `encoder.onnx.data` 1,227.8 MB, `head.onnx` 0.02 MB, `head.onnx.data` 59.9 MB, `tokenizer.json` 34.4 MB, `head.json`, `rl_agent_config.json`) | 1,322,195,665 |
| mlx | 6 (`model.safetensors` 643.8 MB, tokenizer, configs) | 678,207,221 |

`published: false` — no GitHub Release asset exists yet, so an end-to-end install from the registry is not possible today. The sidecar can be tested against a local install directory.

## 6. Spike runner: not reproducible from the repo

`docs/research/2026-11-08-onnxruntime-node-spike.md` names `run_node.mjs` as the runner. On 2026-11-11 it was **not found** in `/tmp`, in `~/.laya-ft` or in the repository. The export script (`laya-ts/scripts/export_onnx.py`) exists upstream. The parity numbers (180/180, 297/300) therefore have no runnable script behind them yet. The plan rewrites the runner as a repository script before anything depends on it.

## 7. Reference sidecar contract (for the Node port)

`spikes/laya-http/server.py`:

- `POST /classify` with `{prompt, context?}` → `{category, confidence, probabilities, ms}`; the state is built as `Context (background only): …` plus `Current request: "<prompt>"`.
- `GET /health` → `{status, model?, version?, backend?, artifact_sha256?, head_sha256, served_head}`; computed by `spikes/laya-http/identity.py` (`head_sha256`, `artifact_sha256`).
- The TypeScript counterparts for the router side already exist: `headSha256` and `artifactSha256` in `src/laya-model-manifest.ts`. A Node sidecar can therefore share the hashing code with the router, and parity with `identity.py` is testable on the same install directory.

## What was not checked

- Any ONNX runtime on Linux, Windows or on musl. Only the file listings were read.
- Whether `global-agent` is loaded at runtime.
- Whether the `nuget_nightly` feed is ever used.
- An Intel Mac with a Python `onnxruntime` wheel (not looked at).
- Whether the upstream `laya-ts` at `6880462` is the exact code the spike ran; the spike notes say upstream checkout `6880462`, but the runner that loaded it is missing (section 6).
