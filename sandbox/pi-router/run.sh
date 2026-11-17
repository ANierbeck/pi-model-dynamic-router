#!/usr/bin/env zsh
# Start pi with the model router in its container. Zsh, no editing needed.
#
#   sandbox/pi-router/run.sh [options] [-- pi-args...]
#
# Options:
#   --dir PATH     workspace mounted at /workspace (default: current dir)
#   --no-policy    do not mount your router-config.user.json — the shipped
#                  defaults exclude nothing (Fable included). See README.
#   --fresh        delete the container's home volume first (new state)
#   --rebuild      rebuild the image even if it exists
#   --dry-run      print the docker command, run nothing
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
USER_CONFIG="$HOME/.pi/agent/router-config.user.json"
LAYA_ASSETS="${LAYA_ASSETS:-$HOME/.laya-ft/artifacts/r2-1.0.0/release}"

# Provider variables pi understands (see the pi docs, providers.md).
PROVIDER_VARS=(
  ANTHROPIC_API_KEY
  MISTRAL_API_KEY
  OPENROUTER_API_KEY
  OPENAI_API_KEY
  GEMINI_API_KEY
  ZAI_API_KEY
  GROQ_API_KEY
  DEEPSEEK_API_KEY
  CEREBRAS_API_KEY
  XAI_API_KEY
  TOGETHER_API_KEY
  FIREWORKS_API_KEY
)

usage() {
  cat <<'USAGE'
usage: run.sh [options] [-- pi-args...]

  --dir PATH     workspace mounted at /workspace (default: current dir)
  --no-policy    do not mount your router-config.user.json (defaults exclude
                 nothing, Fable included — see README)
  --fresh        delete the container's home volume first (new state)
  --rebuild      rebuild the image even if it exists
  --dry-run      print the docker command, run nothing
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
if [ "$laya_test" -eq 1 ]; then
  CONTAINER_NAME=pi-router-laya-test
fi
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

if [ "$laya_test" -eq 1 ]; then
  # The test-release variant carries a staged manifest (published: true, local
  # base URL), so it must never be confused with the normal image.
  IMAGE=pi-router:laya-test
  VOLUME=pi-router-laya-test-home
fi

docker_args=(run --rm)
if [ -t 0 ] && [ -t 1 ]; then
  docker_args+=(-it)
else
  docker_args+=(-i)
fi
docker_args+=(--name "$CONTAINER_NAME")
docker_args+=(-v "$workspace:/workspace")
if [ "$laya_test" -eq 1 ]; then
  # Writable copy on purpose: the wizard's last step writes the integrations.laya
  # block, which a read-only mount would refuse. The host file stays untouched.
  if [ "$dry_run" -eq 1 ]; then
    CONFIG_COPY="<tmp copy of router-config.user.json>"
  else
    CONFIG_COPY="$(mktemp -t router-config.user)"
    if [ -f "$USER_CONFIG" ]; then cp "$USER_CONFIG" "$CONFIG_COPY"; fi
  fi
  # Mounted at /seed, never at the target: the config store writes atomically
  # (tmp + rename), and a file that is itself a mount point cannot be replaced
  # (EBUSY). The entrypoint copies it into the state volume instead.
  docker_args+=(-v "$CONFIG_COPY:/seed/router-config.user.json:ro")
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
  echo "run.sh: policy     on, writable copy (your file is not touched)"
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

if [ "$rebuild" -eq 1 ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  if [ "$dry_run" -eq 1 ]; then
    echo "run.sh: would build $IMAGE (missing or --rebuild)"
  elif [ "$laya_test" -eq 1 ]; then
    "$HERE/build-context.sh" --laya-test
  else
    "$HERE/build-context.sh"
  fi
fi

if [ "$fresh" -eq 1 ]; then
  if [ "$dry_run" -eq 1 ]; then
    echo "run.sh: would delete volume $VOLUME"
  else
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  fi
fi

if [ "$dry_run" -eq 1 ]; then
  print -r -- "dry run: ${cmd[@]}"
  exit 0
fi

"${cmd[@]}"
