# Release rehearsal: prove the delivery before anything is published

**Status:** done 2026-11-16 — script, container and checklist built; the rehearsal passes on darwin/arm64 (14.1 s) and inside the container on linux/arm64 (52.8 s), both recorded in [`docs/research/2026-11-16-release-rehearsal-runs.md`](../research/2026-11-16-release-rehearsal-runs.md).

**Related:** `docs/plans/2026-11-16-laya-sidecar-in-router-tarball.md` (what is delivered). This plan verifies that delivery.

## Problem

Nothing in the repository exercises the way a user receives Laya. The pieces are each tested in isolation — the installer against `file://` and loopback fixtures, the sidecar against an install directory, the manifest against its schema — but the chain from "published package" to "a classification comes back" is never run as a whole:

1. **The tarball is never installed.** `test/package-contents.test.ts` asserts *which files* `npm pack` produces. Nothing installs that tarball and runs what is inside it, so a missing build output, a wrong `bin` path or a broken `files` entry is found by users.
2. **The release assets are never fetched.** The installer is tested against fixtures; the real GitHub Release URL, its asset names and the `published` flag are only checked by `scripts/laya-release-check.ts`, which reads the directory and never downloads from it.
3. **The release order is not enforced.** Weights must be uploaded, then `published: true` must ship in a PR, then the tag, then the npm publish. Get the order wrong and users see an installer that refuses a release that exists, or a manifest that points at assets nobody uploaded.
4. **A publish cannot be undone.** npm has no delete. The first honest test of the published artifact is currently the user's `pi install`.

## Solution

One script that performs the whole delivery against a local stand-in for the release, plus a container that runs it on a second platform and can be driven by hand.

1. **`scripts/release-rehearsal.ts`** — the rehearsal, in the order a user meets it:
   1. Preconditions: the asset directory matches the manifest byte for byte (`checkReleaseDir` from `laya-release-check.ts`, reused, not reimplemented), and Node meets `engines`.
   2. `npm pack` the repository into a temp dir (this runs `prepack` → `build`, so the tarball is the real one).
   3. Install that tarball into an empty temp project (`npm install --omit=peer`, since the rehearsal runs the installer and the sidecar, not the Pi host).
   4. Serve the asset directory over loopback with a *staged* manifest (`published: true`, `base_url` on the loopback port) — the only two fields that differ from the shipped manifest.
   5. Run the installed `pi-laya-model install <model>@<version> --manifest <staged>` with `PI_CODING_AGENT_DIR` in the temp tree.
   6. `pi-laya-model verify`.
   7. `pi-laya-model runtime install` (the real `npm ci`; `--skip-runtime` opts out).
   8. `pi-laya-model serve`, wait for `/health`, compare the identity with the manifest (`model`, `version`, `backend`, `head_sha256`), `POST /classify` and require a category from the head's list.
   9. Report one line per step with its duration; exit 1 on the first failure, keeping the temp tree for inspection.
2. **A test container** (`rehearsal/Dockerfile` + `rehearsal/run.sh`): Node 22.19 on Debian slim, the repository mounted read-only, the rehearsal run inside it. It answers the question the host cannot: does the delivery work on Linux, where the ONNX binding is a different file and `npm ci` takes the other code path. No private mounts, no keys, nothing from the maintainer's `~/.pi`.
3. **The checklist gets the order** (`RELEASE_CHECKLIST.md`): weights upload → rehearsal green on both platforms → `published: true` through a PR → tag → CI publish → smoke test from a clean state. The rehearsal is a step, not a suggestion.

## Decisions (owner, 2026-11-16)

**D1 — The rehearsal runs from the repository**, not from a throwaway script in `/tmp`: it is the only way the next release can repeat it.

**D2 — The container lives in this repository and is standalone** (Node + the repo, no `claude-container` base): it must be buildable by anyone and runnable in CI later.

## Open decisions

None.

## Verified against

- `main` @ `20e6668` + branch `feat/sidecar-in-tarball`: `scripts/laya-release-check.ts` (`checkReleaseDir`), `scripts/lib/cli.ts` (`arg`, `invokedDirectly`), `test/package-contents.test.ts`, `test/laya-model-install.test.ts` (the fixture pattern), `RELEASE_CHECKLIST.md`.
- Measured 2026-11-15/16 on darwin/arm64: the chain works by hand — `install` from a loopback-served copy of the release directory, `verify`, sidecar from the installed directory, `/health` equal to the manifest, `/classify` in 126 ms; and with the new design `runtime install` → `serve` → `/classify`.
- Docker available on this machine (`docker info`: server 29.1.3, linux/arm64).

**Not checked:** the rehearsal in the container (this plan's own step), and the GitHub Release asset URLs themselves — both are what the run is for.

## Steps

- [x] Step 1: `scripts/release-rehearsal.ts` with `--assets`, `--manifest`, `--model`, `--port`, `--skip-runtime`, `--no-serve`, `--keep`, `--json`. Red first.
- [x] Step 2: `rehearsal/Dockerfile` + `rehearsal/run.sh`; the image builds and the rehearsal passes inside it.
- [x] Step 3: `RELEASE_CHECKLIST.md` rework: the release order, the rehearsal step, the smoke test after the publish.
- [x] Step 4: a real run on darwin/arm64 and inside the container, both recorded in a research note.
