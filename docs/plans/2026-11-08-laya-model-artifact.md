# Laya model artifact: versioned, verifiable, installable

**Status:** proposed 2026-11-08 — not started. Part of the 2.0.0 "everything
Laya" release gate (`2026-10-25-laya-sole-classifier.md`, "Release gate").
Owner decisions 2026-11-08: weights as **GitHub Release assets + manifest in
the repo**; ONNX as the default backend; the install path is a **skill** that
asks before it acts.

## Problem

A user who installs the router cannot obtain the Laya weights, and if they do,
nobody can tell what they got.

1. **There is no artifact to install.** `ClassifierLayaConfig.checkpoint`
   (`src/types.ts:267`) is a hand-typed HF repo path, and its own comment says
   it: *"The router never downloads weights — fetching is a manual step (pip
   install laya-mlx + huggingface_hub.snapshot_download)"*. A user without the
   owner's `~/.laya-ft` has no path to the weights at all.
2. **The identity is a claim, not a fact.** The decision log labels answers
   `laya:<checkpoint>` (`src/classifier-decision-log.ts:145`) — a string the
   user typed. The sidecar may serve different weights; nothing detects it.
   (Distribution plan, Problem 4.)
3. **The head is not part of any artifact.** The sidecar reads its task
   definition from a local file (`HEAD_JSON` in the sidecar manager), while
   `src/classification-prompt.ts:179 buildLayaHead()` is the production
   definition. No test pins the two equal, so a drift silently measures prompt
   drift instead of the model.
4. **Nothing verifies what arrived.** No checksums, no size check, no resume —
   while the artifact is 1.29 GB (measured: `docs/research/2026-11-08-onnxruntime-node-spike.md`).
5. **The install path is owner-specific.** The sidecar manager hard-codes
   absolute paths into the owner's home for server, venv, model dir and head
   (a user-level extension outside the repository, not shipped).
6. **The router package must stay dependency-free.** `package.json` has no
   `dependencies`, no `optionalDependencies` and no `bin`, and the build is a
   single esbuild bundle. Anything that pulls `onnxruntime-node` (290 MB of
   native binaries) into the router would break that property for every user,
   including those who never enable Laya (AGENTS.md §10).

## Solution

1. **A manifest in the repo, shipped with the package:**
   `laya-models/manifest.json`, added to `package.json` `files` and to
   `BUILD_OUTPUTS` in `test/package-contents.test.ts`. It names, per model
   version, the backend artifacts with `sha256` and `bytes`, the head hash, the
   category list and the release URL. Shipping it means a router release states
   which model versions it was verified against; an override flag
   (`--manifest <path|url>`) allows testing newer artifacts without a release.
2. **Weights as GitHub Release assets** (owner decision 2026-11-08), one
   release per model version, tagged `laya-r2-v1.0.0` and up. The manifest is
   the contract; the assets are the payload. Checksums detect corruption and
   mixups — they are not a signature, and the plan says so instead of implying
   otherwise.
3. **One install layout:** `~/.pi/agent/laya-models/<model>/<version>/`, with
   `manifest.json` copied next to the weights so an installed directory is
   self-describing. Install is atomic: download to `.tmp`, verify every file's
   `sha256` and the total byte count, then rename. A mismatch deletes the
   `.tmp` tree and reports; nothing half-installed is ever visible.
4. **A `bin` that does the work, not the skill.** `pi-laya-model`
   (`src/laya-model-install.ts` → `dist/laya-model-install.js`, new `bin` and
   `files` entry): `install`, `verify`, `list`, `remove`. Disk-space check
   before download, HTTP Range resume, progress on a TTY, `--json` for the
   skill. Logic in a testable CLI, not in skill prose.
5. **Identity comes back at runtime.** The sidecar contract gains
   `GET /health` → `{ status, model, version, backend, weights_sha256,
   head_sha256 }`. The router records the **reported** identity in the decision
   log (`laya:<model>@<version>`) and falls back to the configured string only
   when `/health` is unavailable — and then says so in the log. `/router status`
   shows reported vs. configured and warns on a mismatch.
6. **A head parity gate.** Red-first test: the head inside a shipped artifact
   must equal `buildLayaHead()` (`src/classification-prompt.ts:179`). Without
   it, a retrained head can silently diverge from the production task
   definition.
7. **`router-laya-install` skill** (`skills/router-laya-install/SKILL.md`,
   modelled on `router-login`): detects the platform, asks sidecar runtime
   (Node default, Python) and backend (ONNX default, MLX offered on Apple
   Silicon), port, and confirms the download size; checks platform, free space
   and existing versions; runs `pi-laya-model install`; writes the user-layer
   config; starts the sidecar; then shows the `/health` identity it actually
   got. It never downloads or writes config on its own — every action is a
   confirmed step.

