# Release rehearsal: the two runs that prove the delivery

**Date:** 2026-11-16
**Feeds:** `docs/plans/2026-11-16-release-rehearsal.md` (the plan decides; this note measures)
**Script:** `scripts/release-rehearsal.ts`, container `rehearsal/`
**Assets:** `~/.laya-ft/artifacts/r2-1.0.0/release/` — 9 files, 1322 MB, the directory that would be uploaded for `laya-router-v1.0.0`
**Manifest:** the shipped `laya-models/manifest.json` (`published: false`); the rehearsal stages a copy with `published: true` and a loopback `base_url`

## Result

Both runs pass every step. The same model, served from the same tarball through
the same installer, answers identically on both platforms.

| Step | darwin/arm64 (host) | linux/arm64 (container) |
|---|---|---|
| release directory (9 assets, 1322 MB) | 886 ms | 8,850 ms |
| `npm pack` (19 files, 0.4 MB) | 3,506 ms | 4,716 ms |
| install the tarball | 2,452 ms | 7,073 ms |
| install the model (loopback) | 2,706 ms | 11,731 ms |
| verify the model | 975 ms | 2,395 ms |
| runtime install (`npm ci`) | 1,224 ms | 12,889 ms |
| serve: `/health` + `/classify` | 2,124 ms | 2,240 ms |
| **total** | **11.5 s** | **49.9 s** |

Two runs each; the table is the last one. The first host run was 14.1 s and the
first container run 52.8 s — the spread is npm cache warmth, not a difference in
the steps.

- `/health` identity equalled the manifest on both: `router@1.0.0`, backend
  `onnx`, head `5f12495d…90883`.
- The classification was the same on both platforms: `code_complex`, confidence
  **0.619** — 98.0 ms on the host, 191.5 ms in the container.
- The container's total includes `npm ci` for the repository (~17 s) and the
  `docker build` is ~25 s; the rehearsal itself is the 52.8 s above.

## What this establishes

1. **The tarball is installable and self-sufficient.** The rehearsal installs it
   into an empty project and runs the installer *from the installed package*, not
   from the repository. A missing build output, a wrong `bin` path or a broken
   `files` entry fails here.
2. **The installer works against a real HTTP release**, not a fixture: 1.3 GB
   over loopback with per-file size and sha256 checks, then `verify`.
3. **`runtime install` works on Linux.** This was the open risk in the
   on-demand design: `npm ci --ignore-scripts` must produce a working CPU
   binding without the postinstall that would download CUDA. It does — the
   sidecar loaded the model and answered.
4. **The sidecar is platform-stable.** Same category, same confidence to three
   decimals on two platforms and two architectures.

## What it does not establish

- **The GitHub Release asset URLs.** The rehearsal serves the directory from
  loopback; the real URLs are only exercised after the upload. `base_url` and
  the asset names are the same, so a wrong *name* is caught, a wrong *upload* is
  not.
- **linux/x64.** The image is `node:22.19.0-bookworm-slim`, which is arm64 on
  this machine. linux/x64 is the platform whose `onnxruntime-node` install script
  has the CUDA branch; the `--ignore-scripts` design is what makes that branch
  unreachable, and the container run shows the install works without it — but
  the x64 binary itself was not loaded.
- **The Pi host loading the extension from the tarball.** The rehearsal runs the
  installer and the sidecar, not `pi install`. That is a separate smoke test
  (checklist step 5).
- **Windows.** No machine, no runner.

## Findings from the runs (all fixed in the same change)

| Finding | Evidence |
|---|---|
| `spawnSync` for the child processes deadlocked the run: the staged release is served from the same process, so the download waited 301 s for a blocked event loop | first host run: `install the model` failed after 301,141 ms with `fetch failed` |
| `npm pack --json` output is preceded by the `prepack` build output; merging stdout and stderr made it unparseable | `Unexpected non-whitespace character after JSON at position 2427` |
| the `serve` child was spawned without `PATH` (`env` instead of `{...process.env, ...env}`), and an unhandled `error` event killed the rehearsal | `Error: spawn node ENOENT` |
| the container copied the host's `node_modules` and ran the macOS `esbuild` | `sh: 1: esbuild: Exec format error` |
| `/work` was created as root, so the entrypoint could not copy the repository | `cp: cannot create directory '/work/repo': Permission denied` |
