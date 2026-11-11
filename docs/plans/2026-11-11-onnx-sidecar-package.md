# ONNX sidecar package: an installable Laya sidecar for Linux, Windows and macOS

**Status:** approved 2026-11-11 — owner decisions D1–D8 taken (see Decisions). Build not started. Done means built, tested and documented, not published: the sidecar is released together with the router's 2.0.0 release, on the owner's release-specific go (AGENTS.md §1).

**Parent:** `docs/plans/2026-10-31-laya-sidecar-distribution.md`, open step "Packaging, pinned revision, checksum, install docs per platform". This plan is that one step, and nothing else from the parent.
**Related:** `docs/plans/2026-11-08-laya-model-artifact.md` (manifest, installer and `/health` are done there; this plan consumes them). Measurements: `docs/research/2026-11-11-onnx-sidecar-package-facts.md`.

## Problem

The installer and the install skill default to the ONNX backend, the only one that works outside Apple Silicon. Nothing runs it:

1. **No sidecar exists for ONNX.** The only HTTP server is `spikes/laya-http/server.py` (MLX, "throwaway spike", Apple Silicon only). A user on Linux, Windows or an Intel Mac cannot run Laya at all.
2. **The package we would build on is not safe to install as it is.** `onnxruntime-node` runs a `postinstall` script. On Linux x86-64 that script downloads CUDA execution-provider libraries from NuGet at install time, with no digest check, although the CPU path needs none of them. It is skipped only with `ONNXRUNTIME_NODE_INSTALL=skip` (research note, section 2). AGENTS.md §10 asks for the smallest attack surface, so the install path must not do this silently.
3. **The platform matrix has a hole.** `onnxruntime-node` ships no darwin/x64 binding in 1.30.0 or 1.31.1. An Intel Mac has no ONNX path through Node. The skill currently tells Intel users "onnx only", which they cannot run.
4. **The parity result is not reproducible.** The spike's runner (`run_node.mjs`) is not in the repository, not in `/tmp`, and not in `~/.laya-ft`. The 180/180 golden-set agreement therefore has no script behind it. Also, `laya-ts` is not on npm (404), so the sidecar cannot take it as a dependency.

## Solution

One Node sidecar package that serves the ONNX artifacts of a `pi-laya-model install` directory, built and tested in this repository, with its own release line. The router package stays dependency-free.

1. **Location and package:** a subdirectory `laya-sidecar/` with its own `package.json`, its own lockfile and its own version. Not in the router's `files` allowlist, so `test/package-contents.test.ts` keeps the router package free of it. (Owner decision 3, 2026-11-08.)
2. **Repeatable parity first.** Rewrite the runner as `laya-sidecar/scripts/parity.mjs`: it runs the golden set and the corpus sample through the ONNX sidecar and compares with a stored MLX reference output. Red first: the script fails when the stored reference is missing or the argmax differs. Acceptance: the same bar as the spike — golden set 180/180 and corpus sample at or above 297/300 against the MLX reference — but measured on the copied upstream code (D2).
3. **Pinned dependency, no install hook of our own.** `onnxruntime-node` pinned to exactly 1.31.1 (D3), with a committed lockfile. The sidecar package has no `postinstall` of its own.
4. **Skip the CUDA download, and prove it.** The install instructions set `ONNXRUNTIME_NODE_INSTALL=skip`. Red-first CI test: with `GLOBAL_AGENT_HTTPS_PROXY` pointing at a closed port, `npm install` without the flag must fail (proof that the download path exists), and with the flag it must succeed and CPU inference must run. This pins the install behaviour for the next version bump.
5. **Copy the needed part of `laya-ts`** (D2): the Node path (`agent`, `tokenizer`, the ONNX provider, what `predict` needs) from the latest upstream release into `laya-sidecar/src/laya/`, with the Apache-2.0 `LICENSE` and a header naming the upstream commit. No `onnxruntime-web` (browser only).
6. **Identity:** `GET /health` returns the same fields as `spikes/laya-http/identity.py`. `head_sha256` and `artifact_sha256` are computed with the TypeScript helpers that the router already uses (`src/laya-model-manifest.ts`). Red-first cross-language test: the sidecar and `identity.py` must return identical hashes for the same install directory.
7. **Input:** the sidecar reads an install directory `~/.pi/agent/laya-models/<model>/<version>/` written by `pi-laya-model install --backend onnx`. It never downloads anything (the same rule as the router, ADR-0021).
8. **Platform matrix in the docs, not in a claim:** darwin/arm64 tested; linux/x64, linux/arm64, win32/x64, win32/arm64 "should work, not tested" (D5); darwin/x64 not supported (D6).
9. **Skill and installer follow the sidecar:** `skills/router-laya-install/SKILL.md` step 8 replaces "not packaged yet" with the install command and the start command, and tells Intel Mac users that Laya is not supported there (D6). `test/laya-install-skill.test.ts` pins the new text, red first.
10. **Release line:** tags `laya-sidecar-v<version>`, released together with the router (D1/D8). Publishing to npm and creating the GitHub Release are release actions (AGENTS.md §1) and are **not** part of this plan's done state. The plan is done when the package builds, its tests and `npm audit` are green in CI, and the docs describe the install.

