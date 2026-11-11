# Laya sidecar distribution: give every user a classifier they can actually run

**Status:** in progress 2026-11-01; **2.0.0 blocker since 2026-11-08** (owner:
"everything Laya" ships before the release). Owner decisions 1–4 are
made (see below); the merge documents Laya as experimental (commit
`fe9d913`). Remaining work: live-queue parity run, packaging, weights
publish (`/health` contract tests done 2026-11-08). The Linux/Windows latency measurement is WAIVED
(owner 2026-11-08: modern PCs are assumed similar). The r2 weights publish
is a release action — separate explicit approval per AGENTS.md §1.

This plan decides what the merged feature can promise users (AGENTS.md §11: one problem per plan — the `laya-spike` → `main` merge itself is not a plan).

## Problem

Laya is the classifier the owner now trusts day to day, but a user who installs the router cannot run it:

1. **There is no shipped sidecar.** The HTTP server is `spikes/laya-http/server.py`, labelled "throwaway spike", started by a user-level Pi extension (`~/.pi/agent/extensions/laya-sidecar-manager`) with hard-coded absolute paths. Neither is in the npm package (as of 2026-10-31; the `files` allowlist now pins exactly the four `dist/` build outputs plus skills/PI.md/README.md). Since commit `fe9d913` the user docs do mention Laya as experimental (README, `docs/config-override.md`, `docs/architecture.md`, `PI.md`).
2. **The runtime is Apple Silicon only.** The sidecar imports `laya_mlx`; MLX needs an Apple GPU. Linux, Windows and Intel Macs cannot start it.
3. **The weights that make it useful were private.** Zero-shot Laya scores 17.2 % group accuracy on our taxonomy, the fine-tuned run `r2` 62.5 % (research note, 2026-10-14). `r2` (644 MB, fp16) lives only in `~/.laya-ft/runs/r2` and was trained on the owner's private session prompts; `~/.laya-ft/README.md` stated "private — never commit, never leave this machine". Owner decision 1 (2026-11-01) publishes the `r2` weights — and only the weights: the gitleaks scan of the training corpus (`data/train_v2.jsonl`, 74 hits, all false positives — internal 16-hex example IDs; none of the machine's real API keys, no sk-/ghp_/AKIA/xox/45-char patterns, no webhook/tailnet patterns) found no credentials, so the residual risk is only membership-inference detectability of prompts an attacker already knows. The base model is Apache 2.0, so publishing the derivative with License/Notice is permitted. Everything else in `~/.laya-ft` (corpus, labels, training scripts, golden set) stays local; the "never leave this machine" rule continues to apply to it.
4. **Weight identity is not verifiable.** The decision log labels answers `laya:<classifier_laya.checkpoint>`, a string the user types into the config. The sidecar manager serves `runs/r2` while the config names the zero-shot HF repo, so the log currently attributes decisions to the wrong weights. The sidecar has no endpoint that reports what it loaded.

## Solution

Ship the router with Laya **off by default and honest about its setup**, and give users one install path that works on every platform:

1. **One sidecar contract, two backends.** Keep `POST /classify` exactly as the client and `test/laya-client-contract.test.ts` already pin it. Add `GET /health` returning the loaded weights' identity (revision or content hash) and backend; the router logs that instead of a typed string.
2. **ONNX Runtime on CPU as the portable backend**, MLX as the optional Apple Silicon fast path. Third-party READMEs report ~64 ms (4 threads, fp32) and ~0.5 GB for int8 at 100 % argmax agreement, against our 1500 ms timeout. The figures and their sources are recorded in `docs/research/2026-10-31-laya-portable-backends.md` (third-party claims, not reproduced by us). Preferring ONNX everywhere gives one code path to test; MLX stays only if parity and the latency gap justify it.
3. **A parity gate before any backend is trusted:** run the golden set and the live queue through MLX `r2` and through the ONNX conversion and require identical argmax (the community int8 claim is for a different model and language set).
4. **Packaged as its own installable tool** (a Python package run through `uvx`/`pipx`, with a pinned model revision and a checksum), versioned and released separately from the npm package. The router only talks HTTP to `127.0.0.1` and never downloads weights (ADR-0021/-0022 spirit; `types.ts` already says so).
5. **Weights:** decided — owner decision 1(a), 2026-11-01: publish the `r2` weights (see Problem 3 for the evidence basis), everything else in `~/.laya-ft` stays local.
6. **Docs:** done for the merge — Laya documented as experimental in the README, `docs/config-override.md`, `docs/architecture.md` and `PI.md` (commit `fe9d913`); per-platform install docs come with the packaged sidecar.

