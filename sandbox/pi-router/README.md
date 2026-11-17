# Pi with the model router, in Docker

A throwaway container with pi 1.5.2 (the version the repository is developed
against) and the router as it would ship: packed with `npm pack`, installed
from the tarball, no source tree and no maintainer state inside.

Use it to try the router without touching your own `~/.pi/agent`.

## Build

```bash
sandbox/pi-router/build-context.sh          # pack the working tree, docker build -t pi-router
sandbox/pi-router/build-context.sh --pack   # pack only
```

The packed tarball lands in `sandbox/pi-router/context/` (git-ignored). Rebuild
after every router change; the image contains the packed state at build time.

## Run

```bash
sandbox/pi-router/run.sh
```

That is the whole command. It mounts the current directory as pi's workspace,
carries your router policy in read-only, and passes through only the provider
keys that are set in your shell (by name; the script never reads a value).
It builds the image on first run; `--rebuild` after a router change.

Useful flags (full list in `run.sh --help`):

```bash
run.sh -- -p "ping"      # one-shot prompt instead of the TUI
run.sh --fresh           # forget the container's sessions and router state
run.sh --dir ~/some/dir  # workspace other than the current directory
run.sh --dry-run         # print the docker command, run nothing
```

If you prefer to assemble the command yourself, this is what the script runs:

```bash
docker run -it --rm \
  -e OPENROUTER_API_KEY \
  -v "$PWD:/workspace" \
  -v ~/.pi/agent/router-config.user.json:/home/pi/.pi/agent/router-config.user.json:ro \
  -v pi-router-home:/home/pi/.pi \
  pi-router
```

- `-e OPENROUTER_API_KEY` copies the variable from your host shell. Export it
  there first; pass only the providers you want the container to reach.
- `-v "$PWD:/workspace"` is the project pi can read and write. Add `:ro` if
  pi should only read it.
- The read-only `router-config.user.json` mount carries your router policy
  into the container: 31 `exclude.models` entries (among them the Fable block,
  `open-mistral-nemo` and `devstral-2512`), the `*:free` exclusions in the
  groups that do not allow free models, and the `min_gdpval` floors. **Leave it
  out (`--no-policy`) and the container runs on the router's shipped defaults**,
  whose `exclude.models` is empty, so Fable models are candidates again once an
  Anthropic key is present. Do not leave it out when Anthropic or other paid
  keys are passed.
- `pi-router-home` is a named volume with the container's own settings,
  sessions and router state. It keeps data between runs and is separate from
  the host's `~/.pi/agent`.

Reset everything the container has written:

```bash
docker volume rm pi-router-home
```

## Test the Laya install before the release exists

`/router laya install` refuses an unpublished version on purpose, so the shipped
manifest cannot exercise it. `--laya-test` builds a separate image whose manifest
is staged the same way `scripts/release-rehearsal.ts` stages it: two fields
change (`published: true`, `base_url` on a local server), nothing about the
payload does.

```bash
sandbox/pi-router/run.sh --laya-test          # builds pi-router:laya-test on first use
```

Then, inside pi:

```text
/router laya            # status: offer, install, runtime, config, sidecar
/router laya install    # the wizard; it asks before each step
/router laya serve      # start the sidecar, detached (survives /reload)
/router laya stop       # end it
```

What the flag does:

- mounts `~/.laya-ft/artifacts/r2-1.0.0/release` at `/assets` (`--laya-assets PATH`
  for another directory) and serves it on `127.0.0.1:8899` — the staged `base_url`
- gives the wizard a **writable copy** of your `router-config.user.json`, so the
  last step can write the `integrations.laya` block without touching your file;
  the path is printed at start-up
- uses its own image tag (`pi-router:laya-test`) and its own volume
  (`pi-router-laya-test-home`), so the normal image never carries the staged
  manifest

Weights land in the volume, so a second run skips the 1.32 GB download.

Your `router-config.user.json` is **seeded** into the volume at start, not
bind-mounted at its real path: the config store writes atomically
(write-tmp-then-rename), and a file that is itself a mount point cannot be
renamed over — the write would fail with `EBUSY`. So the wizard can save its
block, your host file stays untouched, and the seeded copy is only written when
the volume has none yet (`--fresh` starts from an empty volume, weights
included).

```text
docker exec -it pi-router-laya-test bash   # a shell beside pi, if you need one
```

The sidecar belongs to the container it was started in: `/router laya serve`
starts it inside pi's container, so it lives as long as that container does.
`/router laya` reports what `/health` answers either way.
curl -s http://127.0.0.1:8089/health   # artifact_sha256 must match the manifest
```

Reset the test state with `docker volume rm pi-router-laya-test-home`.

## Smoke test without keys

```bash
docker run --rm pi-router pi --version
docker run --rm pi-router pi list    # shows /opt/router as a user package
```

Without a provider key the router loads (it writes `router-config.dynamic.json`
into the state volume) but cannot classify, because no classifier model is
reachable. That is expected; the entrypoint says so at start-up.

**Run pi through the entrypoint.** `docker run --entrypoint bash pi-router …`
skips it, so `settings.json` is never written and the router package is not
registered: the `/router` command then does not exist, which looks like a bug
in the router. Override the entrypoint only to inspect the image, not to run
pi.

A command that needs no model can still be checked without a key, through RPC
mode:

```bash
docker run --rm -i pi-router bash -c \
  'printf "%s\n" "{\"type\":\"prompt\",\"message\":\"/router laya\"}" | pi --mode rpc --no-session'
```

The reply arrives as an `extension_ui_request` with the command's output. The
same trick with a mounted policy file proves that the read-only mount is read.

## What the container can see

| Thing | Exposed? |
|---|---|
| Host `~/.pi/agent` (credentials, sessions, settings) | **no** — only the read-only user config file, and only if you mount it |
| Keys | only the variables you pass with `-e` |
| Project | only the directory you mount at `/workspace` |
| Network | unrestricted (pi must reach the providers) |
| Router code | root-owned in `/opt/router`, read-only for the `pi` user |

## Files

- `Dockerfile` — node 22.19 (the engines floor), pi pinned, router unpacked to `/opt/router`, non-root `pi` user
- `entrypoint.sh` — first-run settings (only if missing), key-presence report (names only, never values), the test asset server when `/assets` is mounted
- `build-context.sh` — packs the working tree and builds the image (`--laya-test` for the test-release variant)
- `asset-server.mjs` — serves a locally staged release for `--laya-test`; read-only, localhost only
- `run.sh` — the start script (`--laya-test`, `--dir`, `--fresh`, `--rebuild`, `--dry-run`)
