# ONNX sidecar package: an installable Laya sidecar for Linux, Windows and macOS

**Status:** proposed 2026-11-11 — nothing built yet. Waits for the owner decisions D1–D6 below. The first step that needs no decision is the parity runner (step 2), but it is blocked on the missing spike runner (see Problem 4), so the plan starts with the decisions.

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
2. **Repeatable parity first.** Rewrite the runner as `laya-sidecar/scripts/parity.mjs`: it runs the golden set and the corpus sample through the ONNX sidecar and compares with a stored MLX reference output. Red first: the script fails when the stored reference is missing or the argmax differs. Acceptance: the golden set stays 180/180 and the corpus sample stays at or above 297/300, the numbers of the spike.
3. **Pinned dependency, no install hook of our own.** `onnxruntime-node` pinned to an exact version (D3), with a committed lockfile. The sidecar package has no `postinstall` of its own.
4. **Skip the CUDA download, and prove it.** The install instructions set `ONNXRUNTIME_NODE_INSTALL=skip`. Red-first CI test: with `GLOBAL_AGENT_HTTPS_PROXY` pointing at a closed port, `npm install` without the flag must fail (proof that the download path exists), and with the flag it must succeed and CPU inference must run. This pins the install behaviour for the next version bump.
5. **Vendor the needed part of `laya-ts`** (D2): copy the Node path (`agent`, `tokenizer`, the ONNX provider, what `predict` needs) into `laya-sidecar/src/laya/`, keep the Apache-2.0 `LICENSE`, and write the upstream commit (`6880462`) into a header. No `onnxruntime-web` (browser only).
6. **Identity:** `GET /health` returns the same fields as `spikes/laya-http/identity.py`. `head_sha256` and `artifact_sha256` are computed with the TypeScript helpers that the router already uses (`src/laya-model-manifest.ts`). Red-first cross-language test: the sidecar and `identity.py` must return identical hashes for the same install directory.
7. **Input:** the sidecar reads an install directory `~/.pi/agent/laya-models/<model>/<version>/` written by `pi-laya-model install --backend onnx`. It never downloads anything (the same rule as the router, ADR-0021).
8. **Platform matrix in the docs, not in a claim:** darwin/arm64, linux/x64, linux/arm64, win32/x64, win32/arm64 have a binding in the package. Each is listed as "supported" only after a smoke run (load + parity on the golden set) on that platform (D5). darwin/x64 is listed as unsupported.
9. **Skill and installer follow the sidecar:** `skills/router-laya-install/SKILL.md` step 8 replaces "not packaged yet" with the install command and the start command, and offers `onnx` on Intel Macs only if a platform run exists. `test/laya-install-skill.test.ts` pins the new text, red first.
10. **Release line:** tags `laya-sidecar-v<version>`. Publishing to npm and creating the GitHub Release are release actions (AGENTS.md §1) and are **not** part of this plan's done state. The plan is done when the package builds, its tests and `npm audit` are green in CI, and the docs describe the install. It is not done when it is published.

## Open decisions (owner)

Recommendations are mine, reasons in the research note.

**D1 — Package name and channel.** Recommendation: scoped npm package `@anierbeck/laya-sidecar`, published from the `laya-sidecar-v*` tags. The publish itself needs a release-specific go. Alternative: GitHub Release tarball only (no registry, no `npm audit` on consumers' side).

**D2 — How `laya-ts` gets into the package.** Recommendation: **vendor** the Node path with its Apache-2.0 licence and the pinned upstream commit. Alternatives: a git dependency pinned to `6880462` (installs unverified source from GitHub at install time), or wait for upstream to publish `laya-ts` on npm (no date, not in our hands).

**D3 — `onnxruntime-node` version.** Recommendation: **1.30.0**, the version the spike ran, until a parity run exists for a newer one. Alternative: 1.31.1 (latest, same binding set, not tested against our golden set).

**D4 — How users skip the CUDA download.** Recommendation: the documented env var `ONNXRUNTIME_NODE_INSTALL=skip` in the install command, pinned by the CI test of step 4. Alternative: `npm install --ignore-scripts`, which also skips any future install script of any package, which is broader than we need but needs no env var.

**D5 — Smoke runs on non-Apple platforms.** Your waiver of 2026-11-08 covered the Linux/Windows *latency* measurement. It does not cover "does it load and agree with MLX". Recommendation: one smoke run each on a Linux x64 machine and a Windows x64 machine before those platforms are called supported. Without it the docs say "binaries shipped, not tested" for them.

**D6 — Intel Macs.** No ONNX binding for darwin/x64 in the package, and MLX is Apple Silicon only. Options: (a) document "no Laya on Intel Macs" as the outcome; (b) investigate a Python `onnxruntime` wheel for x86-64 macOS (not checked; a Python sidecar would also need a Python requirement, decision 4 of 2026-10-31).

**D7 — Model name and tags.** You wanted to rename the weights line (e.g. `laya-router`). The manifest tags, asset names and `base_url` are in the artifact plan. Decide before step 9 pins install text to the tag name. This does not block steps 1–8: they run against a local install directory.

**D8 — 2.0.0 gate.** The open question of `2026-11-08-laya-model-artifact.md` stays open: is the first asset publish a 2.0.0 blocker, or the first release of the model line after 2.0.0? This plan does not need the publish to reach its done state.

## Verified against

- `main` @ `92a5eee` (2026-11-11): `laya-models/manifest.json` (r2@1.0.0, `published: false`), `package.json` `files` allowlist, `spikes/laya-http/server.py` and `identity.py`, `src/laya-model-manifest.ts`, `skills/router-laya-install/SKILL.md`.
- Registry and tarballs of `onnxruntime-node` 1.30.0 and 1.31.1 read on 2026-11-11 (`npm view`, `npm pack`, `tar -t`, `script/install.js`, `script/install-metadata.js`, `script/install-utils.js`); `npm audit` on a lockfile of 1.30.0 (0 findings).
- Upstream `laya-ts` at `6880462` (`~/.laya-ft/upstream-laya`).

**Not checked:** any ONNX runtime executing on Linux, Windows or musl; the runtime use of `global-agent`; the `nuget_nightly` feed; the Python `onnxruntime` wheels for Intel Macs; whether the spike's `run_node.mjs` behaved as its notes describe (it is missing, see Problem 4).

## Steps

- [ ] D1–D6 decided by the owner (D7 and D8 before the skill text and the release).
- [ ] Step 2: `laya-sidecar/scripts/parity.mjs` — red first against a missing reference, then green on the golden set (180/180) and the corpus sample (≥297/300).
- [ ] Step 3: `laya-sidecar/package.json` with exact pin and committed lockfile; `npm audit` clean.
- [ ] Step 4: CUDA-skip install test (red without the flag, green with it).
- [ ] Step 5: vendored `laya-ts` Node path, licence and commit header; no `onnxruntime-web`.
- [ ] Step 6: `/health` cross-language parity test against `identity.py`.
- [ ] Step 7: sidecar reads an install directory; no network access in the sidecar code path (test).
- [ ] Step 8: smoke runs on the platforms of D5; platform table in the docs follows the results.
- [ ] Step 9: skill step 8 and `test/laya-install-skill.test.ts` updated (red first).
- [ ] Step 10: install docs per platform (README/`docs/config-override.md` links), CHANGELOG entry under Unreleased.
- [ ] Release line set up but **not** published — publish and tag need the owner's release-specific go (AGENTS.md §1).