## Decisions (owner, 2026-11-08)

1. **Install root:** `~/.pi/agent/laya-models/<model>/<version>/` — the
   proposal, accepted.
2. **A `bin` that runs without Pi:** accepted. `pi-laya-model` is a command
   line program that `npm` puts on the user's PATH; it is not embedded in the
   extension and needs no running Pi. It stays dependency-free (Node built-ins
   only), so the router package keeps zero runtime dependencies.
3. **Backends follow the user's runtime and choice, never an assumption.** The
   skill detects the platform and proposes (a Mac gets MLX offered), but the
   user decides between the **Python** and the **Node** sidecar. Node + ONNX is
   the default. Resulting matrix:
   - Node sidecar + ONNX (CPU) — default, every OS; measured in
     `docs/research/2026-11-08-onnxruntime-node-spike.md`.
   - Python sidecar + MLX — Apple Silicon only. MLX is Apple's own framework
     and runs through its own runtime (the `laya_mlx` Python package here); it
     is not an ONNX execution path.
   - Python sidecar + ONNX — upstream Laya ships a Python `ONNXAgent`, so this
     should work anywhere with Python; **not verified end to end**.
   The manifest therefore carries one artifact set per backend (ONNX files,
   MLX checkpoint), and the install records which one was chosen.
4. **Publishing the weights is decided later** and stays part of this
   repository as a **dedicated release line**, separate from the npm releases
   of the extension (tags `laya-<model>-v<version>`). The owner expects further
   model optimisations to ship the same way. Publishing remains a release
   action needing an explicit owner go (AGENTS.md §1).

**Open — owner to confirm:** the 2.0.0 gate (`2026-10-25-laya-sole-classifier.md`)
still lists "r2 weights publish" as a pre-release item. Decision 4 defers *who
and when*; whether the first publish stays a 2.0.0 blocker or becomes the
first release of the model line after 2.0.0 is not settled.

## Verified against

Commit `a20ac9e` (`main`, 2026-11-08):

- `src/types.ts:267-273` (`checkpoint` is a hand-typed HF path; "the router
  never downloads weights"), `src/classifier-decision-log.ts:145`
  (`laya:<checkpoint>` label), `src/commands.ts:207` (status line prints the
  configured string).
- `src/classification-prompt.ts:159,179` (`LAYA_HEAD_V2_INSTRUCTIONS`,
  `buildLayaHead()`); no test references a head artifact
  (`grep -rln "laya_head_v2\|head_sha" test/ scripts/` → empty).
- `package.json` (`files` allowlist, no `bin`, no `dependencies`), build script
  (single esbuild bundle), `test/package-contents.test.ts:33` (`BUILD_OUTPUTS`).
- `test/laya-client-contract.test.ts` pins `/classify` only — no `/health`.
- The user-level sidecar-manager extension (outside the repository) hard-codes
  absolute owner paths, i.e. it is not shippable as is.
- Artifact sizes and parity from
  `docs/research/2026-11-08-onnxruntime-node-spike.md` (1.29 GB fp32 ONNX,
  100 % golden-set argmax parity with MLX).

**Not checked:** whether GitHub release assets honour `Range` for resume (must
be verified against a real release before the resume path is claimed); how Pi
skills invoke an external binary in practice (needs a smoke test in the skill);
whether `~/.pi/agent/laya-models/` collides with anything Pi owns.

## Steps

- [x] Owner decisions 1–4 (2026-11-08), see above; the 2.0.0-gate question under them is open.
- [ ] Red-first: head parity test — artifact head vs `buildLayaHead()`, red
      against a deliberately drifted fixture.
- [ ] Red-first: manifest schema test — a manifest with a missing `sha256`, a
      duplicate file name or an unknown backend fails validation.
- [ ] Red-first: install/verify tests against a local `file://` manifest with
      small fixtures — checksum mismatch aborts and leaves nothing behind;
      resume continues a truncated file; `verify` detects a corrupted install.
- [ ] `laya-models/manifest.json` + `src/laya-model-install.ts` (`install`,
      `verify`, `list`, `remove`) + `bin` wiring.
- [ ] Red-first: `/health` client contract test (identity fields, fallback to
      the configured string when `/health` fails) and the decision-log label
      change to `laya:<model>@<version>`.
- [ ] `/router status`: reported vs. configured identity, mismatch warning.
- [ ] `skills/router-laya-install/SKILL.md`, modelled on `router-login`.
- [ ] Docs: `docs/config-override.md` (checkpoint semantics), README (install
      path), CHANGELOG under 2.0.0.
- [ ] Owner go for the weights release, then publish the assets.
