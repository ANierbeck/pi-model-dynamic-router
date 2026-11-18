#!/usr/bin/env zsh
# Start pi with the model router in its container. Zsh, no editing needed.
#
#   sandbox/pi-router/run.sh [options] [-- pi-args...]
#
# Options:
#   --dir PATH     workspace mounted at /workspace (default: current dir)
#   --no-policy    do not mount your router-config.user.json — the shipped
#                  defaults exclude nothing (Fable included). See README.
#   --fresh        delete the container's volumes first (new state)
#   --rebuild      rebuild the image even if it exists
#   --dry-run      print the docker command, change no Docker state
#   --laya-test    test-release variant: serve a locally staged Laya release so
#                  /router laya install can run before the release is published
#   --laya-assets PATH  the staged release directory (default: r2-1.0.0/release)
#   -h, --help     this text
#
# Examples:
#   sandbox/pi-router/run.sh                     # interactive pi in $PWD
#   sandbox/pi-router/run.sh -- -p "ping"        # one-shot prompt
#   sandbox/pi-router/run.sh --fresh             # forget sessions and state
#
# Provider keys are passed through by NAME only, and only when they are set
# in this shell. This script never reads, prints or stores a key value.
set -eu
set -o pipefail

HERE="${0:A:h}"
IMAGE=pi-router
VOLUME=pi-router-home
# Project-scoped router state (<cwd>/.pi/cache/router-state.json) would otherwise
# land in the bind-mounted workspace and survive --fresh — and leave state in the
# user's project. A named volume over /workspace/.pi keeps it in the container's
# world. Consequence: a project config at <dir>/.pi/router-config.json is not
# visible inside (see README).
PROJECT_VOLUME_SUFFIX=-workspace
USER_CONFIG="$HOME/.pi/agent/router-config.user.json"
LAYA_ASSETS="${LAYA_ASSETS:-$HOME/.laya-ft/artifacts/r2-1.0.0/release}"

# Provider variables pi understands (see the pi docs, providers.md). One shared
# list: the entrypoint reports exactly the names this loop forwards.
PROVIDER_VARS=(${(f)"$(grep -v '^#' "$HERE/provider-vars.txt" | grep -v '^[[:space:]]*$')"})

usage() {
  cat <<'USAGE'
usage: run.sh [options] [-- pi-args...]

  --dir PATH     workspace mounted at /workspace (default: current dir)
  --no-policy    do not mount your router-config.user.json (defaults exclude
                 nothing, Fable included — see README)
  --fresh        delete the container's volumes first (new state)
  --rebuild      rebuild the image even if it exists
  --dry-run      print the docker command, change no Docker state
  -h, --help     this text

Examples:
  run.sh                 interactive pi in the current directory
  run.sh -- -p "ping"    one-shot prompt
  run.sh --fresh         forget sessions and state

Provider keys are passed through by NAME only, and only when they are set
in this shell. This script never reads, prints or stores a key value.
USAGE
}

workspace="$PWD"
policy=on
fresh=0
rebuild=0
dry_run=0
laya_test=0
pi_args=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)       workspace="${2:?--dir needs a path}"; shift 2 ;;
    --no-policy) policy=off; shift ;;
    --fresh)     fresh=1; shift ;;
    --rebuild)   rebuild=1; shift ;;
    --dry-run)   dry_run=1; shift ;;
    --laya-test) laya_test=1; shift ;;
    --laya-assets) LAYA_ASSETS="${2:?--laya-assets needs a path}"; shift 2 ;;
    -h|--help)   usage; exit 0 ;;
    --)          shift; pi_args=("$@"); break ;;
    *)           echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

if [ "$policy" = on ] && [ ! -f "$USER_CONFIG" ]; then
  echo "run.sh: $USER_CONFIG not found." >&2
  echo "        Start with --no-policy only if you accept the shipped defaults" >&2
  echo "        (they exclude nothing — see the README warning)." >&2
  exit 1
fi

CONTAINER_NAME=pi-router-run
VOLUME=pi-router-home
if [ "$laya_test" -eq 1 ]; then
  # The test-release variant carries a staged manifest (published: true, local
  # base URL), so it must never be confused with the normal image.
  CONTAINER_NAME=pi-router-laya-test
  IMAGE=pi-router:laya-test
  VOLUME=pi-router-laya-test-home
fi
PROJECT_VOLUME="$VOLUME$PROJECT_VOLUME_SUFFIX"

# A directory under $HOME for the seed copy: on macOS Docker only shares some
# paths, and a /tmp or /var/folders source silently becomes an empty directory
# inside the container (see README).
seed_host=""
if [ "$laya_test" -eq 1 ] && [ "$policy" = on ]; then
  if [ "$dry_run" -eq 1 ]; then
    seed_host="<copy of router-config.user.json>"
  else
    seed_dir="$(mktemp -d "$HOME/.cache/pi-router-seed.XXXXXX")"
    trap 'rm -rf "$seed_dir"' EXIT
    cp "$USER_CONFIG" "$seed_dir/router-config.user.json"
    seed_host="$seed_dir/router-config.user.json"
  fi