## Open decisions

1. **Which weights can users get?** DECIDED 2026-11-01, option (a): publish `r2` as is. Evidence recorded in Problem 3 (secret-free corpus scan, Apache-2.0 base, memorisation risk assessed as negligible by the owner: weights are matrices, no text-extraction channel; the only residual risk is membership-inference on prompts an attacker already knows). Option (a) previously "broke the privacy rule" — the owner explicitly lifted the rule for the weights only, 2026-11-01.
2. **What may the merge promise?** DECIDED 2026-11-01: merge with Laya documented as experimental, Apple Silicon only, bring-your-own-weights (commit `fe9d913`) — not waiting for the ONNX backend.
3. **Where does the sidecar live?** A subdirectory of this repo with its own release, or a separate repository.
   DECIDED 2026-11-08: a subdirectory of this repository with its own npm
   package and its own release line (the `laya-<model>-v<version>` tags of
   `2026-11-08-laya-model-artifact.md` live here too); one CI runs the
   contract tests against it.
4. **Is a Python runtime acceptable as a user requirement?** The alternative, in-process `onnxruntime-node`, removes Python but adds a native dependency to the bundled extension (AGENTS.md §10, smallest attack surface) and was not evaluated.
   DECIDED 2026-11-08: Python is not required. The spike
   (`docs/research/2026-11-08-onnxruntime-node-spike.md`) showed parity, and
   ONNX ships as its own Node sidecar package, not in-process, so the router
   bundle keeps zero runtime dependencies. Python stays a user choice (MLX on
   Apple Silicon), per decision 3 of `2026-11-08-laya-model-artifact.md`.

## Verified against

commits `67c3cbd` (checked 2026-10-31) and `fe9d913` (checked 2026-11-01; decisions 1(a)/2 and the user docs recorded above), checked against the code, the user's sidecar manager extension, `~/.laya-ft/README.md`, `docs/research/2026-10-14-laya-finetuning-state.md` and the public model cards of `convaiinnovations/laya-multilingual`, `laya-mlx` (PyPI 0.4.0) and two community ONNX conversions. **Not checked:** that any ONNX build reproduces our fine-tuned weights (no conversion was run), CPU latency on non-Apple hardware (numbers below are third-party README claims), the licence obligations of publishing a fine-tuned derivative, whether the fine-tuned weights leak training prompts (only the memorisation figure from the research note exists).

## Steps

- [x] Owner decides 1 (publish r2 weights, 2026-11-01) and 2 (merge documents Laya as experimental, 2026-11-01).
- [x] Owner decides 3 (sidecar in a subdirectory of this repo) and 4 (no Python requirement), 2026-11-08.
- [x] User docs as experimental (commit `fe9d913`).
- [x] Red-first: sidecar contract tests extended with `/health`; the router log carries the reported identity (2026-11-08, delivered with `2026-11-08-laya-model-artifact.md` Solution 5: `test/laya-client-contract.test.ts`, `test/laya-sidecar-identity.test.ts`, `test/laya-chain.test.ts`; reference sidecar `spikes/laya-http/identity.py`).
- [x] ONNX conversion of `r2` and the golden-set parity run, 2026-11-08: 100 %
  argmax (180/180), confidence drift > 0.05 on 2/180 items. See
  `docs/research/2026-11-08-onnxruntime-node-spike.md`, which also answers open
  decision 4 (Python is not a hard runtime requirement for inference;
  `onnxruntime-node` meets parity and the latency budget on Apple Silicon) and
  rules out int8 (69 % argmax agreement, confidence destroyed).
- [ ] Live-queue parity run through both backends (needs more queue items).
- [x] ~~Latency measured on at least one Linux x86 and one Windows machine.~~
  WAIVED by the owner 2026-11-08: modern PCs are assumed similar; the Apple
  Silicon fp32 numbers in
  `docs/research/2026-11-08-onnxruntime-node-spike.md` stand as reference.
- [ ] Packaging, pinned revision, checksum, install docs per platform. **Planned in** `docs/plans/2026-11-11-onnx-sidecar-package.md` (decisions D1–D8 taken 2026-11-11).
- [x] `test/package-contents.test.ts` pins the shipped file set (allowlist since commit `0dff78b`) — the spike directory and owner paths cannot ship.
- [ ] Per-platform install docs with the packaged sidecar.
