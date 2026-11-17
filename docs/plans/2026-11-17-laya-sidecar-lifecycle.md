# `/router laya serve|stop` — start and stop the Laya sidecar from pi

**Status:** implemented 2026-11-17 — tests red first, all gates green (277
files, 3531 passed, 3 skipped), verified in the sandbox container: serve →
status (running, /health ok, same artifact) → double start refused → stop →
status not running → stop again says nothing to stop.

**Verified against:** `main` @ `110d13a` plus the branch of PR #186
(`feat/router-laya-install`), `src/laya-model-install.ts` (`serve` subcommand,
`bundledServe` → `dist/laya-sidecar.js`), `src/laya-classifier.ts`
(`LAYA_DEFAULT_ENDPOINT` = `http://127.0.0.1:8089`, `LAYA_SPEC.defaultEndpoint`),
`src/laya-runtime-install.ts` (`verifyRuntime`, `defaultRuntimeDir`),
`index.ts:140` (`stateDir = PI_ROUTER_STATE_DIR || extDir`),
`test/router-never-touches-auth-json.test.ts` (`EXEMPT.child_process`).
`skills/router-laya-install/SKILL.md` step 8 states the rule this plan changes.

## Problem

The Laya install cannot be finished from inside pi. The wizard installs
everything, but the sidecar is a separate long-lived process on
`127.0.0.1:8089`, and nothing in the router starts it. A user has to leave pi,
find the CLI and keep a terminal open; the router then talks to a process the
user manages by hand. That also means "is my Laya working?" has no single answer
inside pi — `/router` reports the stage as unreachable without saying why.

## Solution

Two subcommands plus a status line, all in one place:

- **`/router laya serve`** — starts the sidecar detached: `node dist/laya-model-install.js serve <checkpoint> --port <n>`
  with stdout/stderr into `<state dir>/laya-sidecar.log`, the pid into
  `<state dir>/laya-sidecar.pid`. Detached on purpose: it survives `/reload` and
  a pi restart, and the next session reuses it instead of starting a second one.
  Refuses when
  - the model is not installed or does not verify,
  - the ONNX runtime does not verify (points at `/router laya install`),
  - a live process is already recorded (double-start guard, see below).
- **`/router laya stop`** — ends the recorded process (SIGTERM, SIGKILL after a
  grace period), removes the pid file. Says so when nothing runs.
- **`/router laya`** — the status gains a sidecar line: running/not, the pid, and
  — when `/health` answers — the reported `artifact_sha256` compared with the
  manifest, so a sidecar serving a different model is visible immediately.

Details that make it safe:

- **Double-start guard.** The pid file is the source of truth. A recorded pid is
  treated as live only when `process.kill(pid, 0)` succeeds *and* `/health`
  answers; a pid that is alive but not answering (unrelated process after pid
  reuse, or a crash in start-up) is reported as "recorded but not answering"
  instead of being silently replaced. A dead pid file is removed and start
  proceeds.
- **Never a shell.** `spawn(process.execPath, [cli, 'serve', checkpoint, ...])`
  with an argument array — no `shell: true`, no interpolated command line.
- **Port from the config**, not a constant: `integrations.laya.endpoint`'s port,
  default 8089, so `serve` and the router's client side cannot disagree.
- The **`child_process` exemption** in `test/router-never-touches-auth-json.test.ts`
  gets a second entry (`src/laya-sidecar-supervisor.ts`) next to
  `src/laya-runtime-install.ts`, with a test pinning what that file may do.

The skill's rule "the router never starts a sidecar" is replaced by "the router
starts it only when the user asks with `/router laya serve`". Goal: no silent
processes.

## Open decisions

- **Crash restart.** Not built: a sidecar that dies stays dead until the user (or
  a later `/router laya serve`) acts. Automatic restarts hide failures.
- **`--stop` on pi exit.** Not built: the process is meant to outlive the session.
- **Multiple checkpoints.** One recorded process at a time; starting a different
  checkpoint while one runs is refused rather than silently replacing it.

## Steps

- [x] Red tests: `test/laya-sidecar-supervisor.test.ts` + the `/router laya` cases
- [x] `src/laya-sidecar-supervisor.ts` (pid file, liveness, start, stop)
- [x] `/router laya serve|stop` wired into `src/commands.ts`, status line in `layaStatus`
- [x] Exemption entry + its pin, CHANGELOG, plan index, install plan cross-link
- [x] Gates: tsc, lint, format, full vitest, then the container probe