fi

docker_args=(run --rm)
if [ -t 0 ] && [ -t 1 ]; then
  docker_args+=(-it)
else
  docker_args+=(-i)
fi
docker_args+=(--name "$CONTAINER_NAME")
docker_args+=(-v "$workspace:/workspace")
docker_args+=(-v "$PROJECT_VOLUME:/workspace/.pi")
if [ -n "$seed_host" ]; then
  # Mounted at /seed, never at the target: the config store writes atomically
  # (tmp + rename), and a file that is itself a mount point cannot be replaced
  # (EBUSY). The entrypoint copies it into the state volume instead.
  docker_args+=(-v "$seed_host:/seed/router-config.user.json:ro")
fi
if [ "$laya_test" -eq 1 ]; then
  docker_args+=(-v "$LAYA_ASSETS:/assets:ro")
elif [ "$policy" = on ]; then
  docker_args+=(-v "$USER_CONFIG:/home/pi/.pi/agent/router-config.user.json:ro")
fi
docker_args+=(-v "$VOLUME:/home/pi/.pi")

passed=()
for name in $PROVIDER_VARS; do
  # Name only: docker picks the value up from this shell itself.
  if v=$(printenv "$name" 2>/dev/null) && [ -n "$v" ]; then
    docker_args+=(-e "$name")
    passed+=("$name")
  fi
done

cmd=(docker "${docker_args[@]}" "$IMAGE")
if [ ${#pi_args[@]} -gt 0 ]; then
  cmd+=(pi "${pi_args[@]}")
fi

echo "run.sh: workspace  $workspace"
if [ "$policy" = on ] && [ "$laya_test" -eq 1 ]; then
  echo "run.sh: policy     on, seeded copy (your file is not touched)"
elif [ "$policy" = on ]; then
  echo "run.sh: policy     on, mounted read-only"
else
  echo "run.sh: policy     off (shipped defaults)"
fi
echo "run.sh: provider keys passed through: ${passed[*]:-none}"
if [ "$laya_test" -eq 1 ]; then
  echo "run.sh: LAYA TEST RELEASE — image $IMAGE, assets $LAYA_ASSETS served on 127.0.0.1:8899"
  echo "run.sh: the config is seeded into the volume; your own file is not touched"
fi

# --- from here on: read-only Docker queries, then the mutations -------------- #

needs_build=0
if [ "$rebuild" -eq 1 ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  needs_build=1
fi

if [ "$needs_build" -eq 1 ]; then
  if [ "$dry_run" -eq 1 ]; then
    echo "run.sh: would build $IMAGE (missing or --rebuild)"
  elif [ "$laya_test" -eq 1 ]; then
    "$HERE/build-context.sh" --laya-test
  else
    "$HERE/build-context.sh"
  fi
fi

# The image user carries the ids of the account that built it. When that is not
# the account running this, a bind-mounted workspace is not writable — say so
# instead of letting edits fail. Labels are readable without starting a container.
if [ "$dry_run" -eq 0 ] && ! [ "$needs_build" -eq 1 ]; then
  image_uid="$(docker image inspect --format '{{index .Config.Labels "pi.uid"}}' "$IMAGE" 2>/dev/null || true)"
  if [ -n "$image_uid" ] && [ "$image_uid" != "$(id -u)" ]; then
    echo "run.sh: WARNING: $IMAGE was built for uid $image_uid, you are $(id -u)." >&2
    echo "run.sh:          files in $workspace may not be writable — rerun with --rebuild." >&2
  fi
fi

# A second invocation must not kill a session that is in use. `docker rm -f`
# used to run before the dry-run exit, so a dry run stopped a live container.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER_NAME"; then
  echo "run.sh: a container named $CONTAINER_NAME is running." >&2
  echo "run.sh: stop it first (docker stop $CONTAINER_NAME), or use --dir/--laya-test for a separate run." >&2
  # A dry run only reports: it changes no Docker state, so it does not fail here.
  [ "$dry_run" -eq 1 ] || exit 1
elif [ "$dry_run" -eq 0 ] && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER_NAME"; then
  docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi

if [ "$fresh" -eq 1 ]; then
  if [ "$dry_run" -eq 1 ]; then
    echo "run.sh: would delete volumes $VOLUME and $PROJECT_VOLUME"
  else
    for v in "$VOLUME" "$PROJECT_VOLUME"; do
      # A volume another container has mounted cannot be removed; ignoring that
      # left the run on old data while claiming to be fresh.
      if ! docker volume rm "$v" >/dev/null 2>&1 && docker volume inspect "$v" >/dev/null 2>&1; then
        echo "run.sh: cannot remove volume $v — a container still has it mounted." >&2
        echo "run.sh: stop that container first, or drop --fresh." >&2
        exit 1
      fi
    done
  fi
fi

if [ "$dry_run" -eq 1 ]; then
  print -r -- "dry run: ${cmd[@]}"
  exit 0
fi

"${cmd[@]}"
