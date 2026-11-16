# Laya sidecar ships in the router tarball; the ONNX runtime is installed on demand

**Status:** in progress 2026-11-16 — owner decisions D1–D2 made the same day; implementation on branch `feat/sidecar-in-tarball`.

**Supersedes:** decisions D1 and D8 of `docs/plans/2026-11-11-onnx-sidecar-package.md` (own npm package `@anierbeck/laya-sidecar`, own release line) and "owner decision 3" of 2026-11-08 quoted there (the sidecar stays out of the router's `files` allowlist). Everything else in that plan stands: the vendored `laya-ts` copy (D2), the pinned runtime version (D3), no CUDA download (D4), the platform matrix (D5/D6), the model name (D7).
**Related:** `docs/plans/2026-11-16-release-rehearsal.md` verifies the delivery this plan builds.

## Problem

A 2.0.0 release needs three artifacts that only work together, and two of them are separate npm publishes that cannot be taken back:

1. The router package, with the installer `pi-laya-model` and the manifest.
2. The sidecar package `@anierbeck/laya-sidecar`. It is `private: true` and was never published; nothing proves that the published form installs and starts.
3. The weights, as GitHub Release assets.

For the user this means a second global install with an environment variable they must not forget (`ONNXRUNTIME_NODE_INSTALL=skip npm install -g @anierbeck/laya-sidecar`), and a start command with two long absolute paths. For the release it means two version lines that have to match, and a second irreversible publish. A mismatch is found by users, after the fact.

## Solution

One package. The sidecar code ships inside the router tarball; the 308 MB native runtime does not, and is installed by the user's explicit command, the same way the weights already are.

1. **The sidecar is a build output of the router.** `npm run build` bundles `laya-sidecar/src/server.ts` to `dist/laya-sidecar.js` (esbuild, ESM). The file joins the `files` allowlist and `BUILD_OUTPUTS` in `test/package-contents.test.ts`. `laya-sidecar/` stays the place where the sidecar source, its tests and the parity runner live; it stops being a publishable package (no `bin`, no `files`, `private: true` for good).
2. **The runtime is installed on demand, pinned and verified.** New command `pi-laya-model runtime install`. It copies the shipped `laya-sidecar/package.json` and `laya-sidecar/package-lock.json` to `<Pi agent dir>/laya-runtime/` and runs `npm ci --omit=dev --ignore-scripts` there. The lockfile's `integrity` hashes make npm verify every tarball; `--ignore-scripts` means the `onnxruntime-node` postinstall (the unverified CUDA download on Linux x64, research note of 2026-11-11, section 2) never runs at all. `runtime verify` checks the installed version against the shipped pin and that the native binding for this platform exists; `runtime remove` deletes the directory. One lockfile is the single source for development, CI and the user's install.
3. **The sidecar finds the runtime without a change to the vendored code.** The vendored `providers.ts` loads `onnxruntime-node` with a bare dynamic `import()`, which resolves relative to the bundle. `serve()` registers a `module.registerHooks` resolve hook that anchors exactly that specifier at the runtime directory. `registerHooks` exists at the `engines` minimum (Node 22.19.0, checked). A missing or outdated runtime ends with one line naming `pi-laya-model runtime install`, before any model file is read.
4. **One start command.** `pi-laya-model serve <model>@<version> [--port 8089]` resolves the install directory, its head file and the runtime directory, and runs the sidecar in the foreground of the user's terminal. The router still never starts a process, and the install skill still never starts one; the user does.
5. **Unsupported platforms fail before the download.** `runtime install` refuses darwin/x64 (no binding in the package, D6 of the 2026-11-11 plan) with that reason, instead of downloading 115 MB first.
6. **Docs follow.** Skill step 8, `laya-sidecar/README.md`, the README's Laya section, CHANGELOG and the release entries in `TODO.md` drop the separate package; the 2026-11-11 plan gets a "partly superseded" header and is otherwise left as history (AGENTS.md §11).

## Decisions (owner, 2026-11-16)

**D1 — The sidecar is part of the router tarball.** No `@anierbeck/laya-sidecar` package, no `laya-sidecar-v*` release line.

**D2 — The ONNX runtime is installed on demand by the installer**, not as a dependency of the router (every router user would download 115 MB and, on Linux x64, run the unverified postinstall) and not as an optional peer dependency (a manual install step next to Pi's package directory).

## Open decisions

None.

## Verified against

- `main` @ `20e6668` (2026-11-16): `package.json` (`files`, `bin`, `build`), `laya-sidecar/package.json` (`private: true`, `bin`, `onnxruntime-node` 1.31.1), `laya-sidecar/src/server.ts`, `laya-sidecar/src/laya/providers.ts` (`createNodeProvider`, the computed `import()`), `src/laya-model-install.ts` (CLI, `--manifest`, `--root`), `test/package-contents.test.ts`, `.github/workflows/test.yml`, `skills/router-laya-install/SKILL.md` step 0 and step 8.
- Measured 2026-11-16: a `registerHooks` resolve hook redirects the computed `import('onnxruntime-node')` from a file outside the dependency tree to `laya-sidecar/node_modules` (Node 26.11.1, darwin/arm64: without the hook `ERR_MODULE_NOT_FOUND`, with it `InferenceSession` is a function). `module.registerHooks` is a function in `node:22.19.0-bookworm-slim` (linux/arm64).
- Measured 2026-11-15: `pi-laya-model install` against a locally served copy of the release directory, `verify`, the sidecar started from the installed directory, `/health` identity equal to the manifest, one `/classify` answer (darwin/arm64).

**Not checked:** `onnxruntime-node` installed with `--ignore-scripts` on Linux x64 or Windows (the release rehearsal covers linux/arm64; the others stay "should work, not tested" as in D5 of the 2026-11-11 plan); whether `pi update --extensions` keeps the `bin` links of an updated package current.

## Steps

- [ ] Step 1: `serve()` in `laya-sidecar/src/server.ts` with `runtimeDir`; resolve hook; clear error without a runtime. Red first.
- [ ] Step 2: `pi-laya-model runtime install | verify | remove` (`src/laya-runtime-install.ts`), with an injectable process runner so the unit tests never touch the network. Red first.
- [ ] Step 3: `pi-laya-model serve <model>@<version>`. Red first.
- [ ] Step 4: build output `dist/laya-sidecar.js`, `files` allowlist, `test/package-contents.test.ts`, sidecar `package-shape` test (no `bin`, never publishable).
- [ ] Step 5: docs — skill step 8 and its test, both READMEs, CHANGELOG, `TODO.md`, the header on the 2026-11-11 plan, the plan index.
- [ ] Step 6: the release rehearsal (related plan) passes on darwin/arm64 and in the linux/arm64 container.