## Decisions (owner, 2026-11-11)

**D1 — Package name and channel: DECIDED.** Scoped npm package `@anierbeck/laya-sidecar`, tags `laya-sidecar-v<version>`. Prepared now, released only **together with the router release** ("the two belong together"); both need the owner's release-specific go.

**D2 — How the inference code gets in: DECIDED, copy the latest upstream.** The Node path of upstream `laya-ts` is copied into this repository from the **latest upstream release** at build time (on 2026-11-11: `v0.4.31`, commit `3a38cbe`), with its Apache-2.0 licence and a header naming the upstream commit. Our fine-tuned model sits on top as a separate model directory; nothing is submitted to the Laya project. Reason: `laya-ts` is still not on npm (404 on 2026-11-11), and npm cannot install a subdirectory of a git repository. Consequence: upstream changed the tokenizer, the state-text budgets and the ONNX export since the spike (`6880462` → `3a38cbe`, research note), so the spike's parity result does not carry over; the parity runner (step 2) has to confirm it on the copied code. Updating the copy is a deliberate step: new commit in the header, parity run green.

**D3 — `onnxruntime-node`: DECIDED, 1.31.1** (latest stable on 2026-11-11, and the version upstream `laya-ts` now declares). Pinned exactly, committed lockfile.

**D4 — CUDA download: DECIDED.** The install command documents `ONNXRUNTIME_NODE_INSTALL=skip`; the CI test of step 4 pins the behaviour.

**D5 — Non-Apple platforms: DECIDED, no smoke runs.** The owner has no Linux or Windows machine. The docs say: binaries for linux/x64, linux/arm64, win32/x64 and win32/arm64 are in the package, it should work, **it is not tested**. Only darwin/arm64 is tested. The CI job on `ubuntu-latest` runs the unit and contract tests (no model), which is a build check, not a platform test.

**D6 — Intel Macs: DECIDED, not supported.** No ONNX binding for darwin/x64, MLX is Apple Silicon only, and local models only run well on Apple Silicon anyway. The skill and the docs say so; no Python fallback is pursued.

**D7 — Model name: DECIDED, `router`.** Tag `laya-router-v1.0.0`, log label `laya:router@1.0.0`, install path `laya-models/router/1.0.0/`. The rename of the existing `r2@1.0.0` entry and the release preparation of the weights belong to `docs/plans/2026-11-08-laya-model-artifact.md` (one problem per plan); this plan only uses the name.

**D8 — Release timing: DECIDED as part of D1.** Sidecar, weights (`laya-router-v1.0.0`) and the router 2.0.0 are released together. Each publish is still its own release action with an explicit go.

## Verified against

- `main` @ `92a5eee` (2026-11-11): `laya-models/manifest.json` (r2@1.0.0, `published: false`), `package.json` `files` allowlist, `spikes/laya-http/server.py` and `identity.py`, `src/laya-model-manifest.ts`, `skills/router-laya-install/SKILL.md`.
- Registry and tarballs of `onnxruntime-node` 1.30.0 and 1.31.1 read on 2026-11-11 (`npm view`, `npm pack`, `tar -t`, `script/install.js`, `script/install-metadata.js`, `script/install-utils.js`); `npm audit` on a lockfile of 1.30.0 (0 findings).
- Upstream `laya-ts` at `6880462` (spike) and at `3a38cbe` (`v0.4.31`, latest on 2026-11-11, fetched into `~/.laya-ft/upstream-laya`); `laya-ts` still 404 on npm.

**Not checked:** any ONNX runtime executing on Linux, Windows or musl (D5: stays untested); the runtime use of `global-agent`; the `nuget_nightly` feed; the Python `onnxruntime` wheels for Intel Macs; whether the spike's `run_node.mjs` behaved as its notes describe (it is missing, see Problem 4).

## Steps

- [x] D1–D8 decided by the owner, 2026-11-11.
- [ ] Step 2: `laya-sidecar/scripts/parity.mjs` — red first against a missing reference, then green on the golden set (180/180) and the corpus sample (≥297/300).
- [ ] Step 3: `laya-sidecar/package.json` with exact pin and committed lockfile; `npm audit` clean.
- [ ] Step 4: CUDA-skip install test (red without the flag, green with it).
- [ ] Step 5: vendored `laya-ts` Node path, licence and commit header; no `onnxruntime-web`.
- [ ] Step 6: `/health` cross-language parity test against `identity.py`.
- [ ] Step 7: sidecar reads an install directory; no network access in the sidecar code path (test).
- [ ] Step 8: platform table in the docs (D5/D6 wording).
- [ ] Step 9: skill step 8 and `test/laya-install-skill.test.ts` updated (red first).
- [ ] Step 10: install docs per platform (README/`docs/config-override.md` links), CHANGELOG entry under Unreleased.
- [ ] Release line set up but **not** published — publish and tag need the owner's release-specific go (AGENTS.md §1).
