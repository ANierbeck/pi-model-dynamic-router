#!/bin/bash
# Host-upgrade gate (AGENTS §10): runs the two-layer router-shape checks
# against the installed Pi. Starts the fake provider itself, waits until it
# listens, bounds the runner, and exits nonzero when the run deviates from
# the recorded baseline (shape-verdict.ts) or does not finish.
#   spikes/virtual-models/run-router-shape.sh
# Output goes to $SPIKE_OUT (default: a fresh private temp directory).
# $SHAPE_TIMEOUT caps the runner (default 900 s).
set -u
here=$(cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=gate-lib.sh
source "$here/gate-lib.sh"
SPIKE_OUT=$(resolve_out_dir vm-shape) || exit 1
export SPIKE_OUT
export SPIKE_PORT=${SPIKE_PORT:-8791}
SHAPE_TIMEOUT=${SHAPE_TIMEOUT:-900}
echo "output: $SPIKE_OUT"

node "$here/fake-server.mjs" > "$SPIKE_OUT/server.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
if ! wait_for_line "$SPIKE_OUT/server.log" "fake provider on" 15; then
  echo "fake provider did not start within 15 s (see $SPIKE_OUT/server.log)" >&2
  exit 1
fi

run_bounded "$SHAPE_TIMEOUT" node "$here/router-shape-run.ts"
status=$?
if [ "$status" -eq 124 ]; then
  echo "router-shape-run.ts did not finish within ${SHAPE_TIMEOUT} s: treated as a failed check" >&2
  exit 1
fi
exit "$status"
