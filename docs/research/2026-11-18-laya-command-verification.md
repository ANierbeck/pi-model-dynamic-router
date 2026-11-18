# `/router laya` — what was verified, and how (2026-11-18)

Evidence for the two plans that built the command surface and the sidecar
lifecycle:

- `docs/plans/2026-11-17-router-laya-install-command.md`
- `docs/plans/2026-11-17-laya-sidecar-lifecycle.md`

The plans state the problem and the solution; the measurements live here
(AGENTS §11: a plan is not a lab notebook).

## Gates per branch

| Branch (PR) | Test files | Passed | Skipped | Notes |
| --- | --- | --- | --- | --- |
| `feat/router-laya-install` (#186) | 276 | 3506 | 3 | before the sidecar lifecycle additions |
| `feat/laya-sidecar-lifecycle` (#188) | 277 | 3531 → 3552 | 3 | grew with the review round (see below) |

Every run also passed `npx tsc --noEmit`, `npm run lint` (0 findings) and
`node scripts/format-gate.ts`.

## End-to-end run in the sandbox container

Container: `sandbox/pi-router/` image built from the packed tarball, pi 1.5.2,
`router@1.0.0` staged as published, Laya weights in a named volume.

The sequence below was the acceptance test for the lifecycle plan:

1. `/router laya` → `sidecar: not running`
2. `/router laya serve` → `Laya sidecar started (pid 50)`, log file created
3. `/router laya` → `sidecar: running (pid 50)`, `/health` answered, same
   artifact (`22f7b049…`) as the configured checkpoint
4. `/router laya serve` again → refused, names the running pid
5. `/router laya stop` → stopped; `/health` silent; pid file gone
6. `/router laya` → `sidecar: not running`
7. `/router laya stop` again → "nothing to stop"

The image was rebuilt for the review round; the staged `published: true`
manifest stayed in a separate image tag so the normal image keeps
`published: false`.

## What is NOT verified

- A real download from a published release: `router@1.0.0` is still
  `published: false`, so the wizard stops at the offer in every real run. The
  download path is exercised against a local `file://` release and a loopback
  HTTP server in `test/laya-model-install.test.ts`.
- Classification quality of the installed model: r3 failed its gates
  (`docs/research/2026-11-15-laya-r3-run.md`), r2 stays served.
- A second platform: only darwin/arm64 and linux/arm64 (container) were run.
