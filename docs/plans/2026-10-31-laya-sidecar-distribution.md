# Laya sidecar distribution: give every user a classifier they can actually run

**Status:** proposed 2026-10-31. Nothing implemented. Blocked on owner decisions 1 and 2 below.

Related, separate plan: the merge of `laya-spike` into `main` (AGENTS.md §11: one problem per plan). This plan decides what the merged feature can promise users.

## Problem

Laya is the classifier the owner now trusts day to day, but a user who installs the router cannot run it:

1. **There is no shipped sidecar.** The HTTP server is `spikes/laya-http/server.py`, labelled "throwaway spike", started by a user-level Pi extension (`~/.pi/agent/extensions/laya-sidecar-manager`) with hard-coded absolute paths. Neither is in the npm package (`npm pack` lists only `dist/`, two skills, `PI.md`, `README.md`). The router's own docs do not mention Laya at all (README, `docs/config-override.md`, `docs/architecture.md`, `PI.md`: 0 hits).
2. **The runtime is Apple Silicon only.** The sidecar imports `laya_mlx`; MLX needs an Apple GPU. Linux, Windows and Intel Macs cannot start it.
3. **The weights that make it useful are private.** Zero-shot Laya scores 17.2 % group accuracy on our taxonomy, the fine-tuned run `r2` 62.5 % (research note, 2026-10-14). `r2` (644 MB, fp16) lives only in `~/.laya-ft/runs/r2` and was trained on the owner's private session prompts; `~/.laya-ft/README.md` states "private — never commit, never leave this machine". Without those weights the shipped feature is close to useless, and publishing them contradicts that rule.
4. **Weight identity is not verifiable.** The decision log labels answers `laya:<classifier_laya.checkpoint>`, a string the user types into the config. The sidecar manager serves `runs/r2` while the config names the zero-shot HF repo, so the log currently attributes decisions to the wrong weights. The sidecar has no endpoint that reports what it loaded.

## Solution

Ship the router with Laya **off by default and honest about its setup**, and give users one install path that works on every platform:

1. **One sidecar contract, two backends.** Keep `POST /classify` exactly as the client and `test/laya-client-contract.test.ts` already pin it. Add `GET /health` returning the loaded weights' identity (revision or content hash) and backend; the router logs that instead of a typed string.
2. **ONNX Runtime on CPU as the portable backend**, MLX as the optional Apple Silicon fast path. Third-party READMEs report ~64 ms (4 threads, fp32) and ~0.5 GB for int8 at 100 % argmax agreement, against our 1500 ms timeout. The figures and their sources are recorded in `docs/research/2026-10-31-laya-portable-backends.md` (third-party claims, not reproduced by us). Preferring ONNX everywhere gives one code path to test; MLX stays only if parity and the latency gap justify it.
3. **A parity gate before any backend is trusted:** run the golden set and the live queue through MLX `r2` and through the ONNX conversion and require identical argmax (the community int8 claim is for a different model and language set).
4. **Packaged as its own installable tool** (a Python package run through `uvx`/`pipx`, with a pinned model revision and a checksum), versioned and released separately from the npm package. The router only talks HTTP to `127.0.0.1` and never downloads weights (ADR-0021/-0022 spirit; `types.ts` already says so).
5. **Weights:** decided by owner decision 1. Until then the documented path is "bring your own checkpoint".
6. **Docs:** a Laya section in the README and `docs/config-override.md` that states what is needed per platform and that the cloud chain is the default.

## Open decisions

1. **Which weights can users get?** (a) Publish `r2` as is: breaks the owner's own privacy rule and may expose training prompts through memorisation (96.5 % on the owner-rated items). (b) Retrain on prompts that may be shared (public or synthetic) and publish that: a new pipeline and a new validation, hours of training per run. (c) Ship no weights; users run the zero-shot model or train their own with the pipeline. The pipeline is Apple-only, outside the repo and costs teacher tokens, and zero-shot is at 17.2 %.
2. **What may the merge promise?** Merge with Laya documented as experimental, Apple Silicon only and bring-your-own-weights, or wait until decision 1 and the ONNX backend are done.
3. **Where does the sidecar live?** A subdirectory of this repo with its own release, or a separate repository.
4. **Is a Python runtime acceptable as a user requirement?** The alternative, in-process `onnxruntime-node`, removes Python but adds a native dependency to the bundled extension (AGENTS.md §10, smallest attack surface) and was not evaluated.

## Verified against

commit `67c3cbd` (`laya-spike`, pushed), checked 2026-10-31 against the code, the user's sidecar manager extension, `~/.laya-ft/README.md`, `docs/research/2026-10-14-laya-finetuning-state.md` and the public model cards of `convaiinnovations/laya-multilingual`, `laya-mlx` (PyPI 0.4.0) and two community ONNX conversions. **Not checked:** that any ONNX build reproduces our fine-tuned weights (no conversion was run), CPU latency on non-Apple hardware (numbers below are third-party README claims), the licence obligations of publishing a fine-tuned derivative, whether the fine-tuned weights leak training prompts (only the memorisation figure from the research note exists).

## Steps

- [ ] Owner decides 1 and 2.
- [ ] Red-first: sidecar contract tests extended with `/health`; the router log carries the reported identity.
- [ ] ONNX conversion of `r2` and the parity run (golden + queue); report goes to `docs/research/`, not into this plan.
- [ ] Latency measured on at least one Linux x86 and one Windows machine.
- [ ] Packaging, pinned revision, checksum, install docs per platform.
- [ ] README and config docs; a `test/package-contents.test.ts` case that the spike directory and the owner's absolute paths never ship.
